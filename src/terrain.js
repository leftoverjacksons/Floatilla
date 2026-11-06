import * as THREE from 'three';
import { fbm, smoothstep, mulberry32, rand, clamp } from './util.js';
import { patchFloodMaterial } from './shaders.js';
import { tiled, LAYER_NO_REFLECT } from './tiles.js';

// ---------------------------------------------------------------------------
// Landscape: a natural bay with a narrow mouth to the sea (south, +z), islands,
// a meandering river running through the town to the bay, and a marshy creek
// to the east. Land height grows with distance from the nearest water into a
// ring of hills, so the rising flood turns the valley into a maze of channels
// and the hills into islands.
// ---------------------------------------------------------------------------
export const WORLD_RECT = { minx: -2000, minz: -2300, size: 4000 };

export const BAY = { cx: 0, cz: 260, rx: 940, rz: 640 };
const MOUTH = { z0: 700, z1: 1250, half: 210 };
const SEA_Z = 1260;
export const ISLANDS = [
  { x: 390, z: 330, r: 105, h: 22 },
  { x: -470, z: 470, r: 70, h: 11 },
  { x: -60, z: 560, r: 38, h: 5 },
];

function makeRiver(ax, az, bx, bz, meander, waves, phase) {
  const pts = [];
  const len = Math.hypot(bx - ax, bz - az), n = Math.ceil(len / 22);
  const px = -(bz - az) / len, pz = (bx - ax) / len;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const m = meander * Math.sin(t * waves * Math.PI + phase) * (0.35 + 0.65 * t) + 25 * fbm(t * 6, phase, 2);
    pts.push({ x: ax + (bx - ax) * t + px * m, z: az + (bz - az) * t + pz * m, t });
  }
  return pts;
}
// mouth first; width/bed interpolate mouth → source
export const RIVERS = [
  { name: 'river', pts: makeRiver(-170, -300, -820, -2150, 140, 5.5, 0.6), w0: 95, w1: 30, bed0: -5, bed1: 1.0 },
  { name: 'creek', pts: makeRiver(700, -40, 1180, -1650, 85, 4.5, 2.1), w0: 60, w1: 18, bed0: -3.5, bed1: 1.5 },
];

// Spatial buckets of river segments so distance queries stay cheap.
const BUCKET = 150;
const buckets = new Map();
RIVERS.forEach((r, ri) => {
  for (let i = 0; i < r.pts.length - 1; i++) {
    const a = r.pts[i], b = r.pts[i + 1], reach = 950; // beyond the distance where rivers still shape the land
    const x0 = Math.floor((Math.min(a.x, b.x) - reach) / BUCKET), x1 = Math.floor((Math.max(a.x, b.x) + reach) / BUCKET);
    const z0 = Math.floor((Math.min(a.z, b.z) - reach) / BUCKET), z1 = Math.floor((Math.max(a.z, b.z) + reach) / BUCKET);
    for (let bx = x0; bx <= x1; bx++) for (let bz = z0; bz <= z1; bz++) {
      const k = bx * 100003 + bz; let arr = buckets.get(k); if (!arr) buckets.set(k, (arr = [])); arr.push([ri, i]);
    }
  }
});
function nearestRiver(x, z) {
  const arr = buckets.get(Math.floor(x / BUCKET) * 100003 + Math.floor(z / BUCKET));
  let best = { d: Infinity, t: 0, r: null, dir: null };
  if (!arr) return best;
  for (const [ri, i] of arr) {
    const r = RIVERS[ri], a = r.pts[i], b = r.pts[i + 1];
    const ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez;
    const u = clamp(((x - a.x) * ex + (z - a.z) * ez) / l2, 0, 1);
    const qx = a.x + ex * u, qz = a.z + ez * u, d = Math.hypot(x - qx, z - qz);
    if (d < best.d) best = { d, t: a.t + (b.t - a.t) * u, r, dir: [ex / Math.sqrt(l2), ez / Math.sqrt(l2)] };
  }
  return best;
}

