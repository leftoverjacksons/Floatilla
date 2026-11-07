import * as THREE from 'three';
import { rand, randInt, pick, clamp, mulberry32 } from './util.js';
import { Boat, randomDesign, KINDS } from './boat.js';
import { Person, Animal, ANIMALS } from './people.js';
import { steerBoat } from './fleet.js';
import { rectDistance } from './city.js';
import { DOWNTOWN } from './terrain.js';
import { angleDiff } from './util.js';

const PICKUPS = {
  planks: { label: 'Planks', w: 5, give: (r) => ({ wood: randInt(r, 1, 3) }) },
  crate: { label: 'Crate', w: 3, give: (r) => ({ wood: randInt(r, 0, 1), scrap: randInt(r, 1, 2), cloth: r() < 0.4 ? 1 : 0, parts: r() < 0.2 ? 1 : 0 }) },
  barrel: { label: 'Fuel drum', w: 1.5, give: (r) => ({ fuel: randInt(r, 2, 5) }) },
  bundle: { label: 'Cloth bundle', w: 2, give: (r) => ({ cloth: randInt(r, 1, 3) }) },
  food: { label: 'Food crate', w: 2.5, give: (r) => ({ food: randInt(r, 2, 5) }) },
  water: { label: 'Water jugs', w: 2.5, give: (r) => ({ water: randInt(r, 3, 6) }) },
  junk: { label: 'Scrap', w: 3, give: (r) => ({ scrap: randInt(r, 1, 3), parts: r() < 0.1 ? 1 : 0 }) },
  log: { label: 'Driftwood', w: 3, give: (r) => ({ wood: randInt(r, 2, 4) }) },
};
const PICKUP_KEYS = Object.keys(PICKUPS);
const ROOF_KINDS = new Set(['house', 'building', 'tower', 'pier', 'quay', 'containers', 'warehouse']);

const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
const mat = (c, o = {}) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8, ...o });
const MATS = {
  wood: mat(0x8a6a44), dark: mat(0x5a4028), red: mat(0xa8322a), blue: mat(0x2e5fa3), green: mat(0x3a6a3a),
  white: mat(0xe8e4d8), grey: mat(0x6a6e72, { metalness: 0.5 }), cloth: mat(0xd8c8a0), yellow: mat(0xd8a020),
};
function piece(g, geo, m, sx, sy, sz, x, y, z, rx = 0, ry = 0) {
  const o = new THREE.Mesh(geo, m); o.scale.set(sx, sy, sz); o.position.set(x, y, z); o.rotation.set(rx, ry, 0); o.castShadow = true; g.add(o); return o;
}
function pickupMesh(type, rng) {
  const g = new THREE.Group();
  switch (type) {
    case 'planks': for (let i = 0; i < 4; i++) piece(g, BOX, MATS.wood, 0.25, 0.06, 2.2, (i - 1.5) * 0.28, 0.05 + (i % 2) * 0.06, rand(rng, -0.2, 0.2), 0, rand(rng, -0.2, 0.2)); break;
    case 'crate': piece(g, BOX, MATS.wood, 0.9, 0.7, 0.9, 0, 0.15, 0); piece(g, BOX, MATS.dark, 0.95, 0.08, 0.95, 0, 0.5, 0); break;
    case 'barrel': piece(g, CYL, pick(rng, [MATS.red, MATS.blue, MATS.yellow]), 0.32, 0.9, 0.32, 0, 0.1, 0, Math.PI / 2); break;
    case 'bundle': piece(g, BOX, MATS.cloth, 0.8, 0.4, 0.6, 0, 0.1, 0); piece(g, BOX, MATS.dark, 0.1, 0.42, 0.62, 0, 0.1, 0); break;
    case 'food': piece(g, BOX, MATS.green, 0.8, 0.5, 0.6, 0, 0.1, 0); piece(g, BOX, MATS.white, 0.3, 0.1, 0.3, 0, 0.36, 0); break;
    case 'water': for (let i = 0; i < 3; i++) piece(g, CYL, MATS.white, 0.18, 0.5, 0.18, (i - 1) * 0.4, 0.15, 0); break;
    case 'junk': piece(g, BOX, MATS.grey, 0.8, 0.3, 0.5, 0, 0.05, 0, 0, 0.4); piece(g, CYL, MATS.grey, 0.15, 0.9, 0.15, 0.2, 0.2, 0.1, 1.2); break;
    case 'log': piece(g, CYL, MATS.dark, 0.25, 3.2, 0.25, 0, 0.05, 0, Math.PI / 2, rand(rng, 0, 3)); break;
  }
  return g;
}

export class World {
  constructor(game) {
    this.game = game; this.scene = game.scene;
    this.rng = mulberry32(4242);
    this.pickups = []; this.groups = []; this.caches = []; this.boats = []; this.jumpers = [];
    this.timer = 0;
    this.raiderTimer = 60;
    // Spawn timers in game hours: discoveries are rare and spaced out.
    this.groupTimer = 0.5; this.cacheTimer = 1; this.derelictTimer = 2; this.npcTimer = 30;
    this.lastHours = null;
    this.markerGeo = new THREE.ConeGeometry(0.5, 1.2, 4);
  }

