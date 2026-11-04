import * as THREE from 'three';
import { fbm, smoothstep, mulberry32, rand } from './util.js';
import { patchFloodMaterial } from './shaders.js';

// World layout: ocean to the south (+z), harbor shoreline near z = 0,
// city rising inland to the north (-z), ridges on the east/west/north rim.
export const WORLD_RECT = { minx: -2000, minz: -2300, size: 4000 };

export function groundHeight(x, z) {
  let h = z > 0 ? -z * 0.06 : -z * 0.022;
  const inland = smoothstep(-80, -420, z);
  h += fbm(x * 0.0016 + 3.1, z * 0.0016 - 7.3, 4) * 11 * inland;
  h += fbm(x * 0.012, z * 0.012, 2, 5) * 0.8;
  h += smoothstep(-1150, -1700, z) * 45;
  const side = Math.abs(x);
  const bayMask = smoothstep(700, 250, z);
  h += (smoothstep(950, 1450, side) * 28 + Math.max(0, side - 1450) * 0.12) * bayMask;
  return Math.max(h, -28);
}

/** Inside the zoned city grid? */
export function inCity(x, z) { return Math.abs(x) < 1000 && z < -50 && z > -1150; }

/**
 * Heightfield of the "floor" under the water: terrain plus building tops.
 * The same array drives the water shader (as a texture) and CPU queries, so
 * wave damping and shallow-water foam agree between rendering and physics.
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
        const x = this.rect.minx + (i + 0.5) * s;
        const h = groundHeight(x, z);
        this.ground[j * N + i] = h;
        this.floor[j * N + i] = h;
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
  /** Bilinear sample with texel-centre convention identical to GPU linear filtering. */
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
  const seg = 320;
  const geo = new THREE.PlaneGeometry(WORLD_RECT.size, WORLD_RECT.size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  geo.translate(WORLD_RECT.minx + WORLD_RECT.size / 2, 0, WORLD_RECT.minz + WORLD_RECT.size / 2);
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const sand = new THREE.Color(0.72, 0.66, 0.48), grass = new THREE.Color(0.27, 0.42, 0.18),
    dry = new THREE.Color(0.45, 0.45, 0.26), rock = new THREE.Color(0.42, 0.4, 0.37),
    seabed = new THREE.Color(0.36, 0.34, 0.27), paved = new THREE.Color(0.3, 0.3, 0.31);
  for (let k = 0; k < pos.count; k++) {
    const x = pos.getX(k), z = pos.getZ(k);
    const h = groundHeight(x, z);
    pos.setY(k, h);
    const n = fbm(x * 0.02, z * 0.02, 2, 9) * 0.5 + 0.5;
    if (h < -1.5) c.copy(seabed);
    else if (h < 1.8) c.copy(sand);
    else if (inCity(x, z)) c.copy(paved).lerp(grass, 0.15 * n);
    else if (h > 70) c.copy(rock);
    else c.copy(grass).lerp(dry, n * 0.7);
    colors[k * 3] = c.r; colors[k * 3 + 1] = c.g; colors[k * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  patchFloodMaterial(mat, uniforms, false);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  scene.add(mesh);

  // Trees: instanced trunks + canopies on land outside building footprints.
  const rng = mulberry32(77);
  const count = 3200;
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.28, 1, 5); trunkGeo.translate(0, 0.5, 0);
  const crownGeo = new THREE.ConeGeometry(1, 1, 7); crownGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
  const crownMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  patchFloodMaterial(trunkMat, uniforms, false);
  patchFloodMaterial(crownMat, uniforms, false);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, count);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, count);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  let placed = 0, tries = 0;
  const col = new THREE.Color();
  while (placed < count && tries < count * 8) {
    tries++;
    const x = rand(rng, -1900, 1900), z = rand(rng, -2000, 300);
    const h = groundHeight(x, z);
    if (h < 1.5 || h > 95) continue;
    if (inCity(x, z) && rng() > 0.12) continue;
    if (city && city.pointInBuilding(x, z, 3)) continue;
    const ht = rand(rng, 5, 11);
    p.set(x, h - 0.3, z); s.set(1, ht * 0.4, 1); m.compose(p, q, s);
    trunks.setMatrixAt(placed, m);
    p.set(x, h + ht * 0.25, z); s.set(rand(rng, 1.6, 2.8), ht * 0.85, 0); s.z = s.x; m.compose(p, q, s);
    crowns.setMatrixAt(placed, m);
    col.setHSL(rand(rng, 0.24, 0.33), rand(rng, 0.35, 0.55), rand(rng, 0.16, 0.28));
    crowns.setColorAt(placed, col);
    placed++;
  }
  trunks.count = crowns.count = placed;
  trunks.castShadow = crowns.castShadow = true;
  scene.add(trunks, crowns);
  return mesh;
}