/** Signed distance to open water (negative inside water) and which water body it is. */
export function waterInfo(x, z) {
  const ang = Math.atan2(z - BAY.cz, x - BAY.cx);
  const rmod = 1 + 0.14 * fbm(Math.cos(ang) * 1.6 + 5, Math.sin(ang) * 1.6, 3) + 0.05 * Math.sin(ang * 7 + 1) + 0.03 * Math.sin(ang * 13);
  const ex = (x - BAY.cx) / (BAY.rx * rmod), ez = (z - BAY.cz) / (BAY.rz * rmod);
  let best = { d: (Math.hypot(ex, ez) - 1) * Math.min(BAY.rx, BAY.rz) * rmod, kind: 'bay', t: 0, river: null };
  if (z > MOUTH.z0 - 150) {
    const hw = MOUTH.half * (1 + 1.4 * smoothstep(MOUTH.z0 + 250, MOUTH.z1 + 150, z)) + 35 * fbm(z * 0.005, 1.7, 2);
    let d = Math.abs(x - 60 * Math.sin(z * 0.0045)) - hw;
    if (z < MOUTH.z0) d = Math.max(d, MOUTH.z0 - z);
    if (d < best.d) best = { d, kind: 'channel', t: 0, river: null };
  }
  const dSea = SEA_Z + 110 * fbm(x * 0.0018, 3.3, 3) - z;
  if (dSea < best.d) best = { d: dSea, kind: 'sea', t: 0, river: null };
  const nr = nearestRiver(x, z);
  if (nr.r) {
    const w = nr.r.w0 + (nr.r.w1 - nr.r.w0) * nr.t;
    const d = nr.d - w / 2;
    if (d < best.d) best = { d, kind: 'river', t: nr.t, river: nr.r, w, dir: nr.dir };
  }
  // ragged coastline: coves, points and little headlands (gentler along the rivers)
  best.d += (best.kind === 'river' ? 9 : 34) * fbm(x * 0.0075 + 11, z * 0.0075 - 4, 3) + (best.kind === 'river' ? 0 : 10 * fbm(x * 0.03, z * 0.03, 2, 6));
  return best;
}

function hills(x, z) {
  const n = fbm(x * 0.0012 + 3.1, z * 0.0012 - 7.3, 5) * 0.5 + 0.5;
  const ridge = 1 - Math.abs(fbm(x * 0.0021 - 1.7, z * 0.0021 + 4.2, 3)); // sharp-crested ridges
  return Math.pow(n, 1.6) * 110 + Math.pow(ridge, 3) * 45 + fbm(x * 0.006, z * 0.006, 2, 5) * 7;
}

function rawHeight(x, z) {
  const w = waterInfo(x, z);
  let h;
  if (w.d >= 0) {
    const d = w.d;
    h = 1.0 + 6 * (1 - Math.exp(-d / 80)) + 0.012 * d + hills(x, z) * smoothstep(70, 650, d)
      + 7 * fbm(x * 0.0045 - 2, z * 0.0045 + 9, 3) * smoothstep(8, 120, d); // bluffs and swales near the shore
    if (w.kind === 'river' && w.river.name === 'creek') h -= 3 * Math.exp(-d / 60); // marshy creek flats
  } else {
    const d = -w.d;
    let bed;
    if (w.kind === 'river') bed = (w.river.bed0 + (w.river.bed1 - w.river.bed0) * w.t) - 2.5 * smoothstep(0, w.w * 0.5, d);
    else if (w.kind === 'channel') bed = -7 - 9 * smoothstep(0, 160, d);
    else if (w.kind === 'sea') bed = -12 - Math.min(30, d * 0.03);
    else bed = -2.5 - 17 * smoothstep(0, 420, d);
    h = bed + (1.0 - bed) * Math.exp(-d / 14);
  }
  for (const is of ISLANDS) {
    const r = Math.hypot(x - is.x, z - is.z) / (is.r * (1 + 0.18 * fbm(x * 0.02, z * 0.02, 2, 3)));
    if (r < 1.6) h = Math.max(h, is.h * Math.pow(Math.max(0, 1 - r * r / 1.6), 1.3) + (r < 1 ? 1.5 : -4 * (r - 1)));
  }
  // the world rim: mountains everywhere except the sea to the south
  const rim = (Math.hypot(x / 1650, (z + 350) / 1900) - 1 + 0.08 * fbm(x * 0.002, z * 0.002, 2, 8)) * 1700;
  h += smoothstep(0, 400, rim) * 80 * smoothstep(1500, 900, z);
  return Math.max(h, -40);
}

