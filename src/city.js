import * as THREE from 'three';
import { mulberry32, rand, pick, randInt, clamp, fbm } from './util.js';
import { groundHeight, groundSlope, waterInfo, RIVERS, DOWNTOWN, findSpot } from './terrain.js';
import { patchFloodMaterial } from './shaders.js';
import { tiled, LAYER_NO_REFLECT } from './tiles.js';
import { KIT, KIT_OK, placeKit, updateKitLOD } from './townkit.js';

// Waterfront heights: the town starts nearly dry, so decks sit ~2 m above the opening water level.
export const PIER_TOP = 2.2, QUAY_TOP = 2.0;

const TOWER_COLORS = [0x8a96a3, 0x6f7f8f, 0xa9a59a, 0x5d6b78, 0xb8b2a6, 0x7b8a86, 0x9aa7b4, 0x4f5d6a, 0xc2b8a3];
const MID_COLORS = [0x9c5a43, 0xb07b5c, 0xc9b79b, 0x8c6e5a, 0xa39283, 0x7d6656, 0xbfa98a, 0x6e7a73, 0xd8c8a8];
const HOUSE_COLORS = [0xd9c9a8, 0xc5d1d9, 0xe0b9a3, 0xb7c9a8, 0xe8dcc0, 0xa8b8c9, 0xd6a8a0, 0xf0e6d2, 0x9fb3a0, 0xc9a27a];
const ROOF_COLORS = [0x5a3a32, 0x3f4247, 0x6b4a3a, 0x4a4f58, 0x7a5040, 0x8a4a32];
const WARE_COLORS = [0x8f8f86, 0x7a8288, 0x9a8a72, 0x6f7d73, 0x8a6a58];
const CONTAINER_COLORS = [0xb33a2e, 0x2e5fa3, 0x2f8a52, 0xd19a2a, 0x6b6f75, 0xa34f2e, 0x2a7f8a];
const INDUSTRY = { x: 640, z: -170, r: 260 };

/**
 * A town grown along the coast and rivers. Every solid thing a boat can hit is a
 * (possibly rotated) box collider { cx, cz, hx, hz, cos, sin, top, bottom? } with
 * its axis-aligned bounds in minx..maxz, stored in a uniform spatial hash.
 * Colliders with `bottom` (bridge decks) only block while the water is within 3 m of their underside.
 */
export class City {
  constructor(scene, uniforms, floorMap, reserved = [], seed = 1234) {
    this.reserved = reserved;
    this.colliders = [];
    this.grid = new Map();
    this.cell = 40;
    this.mark = [];
    this.qid = 0;
    this.currentLevel = 4;
    this.walls = []; this.plain = []; this.roofs = []; this.cars = [];
    this.kit = {};         // asset → instances (town kit models)
    this.waterfront = [];  // edges where waves can break over a deck: { x, z, nx, nz, len, top }
    this.occ = new Map(); // occupancy circles for placement
    const rng = mulberry32(seed);

    this.generateLighthouse();
    this.generatePiers(rng);
    this.generateBridges(rng);
    this.generateIndustry(rng);
    this.generateDowntown(rng);
    this.generateQuays(rng);
    this.generateTown(rng);

    for (const c of this.colliders) if (c.bottom === undefined) floorMap.stampOBB(c);
    this.mark = new Int32Array(this.colliders.length);
    this.buildMeshes(scene, uniforms);
  }