  get ctx() { return this.game.ctx; }

  // ---------------- spawning helpers ----------------
  openWater(x, z, minDepth, clearR) {
    const c = this.ctx;
    if (c.water.level - c.floorMap.floorAt(x, z) < minDepth) return false;
    if (clearR && c.city.pointInBuilding(x, z, clearR)) return false;
    for (const [ox, oz] of [[clearR, 0], [-clearR, 0], [0, clearR], [0, -clearR]])
      if (c.water.level - Math.max(c.floorMap.groundAt(x + ox, z + oz), c.city.topAt(x + ox, z + oz)) < minDepth * 0.7) return false;
    return true;
  }
  randomWaterPoint(cx, cz, r0, r1, minDepth, clearR, tries = 20) {
    for (let i = 0; i < tries; i++) {
      const a = this.rng() * Math.PI * 2, r = rand(this.rng, r0, r1);
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (this.openWater(x, z, minDepth, clearR)) return { x, z };
    }
    return null;
  }

  spawnPickup(x, z, type) {
    type = type || this.weightedPickup();
    const m = pickupMesh(type, this.rng);
    this.scene.add(m);
    const p = { type, x, z, mesh: m, phase: rand(this.rng, 0, 6) };
    this.pickups.push(p);
    return p;
  }
  weightedPickup() {
    const tot = PICKUP_KEYS.reduce((a, k) => a + PICKUPS[k].w, 0);
    let r = this.rng() * tot;
    for (const k of PICKUP_KEYS) if ((r -= PICKUPS[k].w) <= 0) return k;
    return 'crate';
  }