// Height field cached on a 4 m grid: every later groundHeight() is a bilinear lookup.
const HF_N = 1024, HF = new Float32Array(HF_N * HF_N);
{
  const s = WORLD_RECT.size / HF_N;
  for (let j = 0; j < HF_N; j++) {
    const z = WORLD_RECT.minz + (j + 0.5) * s;
    for (let i = 0; i < HF_N; i++) HF[j * HF_N + i] = rawHeight(WORLD_RECT.minx + (i + 0.5) * s, z);
  }
}
export function groundHeight(x, z) {
  let fx = (x - WORLD_RECT.minx) / WORLD_RECT.size * HF_N - 0.5, fz = (z - WORLD_RECT.minz) / WORLD_RECT.size * HF_N - 0.5;
  fx = Math.min(Math.max(fx, 0), HF_N - 1.001); fz = Math.min(Math.max(fz, 0), HF_N - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
  const a = HF[j * HF_N + i], b = HF[j * HF_N + i + 1], c = HF[(j + 1) * HF_N + i], d = HF[(j + 1) * HF_N + i + 1];
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}
export function groundSlope(x, z, e = 4) {
  return Math.hypot(groundHeight(x + e, z) - groundHeight(x - e, z), groundHeight(x, z + e) - groundHeight(x, z - e)) / (2 * e);
}

// Town zones (used by the city generator and terrain colouring).
export const DOWNTOWN = { x: 120, z: -470, r: 300 };
export function inCity(x, z) {
  if (x < -1350 || x > 1350 || z < -1500 || z > 330) return false;
  const w = waterInfo(x, z);
  return w.d > 8 && w.d < 650;
}

/**
 * Find a spot near (cx, cz) whose ground height lies in [h0, h1] (optionally on land / in water),
 * scanning outward on a 10 m grid. Used to site landmarks and the start on any terrain.
 */
export function findSpot(cx, cz, h0, h1, maxR = 500, pred) {
  for (let r = 0; r <= maxR; r += 10) {
    const n = Math.max(1, Math.round(2 * Math.PI * r / 10));
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2, x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      const h = groundHeight(x, z);
      if (h >= h0 && h <= h1 && (!pred || pred(x, z, h))) return { x, z, h };
    }
  }
  return { x: cx, z: cz, h: groundHeight(cx, cz) };
}

/**
 * Heightfield of the "floor" under the water: terrain plus building tops.
 * The same array drives the water shader (as a texture) and CPU queries.
 */