  // ---- primitives -----------------------------------------------------------
  /** Rotated box for rendering: centre, half extents, yaw, vertical span. */
  obox(list, cx, cz, hx, hz, ang, y0, y1, color, style = 0) {
    list.push({ cx, cz, hx, hz, ang, y0, y1, color, style });
  }
  addOBB(cx, cz, hx, hz, ang, top, kind, roof, bottom) {
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const ex = Math.abs(cos) * hx + Math.abs(sin) * hz, ez = Math.abs(sin) * hx + Math.abs(cos) * hz;
    const c = { cx, cz, hx, hz, cos, sin, minx: cx - ex, maxx: cx + ex, minz: cz - ez, maxz: cz + ez, top, bottom, kind, used: false, id: this.colliders.length };
    // roof: an axis-aligned rect inscribed in the footprint (for spawning people and reach tests)
    const ir = Math.min(hx, hz) * (Math.abs(cos * sin) > 0.3 ? 0.68 : 0.9);
    c.roof = roof || { minx: cx - ir, maxx: cx + ir, minz: cz - ir, maxz: cz + ir, top };
    this.colliders.push(c);
    const s = this.cell;
    for (let gx = Math.floor(c.minx / s); gx <= Math.floor(c.maxx / s); gx++)
      for (let gz = Math.floor(c.minz / s); gz <= Math.floor(c.maxz / s); gz++) {
        const key = (gx + 5000) * 10000 + (gz + 5000);
        let arr = this.grid.get(key); if (!arr) this.grid.set(key, (arr = []));
        arr.push(c.id);
      }
    return c;
  }
  /** Axis-aligned collider (kept for landmarks and older callers). */
  addCollider(minx, maxx, minz, maxz, top, kind, roof) {
    return this.addOBB((minx + maxx) / 2, (minz + maxz) / 2, (maxx - minx) / 2, (maxz - minz) / 2, 0, top, kind, roof);
  }
  /** World → box-local. Boxes are rotated with three.js Ry: local (x, z) → world (x·cos + z·sin, −x·sin + z·cos). */
  local(c, x, z) {
    const dx = x - c.cx, dz = z - c.cz;
    return [dx * c.cos - dz * c.sin, dx * c.sin + dz * c.cos];
  }
  /** Bridge decks stop counting once the water is well below their underside. */
  active(c) { return c.bottom === undefined || c.bottom < this.currentLevel + 3; }
  minGroundOBB(cx, cz, hx, hz, ang) {
    const c = Math.cos(ang), s = Math.sin(ang);
    let g = groundHeight(cx, cz);
    for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) g = Math.min(g, groundHeight(cx + (a * hx) * c + (b * hz) * s, cz - (a * hx) * s + (b * hz) * c));
    return g;
  }
  reservedHit(x, z, r) {
    return this.reserved.some((q) => x + r > q.minx && x - r < q.maxx && z + r > q.minz && z - r < q.maxz);
  }
  /** Placement occupancy: reject if any placed footprint is within its radius + gap. */
  free(x, z, r, gap) {
    const s = 60;
    for (let gx = Math.floor((x - r - 80) / s); gx <= Math.floor((x + r + 80) / s); gx++)
      for (let gz = Math.floor((z - r - 80) / s); gz <= Math.floor((z + r + 80) / s); gz++) {
        const a = this.occ.get(gx * 100003 + gz); if (!a) continue;
        for (const o of a) if (Math.hypot(o.x - x, o.z - z) < o.r + r + gap) return false;
      }
    return true;
  }
  occupy(x, z, r) {
    const k = Math.floor(x / 60) * 100003 + Math.floor(z / 60);
    let a = this.occ.get(k); if (!a) this.occ.set(k, (a = [])); a.push({ x, z, r });
  }
  /** Direction pointing away from the water (unit [x, z]), from the water-distance gradient. */
  awayFromWater(x, z) {
    const e = 6, gx = waterInfo(x + e, z).d - waterInfo(x - e, z).d, gz = waterInfo(x, z + e).d - waterInfo(x, z - e).d;
    const l = Math.hypot(gx, gz) || 1;
    return [gx / l, gz / l];
  }

  // ---- buildings ----------------------------------------------------------------
  kitItem(asset, it) { (this.kit[asset] || (this.kit[asset] = [])).push(it); }

  /** A building from the town kit, scaled to the footprint; its height is the wall height. */
  kitBuilding(x, z, hx, hz, ang, h, asset, wall, roof, kind) {
    const info = KIT[asset].info;
    const base = this.minGroundOBB(x, z, hx, hz, ang);
    const sy = h / info.h, top = base + h, peak = top + info.roof * sy;
    this.kitItem(asset, { x, y: base, z, ang, sx: (2 * hx) / info.w, sy, sz: (2 * hz) / info.d, wall, roof });
    const c = this.addOBB(x, z, hx, hz, ang, peak, kind);
    const pitched = info.roof > 1.2;
    const ir = Math.min(hx, hz) * (pitched ? 0.35 : (Math.abs(Math.cos(ang) * Math.sin(ang)) > 0.3 ? 0.6 : 0.85));
    c.roof = { minx: x - ir, maxx: x + ir, minz: z - ir, maxz: z + ir, top: pitched ? top + info.roof * sy * 0.7 : top + 0.05 };
    c.base = base;
    return c;
  }

  building(rng, x, z, hx, hz, ang, h, color, style, kind, opts = {}) {
    if (KIT_OK && opts.asset) return this.kitBuilding(x, z, hx, hz, ang, h, opts.asset, color, opts.roofColor ?? pick(rng, ROOF_COLORS), kind);
    const g = this.minGroundOBB(x, z, hx, hz, ang) - 1.2;
    const top = g + 1.2 + h;
    let roof = null;
    if (opts.tier && h > 28) {
      const h1 = g + 1.2 + h * rand(rng, 0.35, 0.65), k = rand(rng, 0.62, 0.8);
      this.obox(this.walls, x, z, hx, hz, ang, g, h1, color, style);
      this.obox(this.walls, x, z, hx * k, hz * k, ang, h1, top, color, style);
      const ir = Math.min(hx, hz) * k * 0.65;
      roof = { minx: x - ir, maxx: x + ir, minz: z - ir, maxz: z + ir, top };
    } else this.obox(this.walls, x, z, hx, hz, ang, g, top, color, style);
    if (opts.pitched) {
      const rh = rand(rng, 2, 3.4);
      this.roofs.push({ x, z, y: top, w: hx * 2 + 1, d: hz * 2 + 1, h: rh, ang, color: pick(rng, ROOF_COLORS) });
      const c = this.addOBB(x, z, hx, hz, ang, top + rh, kind);
      const ir = Math.min(hx, hz) * 0.35;
      c.roof = { minx: x - ir, maxx: x + ir, minz: z - ir, maxz: z + ir, top: top + rh * 0.7 };
      c.base = g + 1.2;
      return c;
    }
    if (opts.clutter) {
      const cs = Math.cos(ang), sn = Math.sin(ang);
      for (let i = 0; i < randInt(rng, 0, 3); i++) {
        const lx = rand(rng, -hx * 0.6, hx * 0.6), lz = rand(rng, -hz * 0.6, hz * 0.6);
        this.obox(this.plain, x + lx * cs + lz * sn, z - lx * sn + lz * cs, 1.1, 0.8, ang, top, top + 1.4, 0x9a9a98);
      }
      if (h > 70 && rng() < 0.35) this.obox(this.plain, x, z, 0.6, 0.6, 0, top, top + rand(rng, 8, 20), 0xbbbbbb);
    }
    const c = this.addOBB(x, z, hx, hz, ang, top, kind, roof);
    c.base = g + 1.2;
    return c;
  }

  townArea(x, z) { return x > -1400 && x < 1400 && z > -1500 && z < 300; }

  generateDowntown(rng) {
    const r0 = RIVERS[0].pts[0], r1 = RIVERS[0].pts[8];
    const axis = Math.atan2(r1.x - r0.x, r1.z - r0.z); // blocks line up with the river
    let placed = 0;
    for (let i = 0; i < 2500 && placed < 70; i++) {
      const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * DOWNTOWN.r;
      const x = DOWNTOWN.x + Math.cos(a) * rr, z = DOWNTOWN.z + Math.sin(a) * rr;
      const w = waterInfo(x, z);
      if (w.d < 25 || groundSlope(x, z) > 0.18 || this.reservedHit(x, z, 30)) continue;
      const hx = rand(rng, 9, 19), hz = rand(rng, 9, 19), r = Math.hypot(hx, hz);
      if (!this.free(x, z, r * 0.75, 11)) continue;
      const k = 1 - rr / DOWNTOWN.r;
      const h = 22 + Math.pow(rng(), 1.5) * 140 * (0.3 + 0.7 * k);
      this.building(rng, x, z, hx, hz, axis + rand(rng, -0.05, 0.05), h, pick(rng, TOWER_COLORS), 1, h > 30 ? 'tower' : 'building', { tier: rng() < 0.45, clutter: true });
      this.occupy(x, z, r * 0.75); placed++;
    }
  }

  generateIndustry(rng) {
    // cranes on the shoreline nearest the creek mouth, warehouses behind
    let cranes = 0;
    for (let i = 0; i < 400 && cranes < 3; i++) {
      const a = rng() * Math.PI * 2, rr = rng() * INDUSTRY.r;
      const x = INDUSTRY.x + Math.cos(a) * rr, z = INDUSTRY.z + Math.sin(a) * rr;
      const w = waterInfo(x, z);
      if (w.d < 4 || w.d > 14 || !this.free(x, z, 12, 30)) continue;
      const [ax, az] = this.awayFromWater(x, z);
      this.crane(x, z, Math.atan2(ax, az));
      this.occupy(x, z, 12); cranes++;
    }
    let n = 0;
    for (let i = 0; i < 3000 && n < 40; i++) {
      const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * INDUSTRY.r;
      const x = INDUSTRY.x + Math.cos(a) * rr, z = INDUSTRY.z + Math.sin(a) * rr;
      const w = waterInfo(x, z);
      if (w.d < 14 || w.d > 260 || groundSlope(x, z) > 0.15 || this.reservedHit(x, z, 25)) continue;
      const [ax, az] = this.awayFromWater(x, z);
      const ang = Math.atan2(ax, az);
      if (rng() < 0.3) { // container stacks
        const stack = randInt(rng, 1, 3);
        if (!this.free(x, z, 8, 4)) continue;
        const g = this.minGroundOBB(x, z, 1.3, 6.2, ang);
        for (let s = 0; s < stack; s++) {
          if (KIT_OK) this.kitItem('container', { x, y: g + s * 2.6, z, ang: ang + (rng() < 0.5 ? 0 : Math.PI), sx: 2.5 / 2.44, sy: 1, sz: 12.2 / 12.19, wall: pick(rng, CONTAINER_COLORS) });
          else this.obox(this.plain, x, z, 1.25, 6.1, ang, g + s * 2.6, g + (s + 1) * 2.6, pick(rng, CONTAINER_COLORS));
        }
        this.addOBB(x, z, 1.25, 6.1, ang, g + stack * 2.6, 'containers');
        this.occupy(x, z, 7); n++;
        continue;
      }
      const hx = rand(rng, 10, 22), hz = rand(rng, 8, 15), r = Math.hypot(hx, hz);
      if (!this.free(x, z, r * 0.8, 8)) continue;
      const wh = rand(rng, 7, 14);
      this.building(rng, x, z, hx, hz, ang, wh, pick(rng, WARE_COLORS), 3, 'warehouse', { asset: wh > 10.5 ? 'warehouse_brick' : 'warehouse_gable', roofColor: pick(rng, [0x6a6e70, 0x7a5a48, 0x5d6a72]) });
      this.occupy(x, z, r * 0.8); n++;
    }
  }

  /** Roads: along both river/creek banks, around the bay shore, and up the hills from downtown. */
  generateRoads(rng) {
    this.roads = [];
    const push = (pts) => { if (pts.length >= 4) this.roads.push(pts); };
    const ok = (x, z) => { const w = waterInfo(x, z); return w.d > 12 && w.d < 700 && groundSlope(x, z) < 0.3 && !this.reservedHit(x, z, 6); };
    // riverbank roads
    RIVERS.forEach((r, ri) => {
      for (const side of [-1, 1]) {
        let seg = [];
        for (let i = 0; i < r.pts.length - 1; i++) {
          const a = r.pts[i]; if (a.t > (ri === 0 ? 0.6 : 0.5)) break;
          const b = r.pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
          const w = r.w0 + (r.w1 - r.w0) * a.t, off = w / 2 + 30;
          const x = a.x - dz / l * off * side, z = a.z + dx / l * off * side;
          if (ok(x, z)) seg.push({ x, z }); else { push(seg); seg = []; }
        }
        push(seg);
      }
    });
    // coast road around the bay's landward side
    {
      let seg = [], prev = null;
      for (let th = Math.PI * 0.93; th <= Math.PI * 2.07; th += 0.012) {
        let pt = null;
        for (let rr = 250; rr < 1500; rr += 6) {
          const x = Math.cos(th) * rr * 1.25, z = 260 + Math.sin(th) * rr;
          if (waterInfo(x, z).d >= 32) { pt = { x, z }; break; }
        }
        if (!pt || pt.z > 280 || !ok(pt.x, pt.z) || (prev && Math.hypot(pt.x - prev.x, pt.z - prev.z) > 45)) { push(seg); seg = []; prev = null; if (pt && pt.z <= 280 && ok(pt.x, pt.z)) { seg.push(pt); prev = pt; } continue; }
        seg.push(pt); prev = pt;
      }
      push(seg);
    }
    // lanes climbing inland from the shore and river roads: neighbourhoods
    for (const base of this.roads.slice()) {
      for (let i = 4; i < base.length - 4; i += 7 + Math.floor(rng() * 5)) {
        let { x, z } = base[i];
        const seg = [{ x, z }], len = rand(rng, 120, 280);
        for (let d = 20; d < len; d += 20) {
          const [ax, az] = this.awayFromWater(x, z);
          const wig = rand(rng, -0.25, 0.25);
          x += (ax * Math.cos(wig) - az * Math.sin(wig)) * 20; z += (az * Math.cos(wig) + ax * Math.sin(wig)) * 20;
          if (!ok(x, z)) break;
          seg.push({ x, z });
        }
        push(seg);
      }
    }
    // hill roads out of downtown
    for (const a of [-2.4, -1.9, -1.2, -0.7]) {
      const seg = [];
      for (let d = DOWNTOWN.r * 0.8; d < 950; d += 20) {
        const wig = 40 * Math.sin(d * 0.012 + a * 3);
        const x = DOWNTOWN.x + Math.cos(a) * d - Math.sin(a) * wig, z = DOWNTOWN.z + Math.sin(a) * d + Math.cos(a) * wig;
        if (!ok(x, z)) break;
        seg.push({ x, z });
      }
      push(seg);
    }
  }

  generateTown(rng) {
    this.generateRoads(rng);
    // houses and shops face the road on both sides, an occasional second row behind
    for (const road of this.roads) {
      let acc = 0;
      for (let i = 1; i < road.length; i++) {
        const a = road[i - 1], b = road[i], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
        const nx = -dz / l, nz = dx / l;
        for (let u = acc; u < l; u += rand(rng, 13, 20)) {
          const px = a.x + dx / l * u, pz = a.z + dz / l * u;
          if (rng() < 0.08) this.cars.push({ x: px, z: pz, y: groundHeight(px, pz), rot: Math.atan2(dx, dz) + (rng() < 0.5 ? 0 : Math.PI), color: pick(rng, CONTAINER_COLORS.concat([0xdddddd, 0x222222, 0x8899aa])) });
          for (const side of [-1, 1]) for (const row of [0, 1]) {
            if (row === 1 && rng() > 0.4) continue;
            if (rng() > 0.85) continue;
            const off = (row ? 27 : 12.5) + rand(rng, -1.5, 1.5);
            const x = px + nx * off * side, z = pz + nz * off * side;
            const w = waterInfo(x, z);
            if (w.d < 10 || groundSlope(x, z) > 0.36 || this.reservedHit(x, z, 8)) continue;
            const ang = Math.atan2(-nx * side, -nz * side); // front faces the road
            const shop = w.d < 90 && Math.hypot(x - DOWNTOWN.x, z - DOWNTOWN.z) < 900 && rng() < 0.5;
            const hx = shop ? rand(rng, 4.5, 7.5) : rand(rng, 3.4, 5.4), hz = shop ? rand(rng, 4.5, 7) : rand(rng, 3.4, 5), r = Math.hypot(hx, hz);
            if (!this.free(x, z, r * 0.8, 2.5)) continue;
            if (shop) {
              const sh = rand(rng, 6, 13), pitched = rng() < 0.4;
              this.building(rng, x, z, hx, hz, ang, sh, pick(rng, MID_COLORS), 2, 'building', { pitched, asset: pitched ? 'shop_pitched' : sh < 9 ? 'shop_two' : 'shop_three' });
            } else this.house(rng, x, z, hx, hz, ang);
            this.occupy(x, z, r * 0.8);
          }
        }
        acc = 0;
      }
    }
    // a few scattered farmhouses and cottages in the hills
    for (let i = 0, n = 0; i < 4000 && n < 140; i++) {
      const x = rand(rng, -1500, 1500), z = rand(rng, -1900, 600);
      const w = waterInfo(x, z), h = groundHeight(x, z);
      if (w.d < 40 || h < 6 || h > 120 || groundSlope(x, z) > 0.25 || fbm(x * 0.003, z * 0.003, 2, 41) < 0.05) continue;
      const hx = rand(rng, 4, 6.5), hz = rand(rng, 3.5, 5.5), r = Math.hypot(hx, hz);
      if (!this.free(x, z, r, 25)) continue;
      const e = 4, ang = Math.atan2(groundHeight(x + e, z) - groundHeight(x - e, z), groundHeight(x, z + e) - groundHeight(x, z - e));
      this.house(rng, x, z, hx, hz, ang);
      this.occupy(x, z, r); n++;
    }
  }

  /** A house: one or two storeys, the model chosen to suit the plot's proportions. */
  house(rng, x, z, hx, hz, ang) {
    const h = rand(rng, 3.2, 6.2), aspect = hx / hz;
    const asset = h < 4.4 ? (aspect > 1.15 ? 'house_bungalow' : 'house_cottage') : aspect < 0.85 ? 'house_gablefront' : rng() < 0.5 ? 'house_two' : 'house_hip';
    return this.building(rng, x, z, hx, hz, ang, h, pick(rng, HOUSE_COLORS), 2, 'house', { pitched: true, asset });
  }

  /**
   * Stone quays along the harbour front and embankments along the river through downtown: 8 m wall
   * segments with a paved apron, coping at QUAY_TOP. Waves break over them as the water comes up.
   */
  generateQuays(rng) {
    if (!KIT_OK) return;
    const SEG = 8;
    const place = (x, z, wx, wz, len) => { // (wx, wz): unit vector from the quay toward the water
      if (this.reservedHit(x, z, 14) || !this.free(x, z, 4, 0)) return false;
      if (groundSlope(x, z) > 0.25) return false;
      const ang = Math.atan2(wx, wz); // kit front (+z local) faces the water
      const ladder = rng() < 0.18;
      // coping flush with the land behind it, so low stretches of waterfront go under first
      const top = clamp(Math.max(groundHeight(x - wx * 4, z - wz * 4), groundHeight(x - wx * 7, z - wz * 7)) + 0.05, 1.4, QUAY_TOP + 0.6);
      this.kitItem(ladder ? 'quay_ladder' : 'quay', { x, y: top, z, ang, sx: len / SEG, sy: 1, sz: 1 });
      // collider: the apron behind the face
      const cx = x - wx * 3.1, cz = z - wz * 3.1;
      const c = this.addOBB(cx, cz, len / 2, 3.3, ang, top, 'quay');
      c.roof = { minx: cx - 2, maxx: cx + 2, minz: cz - 2, maxz: cz + 2, top };
      c.base = top - 0.6; // people waiting here are "at the water"
      this.waterfront.push({ x, z, nx: wx, nz: wz, len, top, quay: true });
      if (rng() < 0.3) this.kitItem('lamp_post', { x: x - wx * 1.4, y: top, z: z - wz * 1.4, ang: ang + Math.PI });
      this.occupy(cx, cz, 4.5);
      return true;
    };
    // the bank: walk from a point out along a direction until the water starts
    const toBank = (x, z, dx, dz) => {
      for (let s = 0; s < 120; s += 1) { if (waterInfo(x + dx * s, z + dz * s).d <= 0) return { x: x + dx * s, z: z + dz * s }; }
      return null;
    };
    // river embankments through downtown
    for (const [ri, tMax] of [[0, 0.42], [1, 0.25]]) {
      const r = RIVERS[ri];
      for (const side of [-1, 1]) {
        let acc = SEG;
        for (let i = 0; i < r.pts.length - 1; i++) {
          const a = r.pts[i]; if (a.t > tMax) break;
          const b = r.pts[i + 1], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
          const tx = dx / l, tz = dz / l, nx = -tz * side, nz = tx * side; // nx,nz: out of the river
          for (let u = acc; u < l; u += SEG) {
            const px = a.x + tx * u, pz = a.z + tz * u;
            const w = r.w0 + (r.w1 - r.w0) * a.t;
            const land = { x: px + nx * (w / 2 + 40), z: pz + nz * (w / 2 + 40) };
            if (waterInfo(land.x, land.z).d < 2) continue;
            const bank = toBank(land.x, land.z, -nx, -nz);
            if (!bank) continue;
            place(bank.x + nx * 0.6, bank.z + nz * 0.6, -nx, -nz, SEG + 0.4);
          }
          acc = ((acc - l) % SEG + SEG) % SEG;
        }
      }
    }
    // harbour front: the bay's north shore around downtown and the industrial docks
    let last = null;
    for (let th = Math.PI * 1.08; th <= Math.PI * 1.92; th += 0.0015) {
      const ox = Math.cos(th), oz = Math.sin(th);
      let pt = null;
      for (let rr = 200; rr < 1500; rr += 2) {
        const x = ox * rr * 1.25, z = 260 + oz * rr;
        if (waterInfo(x, z).d >= 0) { pt = { x, z }; break; }
      }
      if (!pt || Math.abs(pt.x - DOWNTOWN.x) > 760) { last = null; continue; }
      if (last && Math.hypot(pt.x - last.x, pt.z - last.z) < SEG) continue;
      if (last && Math.hypot(pt.x - last.x, pt.z - last.z) > SEG * 2.2) last = null;
      const e = 5, gx = waterInfo(pt.x + e, pt.z).d - waterInfo(pt.x - e, pt.z).d, gz = waterInfo(pt.x, pt.z + e).d - waterInfo(pt.x, pt.z - e).d;
      const gl = Math.hypot(gx, gz) || 1;
      if (place(pt.x + gx / gl * 0.6, pt.z + gz / gl * 0.6, -gx / gl, -gz / gl, SEG + 0.6)) last = pt;
    }
  }

  /** Asphalt ribbons draped over the ground along each road. */
  roadMeshes(scene, uniforms) {
    const mat = new THREE.MeshStandardMaterial({ color: 0x3a3b3d, roughness: 0.92 });
    patchFloodMaterial(mat, uniforms, false);
    mat.polygonOffset = true; mat.polygonOffsetFactor = -2; mat.polygonOffsetUnits = -2;
    for (const road of this.roads) {
      const pos = [], idx = [], W = 3.6;
      road.forEach((p, i) => {
        const a = road[Math.max(0, i - 1)], b = road[Math.min(road.length - 1, i + 1)];
        const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, nx = -dz / l, nz = dx / l;
        for (const s of [-1, 1]) { const x = p.x + nx * W * s, z = p.z + nz * W * s; pos.push(x, groundHeight(x, z) + 0.12, z); }
        if (i > 0) { const k = (i - 1) * 2; idx.push(k, k + 2, k + 1, k + 1, k + 2, k + 3); }
      });
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      const m = new THREE.Mesh(g, mat); m.receiveShadow = true; m.layers.set(LAYER_NO_REFLECT);
      scene.add(m);
    }
  }

  scatterCar(rng, x, z, ang, off) {
    const cx = x + Math.sin(ang) * off, cz = z + Math.cos(ang) * off;
    this.cars.push({ x: cx, z: cz, y: groundHeight(cx, cz), rot: ang + Math.PI / 2 + rand(rng, -0.2, 0.2), color: pick(rng, CONTAINER_COLORS.concat([0xdddddd, 0x222222, 0x8899aa])) });
  }

  generatePiers(rng) {
    // walk outward from shore points in town: jetties and piers on piles, decks just above the starting flood
    let n = 0;
    for (let i = 0; i < 6000 && n < 26; i++) {
      const x = rand(rng, -1200, 1200), z = rand(rng, -900, 260);
      if (!this.townArea(x, z) || this.reservedHit(x, z, 40)) continue;
      const w = waterInfo(x, z);
      if (Math.abs(w.d) > 5 || !this.free(x, z, 30, 40)) continue;
      const [ax, az] = this.awayFromWater(x, z);
      const ang = Math.atan2(-ax, -az); // pointing into the water
      const len = rand(rng, 28, 60), hw = rand(rng, 3, 4.5);
      const cx = x - ax * len / 2, cz = z - az * len / 2;
      if (groundHeight(x - ax * len, z - az * len) > -1.5) continue; // needs water at its end
      const top = PIER_TOP;
      const cs = Math.cos(ang), sn = Math.sin(ang);
      if (KIT_OK) { // modular bays, the last one with bollards, ladder and lamp at the seaward end
        const n = Math.max(1, Math.round(len / 6)), bl = len / n;
        for (let k = 0; k < n; k++) {
          const s = -len / 2 + bl * (k + 0.5);
          this.kitItem(k === n - 1 ? 'pier_end' : 'pier_bay', { x: cx + s * sn, y: top, z: cz + s * cs, ang: ang + Math.PI, sx: (2 * hw) / 6, sy: 1, sz: bl / 6 });
        }
      } else {
        this.obox(this.plain, cx, cz, hw, len / 2, ang, top - 0.6, top, 0x6b5640);
        for (let s = -len / 2 + 3; s < len / 2; s += 7) for (const side of [-1, 1]) {
          const lx = side * (hw - 0.4), px = cx + lx * cs + s * sn, pz = cz - lx * sn + s * cs;
          this.obox(this.plain, px, pz, 0.3, 0.3, ang, groundHeight(px, pz) - 1, top - 0.6, 0x3e3226);
        }
      }
      const pc = this.addOBB(cx, cz, hw, len / 2, ang, top, 'pier');
      pc.base = top - 1; pc.pierEnd = { x: x - ax * (len - 4), z: z - az * (len - 4) };
      pc.roof = { minx: pc.pierEnd.x - 2, maxx: pc.pierEnd.x + 2, minz: pc.pierEnd.z - 2, maxz: pc.pierEnd.z + 2, top };
      // the outer end and both sides take the waves
      this.waterfront.push({ x: x - ax * len, z: z - az * len, nx: -ax, nz: -az, len: hw * 2, top });
      for (const side of [-1, 1]) this.waterfront.push({ x: cx + side * hw * cs, z: cz - side * hw * sn, nx: side * cs, nz: -side * sn, len: len * 0.8, top });
      this.occupy(cx, cz, len / 2); n++;
    }
  }

  generateBridges(rng) {
    // [river, position, deck height]: road bridges built high over the river, so that as the water rises
    // each one becomes a different squeeze (see levels.js for the water at each level)
    const spans = [[0, 0.07, 12.5], [0, 0.2, 11.0], [0, 0.36, 12.0], [1, 0.12, 11.3]];
    for (const [ri, t, deck] of spans) {
      const r = RIVERS[ri], i = Math.floor(t * (r.pts.length - 2)), a = r.pts[i], b = r.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
      const tx = dx / l, tz = dz / l; // river tangent
      const w = r.w0 + (r.w1 - r.w0) * t, span = w + 60, ang = Math.atan2(tx, tz); // deck runs across the river
      const nx = -tz, nz = tx;
      const bank = Math.max(groundHeight(a.x + nx * span / 2, a.z + nz * span / 2), groundHeight(a.x - nx * span / 2, a.z - nz * span / 2));
      const top = Math.max(bank + 1, deck) + rand(rng, 0, 0.3), bottom = top - 1.4;
      // deck: local x along the river (narrow), local z across it (long)
      const bang = Math.atan2(nx, nz);
      this.obox(this.plain, a.x, a.z, 4.5, span / 2, bang, bottom, top, 0x77756f);
      for (const side of [-1, 1]) {
        const ox = a.x + tx * side * 4.2, oz = a.z + tz * side * 4.2;
        this.obox(this.plain, ox, oz, 0.15, span / 2, bang, top, top + 1.0, 0x55534f);
      }
      this.addOBB(a.x, a.z, 4.5, span / 2, bang, top, 'bridge', null, bottom);
      for (const f of [-0.28, 0.28]) { // piers in the stream
        const px = a.x + nx * span * f, pz = a.z + nz * span * f;
        const g = groundHeight(px, pz);
        this.obox(this.plain, px, pz, 2.2, 1.6, ang, g - 1, bottom, 0x6c6a64);
        this.addOBB(px, pz, 2.2, 1.6, ang, bottom, 'pillar');
      }
      this.occupy(a.x, a.z, span / 2 + 10);
      void ang;
    }
  }

  crane(x, z, ang) {
    const col = 0xd1a12a, g = groundHeight(x, z);
    const cs = Math.cos(ang), sn = Math.sin(ang);
    const P = (lx, lz) => [x + lx * cs + lz * sn, z - lx * sn + lz * cs];
    for (const [lx, lz] of [[-6, -5], [6, -5], [-6, 5], [6, 5]]) { const [px, pz] = P(lx, lz); this.obox(this.plain, px, pz, 0.7, 0.7, ang, g, g + 28, col); }
    { const [px, pz] = P(0, 0); this.obox(this.plain, px, pz, 7.5, 6, ang, g + 28, g + 31, col); }
    { const [px, pz] = P(0, -18); this.obox(this.plain, px, pz, 1.5, 34, ang, g + 29, g + 31.5, col); }
    for (const [lx, lz] of [[-6, 0], [6, 0]]) { const [px, pz] = P(lx, lz); this.addOBB(px, pz, 0.8, 5.8, ang, g + 28, 'crane'); }
  }

  generateLighthouse() {
    // on the east headland at the mouth of the bay
    const s = findSpot(300, 930, 3, 14, 450, (x, z) => waterInfo(x, z).d > 6 && waterInfo(x, z).d < 30);
    this.lighthousePos = new THREE.Vector3(s.x, s.h, s.z);
    this.addCollider(s.x - 8, s.x + 8, s.z - 8, s.z + 8, s.h + 26, 'lighthouse');
    this.occupy(s.x, s.z, 15);
  }

  // ---- meshes ---------------------------------------------------------------------
  instancedBoxes(all, mat, withStyle) {
    return tiled(all, (b) => [b.cx, b.cz], (list) => this.instancedBoxChunk(list, mat, withStyle));
  }
  instancedBoxChunk(list, mat, withStyle) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    let style;
    if (withStyle) { style = new Float32Array(list.length); geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 1)); }
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
    list.forEach((b, i) => {
      q.setFromAxisAngle(up, b.ang); p.set(b.cx, (b.y0 + b.y1) / 2, b.cz); s.set(b.hx * 2, b.y1 - b.y0, b.hz * 2);
      m.compose(p, q, s); mesh.setMatrixAt(i, m); mesh.setColorAt(i, col.setHex(b.color));
      if (style) style[i] = b.style;
    });
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }

  buildMeshes(scene, uniforms) {
    this.roadMeshes(scene, uniforms);
    if (KIT_OK) {
      for (const [asset, items] of Object.entries(this.kit)) {
        const small = asset.startsWith('car') || asset === 'lamp_post';
        placeKit(scene, uniforms, asset, items, { lodDist: small ? 90 : asset.startsWith('pier') || asset.startsWith('quay') ? 220 : 170, noReflect: small });
      }
      // cars from the road pass
      const cars = { car_sedan: [], car_van: [] };
      this.cars.forEach((c, i) => cars[i % 4 === 3 ? 'car_van' : 'car_sedan'].push({ x: c.x, y: c.y, z: c.z, ang: c.rot, wall: c.color }));
      for (const [asset, items] of Object.entries(cars)) placeKit(scene, uniforms, asset, items, { lodDist: 90, noReflect: true });
    }
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 });
    patchFloodMaterial(wallMat, uniforms, true);
    scene.add(this.instancedBoxes(this.walls, wallMat, true));
    const plainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    patchFloodMaterial(plainMat, uniforms, false);
    scene.add(this.instancedBoxes(this.plain, plainMat, false));

    const pr = new THREE.BufferGeometry();
    const v = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0, 1, 0.5,
      -0.5, 0, 0.5, -0.5, 0, -0.5, 0, 1, -0.5, -0.5, 0, 0.5, 0, 1, -0.5, 0, 1, 0.5,
      0.5, 0, -0.5, 0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5];
    pr.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    pr.computeVertexNormals();
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
    patchFloodMaterial(roofMat, uniforms, false);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    scene.add(tiled(this.roofs, (r) => [r.x, r.z], (list) => {
      const roofs = new THREE.InstancedMesh(pr, roofMat, list.length);
      list.forEach((r, i) => {
        const alongZ = r.d >= r.w; // ridge along the longer side
        q.setFromAxisAngle(up, r.ang + (alongZ ? 0 : Math.PI / 2));
        s.set(alongZ ? r.w : r.d, r.h, alongZ ? r.d : r.w);
        p.set(r.x, r.y, r.z);
        m.compose(p, q, s); roofs.setMatrixAt(i, m); roofs.setColorAt(i, col.setHex(r.color));
      });
      roofs.castShadow = true; roofs.receiveShadow = true;
      return roofs;
    }));

    const carGeo = new THREE.BoxGeometry(1.8, 1.4, 4.2); carGeo.translate(0, 0.7, 0);
    if (KIT_OK) this.cars.length = 0; // drawn from the kit above
    const carMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.4 });
    patchFloodMaterial(carMat, uniforms, false);
    if (this.cars.length) scene.add(tiled(this.cars, (c) => [c.x, c.z], (list) => {
      const cars = new THREE.InstancedMesh(carGeo, carMat, list.length);
      list.forEach((c, i) => {
        q.setFromAxisAngle(up, c.rot); p.set(c.x, c.y, c.z); s.set(1, 1, 1);
        m.compose(p, q, s); cars.setMatrixAt(i, m); cars.setColorAt(i, col.setHex(c.color));
      });
      cars.layers.set(LAYER_NO_REFLECT);
      return cars;
    }));

    // Lighthouse on the headland.
    const lh = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xb02a22, roughness: 0.6 });
    const t1 = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 22, 24), white); t1.position.y = 11 - 4;
    const rAt = (y) => 4.2 - (y + 4) / 22;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(rAt(11) + 0.1, rAt(7) + 0.1, 4, 24), red); band.position.y = 9;
    const band2 = new THREE.Mesh(new THREE.CylinderGeometry(rAt(16.5) + 0.1, rAt(13.5) + 0.1, 3, 24), red); band2.position.y = 15;
    const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.6, 3.6, 0.35, 24), new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.5, metalness: 0.6 })); gallery.position.y = 18.2;
    const rail = new THREE.Mesh(new THREE.TorusGeometry(3.5, 0.05, 4, 32), gallery.material); rail.rotation.x = Math.PI / 2; rail.position.y = 19.2;
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3, 12), new THREE.MeshStandardMaterial({ color: 0xfff1b0, emissive: 0xffd76a, emissiveIntensity: 0.4 }));
    lamp.position.y = 19.5;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.8, 2.5, 12), red); cap.position.y = 22.2;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(6, 7, 6, 16), new THREE.MeshStandardMaterial({ color: 0x6c6a64, roughness: 0.95 })); base.position.y = -5;
    for (const o of [t1, band, band2, gallery, rail, cap, base]) { o.castShadow = true; lh.add(o); }
    lh.add(lamp);
    const beamGeo = new THREE.ConeGeometry(9, 160, 16, 1, true); beamGeo.translate(0, -80, 0); beamGeo.rotateZ(Math.PI / 2);
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(beamGeo, this.beamMat); this.beam.position.y = 19.5;
    lh.add(this.beam);
    this.lampMat = lamp.material;
    lh.position.copy(this.lighthousePos); lh.position.y = this.lighthousePos.y + 4;
    scene.add(lh);
  }

  update(dt, night, time, cam) {
    if (cam) updateKitLOD(cam);
    this.beam.rotation.y = time * 0.6;
    this.beamMat.opacity = 0.16 * night;
    this.lampMat.emissiveIntensity = 0.3 + 3 * night;
  }

  // ---- queries ----------------------------------------------------------------------
  forEachNear(x, z, r, fn) {
    const q = ++this.qid, s = this.cell;
    for (let cx = Math.floor((x - r) / s); cx <= Math.floor((x + r) / s); cx++)
      for (let cz = Math.floor((z - r) / s); cz <= Math.floor((z + r) / s); cz++) {
        const arr = this.grid.get((cx + 5000) * 10000 + (cz + 5000));
        if (!arr) continue;
        for (const id of arr) {
          if (this.mark[id] === q) continue;
          this.mark[id] = q;
          if (fn(this.colliders[id]) === false) return;
        }
      }
  }
  pointInBuilding(x, z, margin = 0) {
    let hit = false;
    this.forEachNear(x, z, margin + 1, (c) => {
      const [lx, lz] = this.local(c, x, z);
      if (Math.abs(lx) < c.hx + margin && Math.abs(lz) < c.hz + margin) { hit = true; return false; }
    });
    return hit;
  }
  /** Highest active collider top covering the point, or -Infinity. */
  topAt(x, z) {
    let t = -Infinity;
    this.forEachNear(x, z, 0.5, (c) => {
      if (!this.active(c) || c.top <= t) return;
      const [lx, lz] = this.local(c, x, z);
      if (Math.abs(lx) <= c.hx && Math.abs(lz) <= c.hz) t = c.top;
    });
    return t;
  }
  /** Circle vs colliders whose top exceeds minTop; calls fn(nx, nz, penetration, collider). */
  circleContacts(x, z, r, minTop, fn, airTop) {
    this.forEachNear(x, z, r, (c) => {
      if (c.top <= minTop) return;
      // bridge decks: with the boat's height known, only what reaches the underside hits
      if (c.bottom !== undefined) { if (airTop !== undefined ? airTop <= c.bottom : !this.active(c)) return; }
      const [lx, lz] = this.local(c, x, z);
      const px = clamp(lx, -c.hx, c.hx), pz = clamp(lz, -c.hz, c.hz);
      let dx = lx - px, dz = lz - pz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      let pen;
      if (d2 < 1e-8) {
        const l = lx + c.hx, rr = c.hx - lx, b = lz + c.hz, t = c.hz - lz, m = Math.min(l, rr, b, t);
        if (m === l) { dx = -1; dz = 0; } else if (m === rr) { dx = 1; dz = 0; } else if (m === b) { dx = 0; dz = -1; } else { dx = 0; dz = 1; }
        pen = m + r;
      } else { const d = Math.sqrt(d2); dx /= d; dz /= d; pen = r - d; }
      // back to world space
      fn(dx * c.cos + dz * c.sin, -dx * c.sin + dz * c.cos, pen, c);
    });
  }
}

export function rectDistance(rc, x, z) {
  const dx = Math.max(rc.minx - x, 0, x - rc.maxx), dz = Math.max(rc.minz - z, 0, z - rc.maxz);
  return Math.hypot(dx, dz);
}