  makeFlag(color = 0xd83020) {
    const g = new THREE.Group();
    piece(g, CYL, MATS.grey, 0.03, 2.6, 0.03, 0, 1.3, 0);
    const f = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.55), new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, emissive: color, emissiveIntensity: 0.15 }));
    f.geometry.translate(0.45, 0, 0); f.position.y = 2.3; g.add(f);
    g.userData.cloth = f;
    return g;
  }

  spawnSurvivorGroup(c, opts = {}) {
    const rng = this.rng;
    const roof = c ? c.roof : null;
    const g = { kind: c ? 'roof' : 'float', c, people: [], animals: [], state: c ? 'roof' : 'float', timer: 0, x: 0, z: 0, extras: new THREE.Group() };
    let n = opts.people ?? (() => { const r = rng(); return r < 0.15 ? 0 : r < 0.72 ? 1 : r < 0.95 ? 2 : 3; })();
    let animal = opts.animal ?? (n === 0 || rng() < 0.3 ? pick(rng, Object.keys(ANIMALS)) : null);
    if (c) {
      g.x = (roof.minx + roof.maxx) / 2; g.z = (roof.minz + roof.maxz) / 2; g.y = roof.top;
      c.used = true;
    } else {
      g.x = opts.x; g.z = opts.z; g.y = this.ctx.water.heightAt(g.x, g.z);
      piece(g.extras, BOX, MATS.wood, 2.0, 0.15, 1.2, 0, 0, 0);
      n = Math.max(1, Math.min(n, 2));
    }
    const spread = c ? Math.min(3, (roof.maxx - roof.minx) / 2 - 0.5) : 0.5;
    const spreadZ = c ? Math.min(3, (roof.maxz - roof.minz) / 2 - 0.5) : 0.3;
    for (let i = 0; i < n; i++) {
      const p = new Person(rng);
      p.offset = new THREE.Vector3(rand(rng, -spread, spread), 0, rand(rng, -spreadZ, spreadZ));
      g.people.push(p); this.scene.add(p.mesh);
    }
    if (animal) {
      const a = new Animal(rng, animal);
      a.offset = new THREE.Vector3(rand(rng, -spread, spread), 0, rand(rng, -spreadZ, spreadZ));
      g.animals.push(a); this.scene.add(a.mesh);
    }
    if (c && n > 0) { const f = this.makeFlag(); f.position.set(g.x + spread * 0.8, 0, g.z - spreadZ * 0.8); g.flag = f; g.extras.add(f); f.position.y = 0; f.userData.local = true; }
    this.scene.add(g.extras);
    this.groups.push(g);
    return g;
  }

  spawnCache(c) {
    const g = new THREE.Group();
    const rng = this.rng;
    const n = randInt(rng, 2, 4);
    for (let i = 0; i < n; i++) piece(g, BOX, i % 2 ? MATS.wood : MATS.dark, 0.9, 0.7, 0.9, rand(rng, -0.8, 0.8), 0.35 + (i > 1 ? 0.7 : 0), rand(rng, -0.8, 0.8));
    piece(g, CYL, pick(rng, [MATS.red, MATS.blue]), 0.3, 0.9, 0.3, 1.2, 0.45, 0.2);
    const tarp = piece(g, BOX, MATS.blue, 2.2, 0.05, 2.0, 0, 1.55, 0); tarp.rotation.z = 0.1;
    const roof = c.roof;
    const x = (roof.minx + roof.maxx) / 2 + rand(rng, -1, 1), z = (roof.minz + roof.maxz) / 2 + rand(rng, -1, 1);
    g.position.set(x, roof.top, z);
    this.scene.add(g); c.used = true;
    const loot = { wood: randInt(rng, 2, 8), scrap: randInt(rng, 1, 6), cloth: randInt(rng, 0, 4), food: randInt(rng, 2, 8), water: randInt(rng, 0, 6), fuel: rng() < 0.5 ? randInt(rng, 2, 8) : 0, parts: rng() < 0.5 ? randInt(rng, 1, 3) : 0 };
    this.caches.push({ c, mesh: g, loot, x, z });
  }

  spawnBoat(kind, x, z, role, opts = {}) {
    const rng = this.rng;
    const d = randomDesign(rng, kind);
    const modules = opts.modules || [];
    const b = new Boat(d, { x, z, heading: opts.heading ?? rand(rng, 0, Math.PI * 2), role, modules, hpFrac: opts.hpFrac, flagColor: role === 'raider' ? 0x111111 : role === 'npc' ? 0xf0f0f0 : 0x9a9a9a });
    b.y = this.ctx.water.heightAt(x, z);
    this.scene.add(b.root);
    this.boats.push(b);
    return b;
  }
  claimBoat(b) { b.role = b === this.game.fleet.player ? 'player' : 'follower'; }

  randomDerelictKind(days) {
    const pool = [['rowboat', 4], ['skiff', 3], ['sailboat', 3], ['fishing', 2], ['houseboat', 2], ['yacht', 1.5], ['barge', 1], ['tug', 1], ['raft', 1.5], ['schooner', days > 3 ? 1 : 0.3]];
    const tot = pool.reduce((a, p) => a + p[1], 0);
    let r = this.rng() * tot;
    for (const [k, w] of pool) if ((r -= w) <= 0) return k;
    return 'rowboat';
  }

  /**
   * Boats left behind in the harbour: tied up alongside the piers and swinging at anchor off the town.
   * They stay put until the flood or a storm tears them loose; then they drift and can be claimed.
   */
  populateHarbour() {
    const c = this.ctx.city, rng = this.rng, level = this.ctx.water.level;
    const deep = (x, z, b) => level - this.ctx.floorMap.floorAt(x, z) > b.design.draft + 0.4 && !c.pointInBuilding(x, z, b.B * 0.5 + 0.3);
    const PIER_KINDS = ['sailboat', 'sailboat', 'fishing', 'yacht', 'rowboat', 'skiff', 'houseboat', 'fishing'];
    for (const p of c.colliders) {
      if (p.kind !== 'pier') continue;
      for (const side of [1, -1]) {
        if (rng() > 0.35) continue;
        const b = this.spawnBoat(pick(rng, PIER_KINDS), p.cx, p.cz, 'moored', { hpFrac: rand(rng, 0.5, 0.9) });
        // along the pier (local z toward the sea end), off one side
        const s = rand(rng, -0.05, 0.3) * p.hz * 2, off = p.hx + b.B / 2 + 0.7;
        const x = p.cx + p.sin * s + p.cos * side * off, z = p.cz + p.cos * s - p.sin * side * off;
        if (!deep(x, z, b)) { this.removeBoat(b); continue; }
        const h = Math.atan2(p.sin, p.cos) + (rng() < 0.5 ? 0 : Math.PI);
        b.x = x; b.z = z; b.heading = h; b.mooring = { x, z, h, pier: p };
      }
    }
    // at anchor off the waterfront
    const ANCHOR_KINDS = ['sailboat', 'sailboat', 'yacht', 'fishing', 'schooner', 'houseboat', 'tug', 'barge'];
    let placed = 0;
    for (let i = 0; i < 300 && placed < 8; i++) {
      const a = rng() * Math.PI * 2, r = rand(rng, 120, 900);
      const x = DOWNTOWN.x + Math.cos(a) * r * 1.2, z = DOWNTOWN.z + 420 + Math.sin(a) * r * 0.6;
      if (this.boats.some((o) => Math.hypot(o.x - x, o.z - z) < 40)) continue;
      const kind = pick(rng, ANCHOR_KINDS), K = KINDS[kind];
      if (!this.openWater(x, z, K.draft[1] + 1.5, K.L[1] * 0.6 + 4)) continue;
      const b = this.spawnBoat(kind, x, z, 'moored', { hpFrac: rand(rng, 0.4, 0.85) });
      b.mooring = { x, z, h: b.heading, pier: null };
      placed++;
    }
  }

  /** Hold a moored boat in place; let it go when the water tops its pier or a storm drags the anchor. */
  moorAI(b, dt, ctx) {
    const m = b.mooring, env = ctx.env;
    b.throttle = 0; b.rudder = 0; b.anchored = true;
    let loose = false;
    if (m.pier && ctx.water.level > m.pier.top + 0.35) loose = true;
    if (!m.pier && env.cur.wind > 15 && this.rng() < dt / 900) loose = true;
    if (loose) {
      b.role = 'derelict'; b.mooring = null; b.anchored = false;
      const pl = this.game.fleet.player;
      if (pl && Math.hypot(b.x - pl.x, b.z - pl.z) < 700) this.game.ui.toast(`A ${b.design.label.toLowerCase()} has torn free of its ${m.pier ? 'mooring' : 'anchor'} and is drifting.`, 'info');
      return;
    }
    // anchored boats swing bow-to-wind; pier boats lie along the pier
    const h = m.pier ? m.h : Math.atan2(-ctx.wind.x, -ctx.wind.y);
    const k = Math.min(1, dt * 0.6);
    b.heading += angleDiff(h, b.heading) * k * (m.pier ? 1 : 0.3);
    const sway = m.pier ? 0.15 : 6; // anchor rode lets it wander a little
    const tx = m.x + (m.pier ? 0 : -Math.sin(h) * sway), tz = m.z + (m.pier ? 0 : -Math.cos(h) * sway);
    b.x += (tx - b.x) * k; b.z += (tz - b.z) * k; b.vx *= 0.9; b.vz *= 0.9;
  }

  // ---------------- per-frame ----------------
  update(dt, ctx) {
    const fleet = this.game.fleet, pl = fleet.player;
    const env = ctx.env, water = ctx.water;
    this.timer -= dt;
    if (this.timer <= 0) { this.timer = 1; this.maintain(ctx); }

    // floating pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.x += ctx.wind.x * 0.015 * dt; p.z += ctx.wind.y * 0.015 * dt;
      p.phase += dt;
      const h = water.heightAt(p.x, p.z);
      if (water.level - ctx.floorMap.floorAt(p.x, p.z) < 0.2) { p.x -= ctx.wind.x * 0.015 * dt; p.z -= ctx.wind.y * 0.015 * dt; }
      p.mesh.position.set(p.x, h, p.z);
      p.mesh.rotation.set(Math.sin(p.phase * 1.3) * 0.12, p.phase * 0.1, Math.cos(p.phase) * 0.12);
      // collection by any fleet boat
      for (const b of fleet.boats) {
        const r = b.L * 0.5 + 2.5 + b.count('net') * 4 + (b.taskCounts?.lookout ? 1 : 0);
        if (Math.hypot(b.x - p.x, b.z - p.z) < r) {
          const gives = PICKUPS[p.type].give(this.rng);
          const parts = [];
          let full = false;
          for (const [res, n] of Object.entries(gives)) if (n > 0) { const got = fleet.give(res, n); if (got > 0) parts.push(`+${Math.round(got)} ${res}`); if (got < n) full = true; }
          this.game.ui.toast(`${PICKUPS[p.type].label}: ${parts.join(', ') || 'no room'}${full ? ' (cargo full!)' : ''}`, 'loot');
          this.game.audio.blip(660);
          this.scene.remove(p.mesh); this.pickups.splice(i, 1);
          break;
        }
      }
    }

    // survivor groups
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      if (g.kind === 'roof') {
        if (g.state === 'roof' && water.level > g.c.roof.top - 0.3) {
          g.state = 'swim'; g.timer = 200;
          if (g.people.length && Math.hypot(g.x - pl.x, g.z - pl.z) < 600) this.game.ui.toast('Water has swallowed a rooftop — survivors are in the water!', 'warn');
        }
      } else { g.x += ctx.wind.x * 0.02 * dt; g.z += ctx.wind.y * 0.02 * dt; }
      if (g.state === 'swim') {
        g.timer -= dt;
        if (g.timer <= 0) {
          if (g.people.length && Math.hypot(g.x - pl.x, g.z - pl.z) < 700) this.game.ui.toast(`${g.people.length} survivor${g.people.length > 1 ? 's' : ''} lost to the flood.`, 'bad');
          fleet.stats.lost += g.people.length;
          if (g.landmark) g.landmark.rescued = true;
          this.removeGroup(g, i); continue;
        }
      }
      const baseY = g.state === 'roof' ? g.c.roof.top : water.heightAt(g.x, g.z);
      g.extras.position.set(g.x, baseY, g.z);
      if (g.flag) { g.flag.userData.cloth.rotation.y = Math.atan2(ctx.wind.x, ctx.wind.y) - Math.PI / 2 + Math.sin(performance.now() * 0.01) * 0.2; g.flag.visible = g.state === 'roof'; }
      const near = Math.hypot(g.x - pl.x, g.z - pl.z);
      for (const p of g.people) {
        const y = g.state === 'swim' ? water.heightAt(g.x + p.offset.x, g.z + p.offset.z) - 1.25 : g.state === 'float' ? baseY + 0.1 : baseY;
        p.mesh.position.set(g.x + p.offset.x, y, g.z + p.offset.z);
        p.mesh.rotation.y = Math.atan2(pl.x - p.mesh.position.x, pl.z - p.mesh.position.z);
        p.animate(dt, g.state === 'swim' ? 'swim' : g.state === 'float' ? 'sit' : near < 250 ? 'wave' : 'idle');
      }
      for (const a of g.animals) {
        const y = g.state === 'swim' ? water.heightAt(g.x + a.offset.x, g.z + a.offset.z) - a.def.legH - a.def.body[1] * 0.5 : baseY;
        a.mesh.position.set(g.x + a.offset.x, y, g.z + a.offset.z); a.animate(dt, g.state === 'swim');
      }
    }

    // caches drown too
    for (let i = this.caches.length - 1; i >= 0; i--) {
      const c = this.caches[i];
      if (water.level > c.c.roof.top + 0.5) { // swept off: becomes floating pickups
        for (let k = 0; k < 2; k++) this.spawnPickup(c.x + rand(this.rng, -3, 3), c.z + rand(this.rng, -3, 3));
        this.scene.remove(c.mesh); this.caches.splice(i, 1);
      }
    }

    // independent boats
    for (let i = this.boats.length - 1; i >= 0; i--) {
      const b = this.boats[i];
      if (b.fleet) continue;
      if (b.role === 'moored') {
        // far-off moored boats just sit (and are not drawn beyond 350 m); nearby ones bob and swing
        const dm = Math.hypot(b.x - pl.x, b.z - pl.z);
        b.root.visible = dm < 350;
        if (dm > 450 && b.settled) continue;
        b.update(dt, ctx); this.moorAI(b, dt, ctx); continue;
      }
      if (b.role === 'npc') this.npcAI(b, dt, ctx);
      else if (b.role === 'raider') this.raiderAI(b, dt, ctx);
      else { b.throttle = 0; b.rudder = 0; }
      if (b.sunk) { this.removeBoat(b); continue; }
      b.update(dt, ctx);
    }

    // jump animations (people/animals hopping aboard)
    for (let i = this.jumpers.length - 1; i >= 0; i--) {
      const j = this.jumpers[i];
      j.t += dt / j.dur;
      const t = Math.min(1, j.t);
      const p = j.who; const b = p.boat;
      if (!b) { this.jumpers.splice(i, 1); continue; }
      p.local.lerpVectors(j.from, j.to, t);
      p.mesh.position.set(p.local.x, j.from.y + (j.to.y - j.from.y) * t + Math.sin(Math.PI * t) * 1.6, p.local.z);
      if (p.animate) p.animate(dt, p.rig ? 'swim' : true);
      if (t >= 1) { p.jump = null; this.jumpers.splice(i, 1); }
    }
  }

  maintain(ctx) {
    const pl = this.game.fleet.player; const env = ctx.env; const level = ctx.water.level;
    // pickups
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      if (Math.hypot(p.x - pl.x, p.z - pl.z) > 900) { this.scene.remove(p.mesh); this.pickups.splice(i, 1); }
    }
    const nowH = env.elapsedDays * 24;
    const dh = this.lastHours === null ? 0 : Math.max(0, nowH - this.lastHours);
    this.lastHours = nowH;
    this.groupTimer -= dh; this.cacheTimer -= dh; this.derelictTimer -= dh; this.npcTimer -= dh;
    // at most one new piece of flotsam every ~12 s, so a picked-over area stays picked over for a while
    let tries = this.rng() < 0.08 ? 1 : 0;
    while (this.pickups.length < 14 && tries-- > 0) {
      const pt = this.randomWaterPoint(pl.x, pl.z, 160, 650, 0.8, 1.5, 4);
      if (pt) this.spawnPickup(pt.x, pt.z);
    }
    // survivor groups & caches on roofs near the waterline
    for (let i = this.groups.length - 1; i >= 0; i--) {
      const g = this.groups[i];
      if (Math.hypot(g.x - pl.x, g.z - pl.z) > 1400) this.removeGroup(g, i, true);
    }
    const roofGroups = this.groups.filter((g) => g.kind === 'roof').length;
    const wantGroup = roofGroups < 3 && this.groupTimer <= 0, wantCache = this.caches.length < 4 && this.cacheTimer <= 0;
    if (wantGroup || wantCache) {
      const cands = [];
      ctx.city.forEachNear(pl.x, pl.z, 1000, (c) => {
        if (c.used || !ROOF_KINDS.has(c.kind)) return;
        const t = c.roof.top;
        if (t < level + 0.6 || t > level + 12) return;
        // only where the water has actually reached: flooded buildings, or the waterfront itself
        if (c.base !== undefined && c.base > level + 0.4) return;
        const d = rectDistance(c.roof, pl.x, pl.z);
        if (d < 220 || d > 1000) return;
        cands.push(c);
      });
      if (cands.length) {
        const c = cands[Math.floor(this.rng() * cands.length)];
        if (wantGroup) { this.spawnSurvivorGroup(c); this.groupTimer = rand(this.rng, 3, 8); }
        else { this.spawnCache(c); this.cacheTimer = rand(this.rng, 2, 5); }
      }
    }
    if (this.groups.filter((g) => g.kind === 'float').length < 1 && this.rng() < 0.004) {
      const pt = this.randomWaterPoint(pl.x, pl.z, 300, 700, 2, 3, 6);
      if (pt) this.spawnSurvivorGroup(null, { x: pt.x, z: pt.z });
    }
    for (let i = this.caches.length - 1; i >= 0; i--) {
      const c = this.caches[i];
      if (Math.hypot(c.x - pl.x, c.z - pl.z) > 1400) { this.scene.remove(c.mesh); c.c.used = false; this.caches.splice(i, 1); }
    }

    // boats
    for (const b of [...this.boats]) {
      if (b.fleet) continue;
      const d = Math.hypot(b.x - pl.x, b.z - pl.z);
      if (b.role === 'moored') continue;
      if (d > 1500 || (b.role === 'raider' && b.ai.fleeing && d > 600)) this.removeBoat(b);
    }
    const free = this.boats.filter((b) => !b.fleet);
    const days = env.elapsedDays;
    if (free.filter((b) => b.role === 'derelict').length < 2 && this.derelictTimer <= 0) {
      this.derelictTimer = rand(this.rng, 6, 14);
      const kind = this.randomDerelictKind(days);
      const K = KINDS[kind];
      const pt = this.randomWaterPoint(pl.x, pl.z, 400, 900, K.draft[1] + 1.5, K.L[1] * 0.6 + 2, 8);
      if (pt) {
        const mods = [];
        if (this.rng() < 0.3) mods.push('storage');
        if (this.rng() < 0.25 && kind !== 'raider') mods.push('sail');
        const b = this.spawnBoat(kind, pt.x, pt.z, 'derelict', { modules: mods, hpFrac: rand(this.rng, 0.12, 0.4) });
        b.anchored = false;
      }
    }
    // other survivors on the move: most are passing through, a few might throw in with you
    if (free.filter((b) => b.role === 'npc').length < 3 && this.npcTimer <= 0) {
      this.npcTimer = rand(this.rng, 3, 9);
      const kind = pick(this.rng, ['rowboat', 'skiff', 'sailboat', 'fishing', 'houseboat', 'raft']);
      const pt = this.randomWaterPoint(pl.x, pl.z, 350, 700, KINDS[kind].draft[1] + 1.5, KINDS[kind].L[1] * 0.6 + 2, 6);
      if (pt) {
        const b = this.spawnBoat(kind, pt.x, pt.z, 'npc', { modules: this.rng() < 0.4 ? ['storage'] : [] });
        const n = randInt(this.rng, 1, Math.min(4, b.maxCrew));
        for (let i = 0; i < n; i++) b.addPerson(new Person(this.rng));
        if (this.rng() < 0.35) b.addAnimal(new Animal(this.rng, pick(this.rng, Object.keys(ANIMALS))));
        b.ai.wanderTimer = 0;
        b.ai.joinable = this.rng() < 0.25;
      }
    }
    // raiders
    this.raiderTimer -= env.timeScale;
    if (days > 7 && this.raiderTimer <= 0) {
      this.raiderTimer = rand(this.rng, 900, 2400) / (env.night > 0.5 ? 1.5 : 1);
      if (free.filter((b) => b.role === 'raider').length < 2) {
        const pt = this.randomWaterPoint(pl.x, pl.z, 400, 600, 1.5, 6, 8);
        if (pt) {
          const b = this.spawnBoat('raider', pt.x, pt.z, 'raider');
          const n = randInt(this.rng, 2, 3);
          for (let i = 0; i < n; i++) { const p = new Person(this.rng); b.addPerson(p); }
          b.ai.raid = 0;
          this.game.ui.toast('Engines on the horizon... a raider boat is closing in.', 'warn');
        }
      }
    }
  }

  npcAI(b, dt, ctx) {
    if (b.ai.seekPlayer) { // answering the radio: come alongside and wait to be hailed
      const pl = this.game.fleet.player;
      const d = Math.hypot(pl.x - b.x, pl.z - b.z);
      if (d < 25) { b.throttle = 0; b.rudder = 0; b.sailsUp = false; return; }
      steerBoat(b, pl.x, pl.z, d > 80 ? 5 : 2, ctx, dt, { fuelReserve: 0 });
      return;
    }
    b.ai.wanderTimer -= dt;
    if (!b.ai.target || b.ai.wanderTimer <= 0 || Math.hypot(b.ai.target.x - b.x, b.ai.target.z - b.z) < 15) {
      b.ai.target = this.randomWaterPoint(b.x, b.z, 200, 650, b.design.draft + 1, 3, 10) || this.randomWaterPoint(b.x, b.z, 60, 200, b.design.draft + 1, 3, 8) || { x: b.x, z: b.z };
      b.ai.wanderTimer = 150;
    }
    steerBoat(b, b.ai.target.x, b.ai.target.z, 2.2, ctx, dt, { fuelReserve: 0, preferSail: b.rigs.length > 0 });
  }

  raiderAI(b, dt, ctx) {
    const fleet = this.game.fleet;
    if (b.ai.fleeing) {
      const pl = fleet.player;
      const ax = b.x - pl.x, az = b.z - pl.z, l = Math.hypot(ax, az) || 1;
      steerBoat(b, b.x + ax / l * 100, b.z + az / l * 100, 9, ctx, dt, { fuelReserve: 0 });
      return;
    }
    // target: nearest fleet boat
    let best = null, bd = Infinity;
    for (const f of fleet.boats) { const d = Math.hypot(f.x - b.x, f.z - b.z); if (d < bd) { bd = d; best = f; } }
    if (!best) return;
    steerBoat(b, best.x, best.z, bd > 30 ? 8.5 : 3.5, ctx, dt, { fuelReserve: 0 });
    if (bd < best.L * 0.5 + b.L * 0.5 + 6) {
      b.ai.raid += dt;
      const deterred = (best.lightOn && ctx.env.night > 0.4) || best.crew.length >= 4 || best.count('armor') > 0 || fleet.boats.filter((f) => Math.hypot(f.x - b.x, f.z - b.z) < 40).length >= 3;
      if (deterred && b.ai.raid > 1.5) {
        b.ai.fleeing = true;
        this.game.ui.toast(`The raiders took one look at the ${best.name} and backed off.`, 'good');
      } else if (b.ai.raid > 4) {
        const res = pick(this.rng, ['food', 'water', 'fuel', 'scrap', 'parts', 'wood']);
        const taken = Math.ceil(fleet.inv[res] * 0.3);
        fleet.inv[res] -= taken;
        best.hurt(15, ctx, true);
        b.ai.fleeing = true;
        this.game.ui.toast(`Raiders boarded the ${best.name} and stole ${taken} ${res}!`, 'bad');
      }
    } else b.ai.raid = Math.max(0, b.ai.raid - dt);
  }

  removeGroup(g, i, keepRoof) {
    if (g.landmark && !g.landmark.rescued) g.landmark.groupSpawned = false;
    for (const p of g.people) this.scene.remove(p.mesh);
    for (const a of g.animals) this.scene.remove(a.mesh);
    this.scene.remove(g.extras);
    if (g.c && keepRoof) g.c.used = false;
    this.groups.splice(i, 1);
  }
  removeBoat(b) {
    const i = this.boats.indexOf(b); if (i >= 0) this.boats.splice(i, 1);
    if (b.fleet) b.fleet.remove(b);
    b.dispose(this.scene);
  }

  // ---------------- interactions ----------------
  /** Closest interactable for the player's boat: {kind, label, target}. */
  findInteraction() {
    const pl = this.game.fleet.player; if (!pl) return null;
    let best = null, bd = Infinity;
    if (this.game.onFoot) {
      const me = this.game.playerPerson;
      for (const a of me.boat ? me.boat.animals : []) {
        const d = Math.hypot(a.local.x - me.local.x, a.local.z - me.local.z);
        if (d < 1.4 && d < bd) { bd = d; best = { kind: 'pet', target: a, label: `[E] Pet the ${a.type}` }; }
      }
      if (best) return best;
    }
    const consider = (kind, target, d, label) => { if (d < bd) { bd = d; best = { kind, target, label }; } };
    for (const g of this.groups) {
      const d = g.state === 'roof' ? rectDistance(g.c.roof, pl.x, pl.z) - pl.B * 0.5 : Math.hypot(g.x - pl.x, g.z - pl.z) - pl.L * 0.5;
      if (d < 6) {
        const who = [g.people.length ? `${g.people.length} survivor${g.people.length > 1 ? 's' : ''}` : null, ...g.animals.map((a) => `a ${a.type}`)].filter(Boolean).join(' and ');
        consider('rescue', g, d, `[E] Rescue ${who}`);
      }
    }
    for (const c of this.caches) {
      const d = rectDistance(c.c.roof, pl.x, pl.z) - pl.B * 0.5;
      if (d < 6) consider('loot', c, d, '[E] Haul rooftop supplies aboard');
    }
    for (const b of this.boats) {
      if (b.fleet || b.sinking) continue;
      const d = Math.hypot(b.x - pl.x, b.z - pl.z) - (b.L + pl.L) * 0.5;
      if (d > 8) continue;
      if (b.role === 'derelict') consider('claim', b, d, `[E] Crew the abandoned ${b.design.label.toLowerCase()}  ·  [X] Salvage it`);
      else if (b.role === 'moored') consider('claim', b, d, `[E] Cast off and crew the ${b.mooring && b.mooring.pier ? 'tied-up' : 'anchored'} ${b.design.label.toLowerCase()}  ·  [X] Salvage it`);
      else if (b.role === 'npc') consider('hail', b, d, `[E] Hail the ${b.name} (${b.crew.length} aboard)`);
    }
    if (!best && this.game.landmarks) best = this.game.landmarks.findInteraction(pl);
    return best;
  }

  interact(salvage = false) {
    const it = this.findInteraction();
    if (!it) return;
    const fleet = this.game.fleet, pl = fleet.player, ui = this.game.ui;
    if (it.kind === 'landmark') { this.game.landmarks.interact(it.target); return; }
    if (it.kind === 'pet') {
      const a = it.target; a.happy = 4;
      const now = performance.now();
      if (!a.lastPet || now - a.lastPet > 60000) { fleet.morale = Math.min(100, fleet.morale + 1.5); a.lastPet = now; }
      ui.toast(pick(this.rng, [`The ${a.type} leans into your hand.`, `The ${a.type} looks very pleased about this.`, `You scratch the ${a.type} behind the ears. Things feel a little less grim.`]), 'good');
      return;
    }
    if (it.kind === 'rescue') {
      const g = it.target;
      const totalFree = fleet.boats.reduce((a, b) => a + Math.max(0, b.freeBerths), 0);
      if (g.people.length && totalFree < g.people.length) { ui.toast(`No room: ${totalFree} free berths in the floatilla. Build shelters or claim boats.`, 'warn'); return; }
      for (const p of g.people) {
        const b = pl.freeBerths > 0 ? pl : fleet.boats.find((x) => x.freeBerths > 0);
        const wp = p.mesh.position.clone();
        this.scene.remove(p.mesh);
        b.addPerson(p);
        if (b === pl) this.jump(p, b, wp);
      }
      for (const a of g.animals) {
        const wp = a.mesh.position.clone();
        this.scene.remove(a.mesh); pl.addAnimal(a); this.jump(a, pl, wp);
        fleet.stats.animals++;
      }
      fleet.stats.rescued += g.people.length;
      fleet.morale = Math.min(100, fleet.morale + 4 * g.people.length + 3 * g.animals.length);
      ui.toast(g.people.length ? `Rescued ${g.people.map((p) => p.name).join(', ')}${g.animals.length ? ` and a ${g.animals[0].type}` : ''}!` : `Rescued a ${g.animals[0].type}!`, 'good');
      this.game.audio.chime();
      if (g.landmark) g.landmark.rescued = true;
      g.people = []; g.animals = [];
      const i = this.groups.indexOf(g); this.removeGroup(g, i, false);
    } else if (it.kind === 'loot') {
      const c = it.target; const got = [];
      for (const [r, n] of Object.entries(c.loot)) if (n > 0) { const a = fleet.give(r, n); if (a > 0) got.push(`+${a} ${r}`); }
      ui.toast(`Rooftop cache: ${got.join(', ') || 'cargo full'}`, 'loot');
      this.game.audio.blip(520);
      this.scene.remove(c.mesh); this.caches.splice(this.caches.indexOf(c), 1);
    } else if (it.kind === 'claim') {
      const b = it.target;
      if (salvage) return this.salvage(b);
      const donor = this.spareCrew();
      if (!donor) { ui.toast('No spare crew to man her. Rescue more survivors — or press X to salvage.', 'warn'); return; }
      b.mooring = null; b.anchored = false;
      const wp = donor.mesh.getWorldPosition(new THREE.Vector3());
      const from = donor.boat; from.removePerson(donor);
      b.addPerson(donor); this.jump(donor, b, wp);
      for (const a of b.animals) void a;
      fleet.add(b); fleet.stats.boatsJoined++;
      ui.toast(`${donor.name} takes the helm of the ${b.name} (${b.design.label}). Your floatilla grows to ${fleet.boats.length}.`, 'good');
      this.game.audio.chime();
    } else if (it.kind === 'hail' && it.target.ai && it.target.ai.joinable === false) {
      const b = it.target;
      const LINES = ['"We\'re making for the hills — good luck out here!"', '"Seen people waving from the roofs east of the river."', '"The radio says the water won\'t stop till it\'s over the towers."', '"Watch yourselves at night. There are boats out here taking what they want."', '"Fuel\'s the thing. Find a marina before it\'s under."'];
      if (!b.ai.gifted) {
        b.ai.gifted = true;
        const res = pick(this.rng, ['food', 'water', 'fuel', 'cloth']), n = randInt(this.rng, 1, 3);
        const got = fleet.give(res, n);
        ui.toast(`${pick(this.rng, LINES)} They pass across ${got} ${res}.`, 'good');
      } else ui.toast(pick(this.rng, LINES), 'info');
      this.game.audio.blip(520);
    } else if (it.kind === 'hail') {
      const b = it.target;
      const ask = b.crew.length * 4;
      if (fleet.inv.food >= ask || fleet.morale > 80) {
        fleet.inv.food = Math.max(0, fleet.inv.food - ask);
        fleet.add(b); fleet.stats.boatsJoined++;
        fleet.stats.rescued += b.crew.length;
        ui.toast(`The ${b.name} joins the floatilla! (shared ${ask} food)`, 'good');
        this.game.audio.chime();
      } else ui.toast(`"We'd join you, but you can't feed us." They need ${ask} food.`, 'warn');
    }
  }

  salvage(b) {
    const fleet = this.game.fleet;
    const L = b.L, got = [];
    const loot = { wood: Math.round(L * 1.4), scrap: Math.round(L * 0.9), cloth: b.rigs.length * 4, parts: b.enginePower > 0 ? randInt(this.rng, 2, 4) : 0, fuel: b.enginePower > 0 ? randInt(this.rng, 0, 8) : 0 };
    for (const [r, n] of Object.entries(loot)) if (n > 0) { const a = fleet.give(r, n); if (a > 0) got.push(`+${a} ${r}`); }
    this.game.ui.toast(`Stripped the ${b.design.label.toLowerCase()}: ${got.join(', ') || 'cargo full'}`, 'loot');
    b.hp = 0; b.sinking = true;
    this.game.audio.blip(300);
  }

  spareCrew() {
    const fleet = this.game.fleet, pl = fleet.player;
    const cand = (b) => b.crew.find((p) => !p.isPlayer && !p.jump);
    if (pl.crew.filter((p) => !p.isPlayer).length >= 1) return cand(pl);
    for (const b of fleet.boats) if (b !== pl && b.crew.length >= 2 && Math.hypot(b.x - pl.x, b.z - pl.z) < 150) return cand(b);
    return null;
  }

  jump(who, boat, worldPos) {
    const from = boat.root.worldToLocal(worldPos.clone());
    who.jump = true;
    const to = who.local.clone(); to.y = boat.deckY;
    this.jumpers.push({ who, from, to, t: 0, dur: 0.9 });
  }
}