export class FloorMap {
  constructor(N = 1024) {
    this.N = N;
    this.rect = WORLD_RECT;
    this.ground = new Float32Array(N * N);
    this.floor = new Float32Array(N * N);
    const s = this.rect.size / N;
    for (let j = 0; j < N; j++) {
      const z = this.rect.minz + (j + 0.5) * s;
      for (let i = 0; i < N; i++) {
        const h = groundHeight(this.rect.minx + (i + 0.5) * s, z);
        this.ground[j * N + i] = h; this.floor[j * N + i] = h;
      }
    }
  }
  stampBox(minx, maxx, minz, maxz, top) {
    const { N, rect } = this; const s = rect.size / N;
    const i0 = Math.max(0, Math.ceil((minx - rect.minx) / s - 0.5));
    const i1 = Math.min(N - 1, Math.floor((maxx - rect.minx) / s - 0.5));
    const j0 = Math.max(0, Math.ceil((minz - rect.minz) / s - 0.5));
    const j1 = Math.min(N - 1, Math.floor((maxz - rect.minz) / s - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * N + i; if (this.floor[k] < top) this.floor[k] = top;
    }
  }
  /** Rotated rectangle (centre, half extents, cos/sin of yaw). */
  stampOBB(c) {
    const { N, rect } = this; const s = rect.size / N;
    const i0 = Math.max(0, Math.ceil((c.minx - rect.minx) / s - 0.5)), i1 = Math.min(N - 1, Math.floor((c.maxx - rect.minx) / s - 0.5));
    const j0 = Math.max(0, Math.ceil((c.minz - rect.minz) / s - 0.5)), j1 = Math.min(N - 1, Math.floor((c.maxz - rect.minz) / s - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = rect.minx + (i + 0.5) * s - c.cx, z = rect.minz + (j + 0.5) * s - c.cz;
      const lx = x * c.cos - z * c.sin, lz = x * c.sin + z * c.cos; // world → box-local (inverse of Ry)
      if (Math.abs(lx) > c.hx || Math.abs(lz) > c.hz) continue;
      const k = j * N + i; if (this.floor[k] < c.top) this.floor[k] = c.top;
    }
  }
  sample(arr, x, z) {
    const { N, rect } = this;
    let fx = (x - rect.minx) / rect.size * N - 0.5;
    let fz = (z - rect.minz) / rect.size * N - 0.5;
    fx = Math.min(Math.max(fx, 0), N - 1.001); fz = Math.min(Math.max(fz, 0), N - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz); const u = fx - i, v = fz - j;
    const a = arr[j * N + i], b = arr[j * N + i + 1], c = arr[(j + 1) * N + i], d = arr[(j + 1) * N + i + 1];
    return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
  }
  groundAt(x, z) { return this.sample(this.ground, x, z); }
  floorAt(x, z) { return this.sample(this.floor, x, z); }
  makeTexture() {
    const { N } = this; const data = new Uint16Array(N * N);
    for (let k = 0; k < N * N; k++) data[k] = THREE.DataUtils.toHalfFloat(this.floor[k]);
    const tex = new THREE.DataTexture(data, N, N, THREE.RedFormat, THREE.HalfFloatType);
    tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    return tex;
  }
}

export function buildTerrain(scene, uniforms, city) {
  // 6x6 tiles of 48 segments (~14 m spacing), culled per tile; normals from the height field.
  const TILES = 6, seg = 48, tileSize = WORLD_RECT.size / TILES;
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  patchFloodMaterial(mat, uniforms, false);
  const c = new THREE.Color();
  const sand = new THREE.Color(0.66, 0.6, 0.45), mud = new THREE.Color(0.32, 0.29, 0.21), marsh = new THREE.Color(0.33, 0.38, 0.2),
    grass = new THREE.Color(0.25, 0.38, 0.17), dry = new THREE.Color(0.42, 0.42, 0.25), forest = new THREE.Color(0.15, 0.25, 0.12),
    rock = new THREE.Color(0.4, 0.38, 0.35), seabed = new THREE.Color(0.3, 0.29, 0.23), paved = new THREE.Color(0.33, 0.32, 0.31);
  const group = new THREE.Group();
  for (let ti = 0; ti < TILES; ti++) for (let tj = 0; tj < TILES; tj++) {
    const geo = new THREE.PlaneGeometry(tileSize, tileSize, seg, seg);
    geo.rotateX(-Math.PI / 2);
    geo.translate(WORLD_RECT.minx + (ti + 0.5) * tileSize, 0, WORLD_RECT.minz + (tj + 0.5) * tileSize);
    const pos = geo.attributes.position, nrm = geo.attributes.normal;
    const colors = new Float32Array(pos.count * 3);
    for (let k = 0; k < pos.count; k++) {
      const x = pos.getX(k), z = pos.getZ(k), h = groundHeight(x, z);
      pos.setY(k, h);
      const e = 4, gx = groundHeight(x + e, z) - groundHeight(x - e, z), gz = groundHeight(x, z + e) - groundHeight(x, z - e);
      const nl = Math.hypot(gx, 2 * e, gz); nrm.setXYZ(k, -gx / nl, 2 * e / nl, -gz / nl);
      const slope = Math.hypot(gx, gz) / (2 * e);
      const n = fbm(x * 0.015, z * 0.015, 2, 9) * 0.5 + 0.5;
      if (h < -2) c.copy(seabed);
      else if (h < 1.5) c.copy(mud).lerp(sand, n);
      else if (h < 3.5) c.copy(sand).lerp(marsh, 0.5 + n * 0.5);
      else if (slope > 0.55) c.copy(rock);
      else if (inCity(x, z) && h < 40) c.copy(paved).lerp(grass, 0.25 + 0.35 * n);
      else if (h > 45) c.copy(forest).lerp(rock, smoothstep(80, 140, h) + 0.2 * n);
      else c.copy(grass).lerp(dry, n * 0.6).lerp(forest, smoothstep(15, 45, h) * 0.6);
      colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeBoundingSphere();
    const tile = new THREE.Mesh(geo, mat);
    tile.receiveShadow = true;
    group.add(tile);
  }
  scene.add(group);

  // Trees: river banks, hillsides and island slopes, thinning into the town.
  const rng = mulberry32(77);
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 5); trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.ConeGeometry(1, 1, 7); crownGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  patchFloodMaterial(trunkMat, uniforms, false);
  patchFloodMaterial(crownMat, uniforms, false);
  const trees = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const col = new THREE.Color();
  let tries = 0;
  while (trees.length < 5200 && tries < 60000) {
    tries++;
    const x = rand(rng, -1950, 1950), z = rand(rng, -2250, 1200);
    const h = groundHeight(x, z);
    if (h < 2.5 || h > 150 || groundSlope(x, z) > 0.7) continue;
    if (inCity(x, z) && rng() > 0.18) continue;
    // clumps: density follows a low-frequency noise
    if (fbm(x * 0.004, z * 0.004, 2, 21) < -0.1 && rng() > 0.25) continue;
    if (city && city.pointInBuilding(x, z, 3)) continue;
    trees.push({ x, z, h, ht: rand(rng, 6, 13), w: rand(rng, 1.8, 3.2), hsl: [rand(rng, 0.22, 0.33), rand(rng, 0.3, 0.55), rand(rng, 0.13, 0.25)] });
  }
  const addTiles = (grp) => { grp.children.forEach((o) => { o.layers.set(LAYER_NO_REFLECT); o.castShadow = true; }); scene.add(grp); };
  addTiles(tiled(trees, (t) => [t.x, t.z], (list) => {
    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, list.length);
    list.forEach((t, i) => { p.set(t.x, t.h - 0.3, t.z); s.set(1, t.ht * 0.4, 1); m.compose(p, q, s); trunks.setMatrixAt(i, m); });
    return trunks;
  }));
  addTiles(tiled(trees, (t) => [t.x, t.z], (list) => {
    const crowns = new THREE.InstancedMesh(crownGeo, crownMat, list.length);
    list.forEach((t, i) => {
      p.set(t.x, t.h + t.ht * 0.25, t.z); s.set(t.w, t.ht * 0.85, t.w); m.compose(p, q, s); crowns.setMatrixAt(i, m);
      crowns.setColorAt(i, col.setHSL(...t.hsl));
    });
    return crowns;
  }));
  return group;
}
