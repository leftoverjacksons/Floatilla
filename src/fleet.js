import * as THREE from 'three';
import { clamp, angleDiff, damp } from './util.js';
import { KINDS, MODULES } from './boat.js';

export const RESOURCES = ['wood', 'scrap', 'cloth', 'parts', 'fuel', 'food', 'water'];
export const RES_LABEL = { wood: 'Wood', scrap: 'Scrap', cloth: 'Cloth', parts: 'Parts', fuel: 'Fuel', food: 'Food', water: 'Water' };

export const RECIPES = [
  { id: 'patch', label: 'Patch Hull', cost: { wood: 4, scrap: 2 }, desc: 'Restore 20 hull integrity now. Bigger hulls need more material.' },
  ...Object.keys(MODULES).map((m) => ({ id: m, module: m, label: MODULES[m].label, desc: MODULES[m].desc, cost: MODULE_COST(m) })),
  { id: 'lengthen', label: 'Lengthen Hull +1.5 m', cost: { wood: 30, scrap: 10 }, desc: 'Rebuilds the hull longer: more slots, berths, cargo, speed. Each extension costs more.' },
  { id: 'raft', label: 'Build Raft', cost: { wood: 40, cloth: 8 }, newBoat: 'raft', desc: 'New boat for the floatilla. Needs a spare crew member.' },
  { id: 'rowboat', label: 'Build Rowboat', cost: { wood: 65, scrap: 10 }, newBoat: 'rowboat', desc: 'New boat for the floatilla. Needs a spare crew member.' },
  { id: 'biofuel', label: 'Wood-gas Fuel', cost: { wood: 8 }, gives: { fuel: 3 }, desc: 'Crude gasifier: wood → 3 fuel.' },
  { id: 'boil', label: 'Boil Seawater', cost: { wood: 4 }, gives: { water: 4 }, desc: 'Burn wood to distil 4 water.' },
];

/**
 * Actual cost of a recipe for a given boat. Each repeat of the same module on a
 * boat costs 1.7x the previous one and bigger hulls need more material, so
 * fully kitting out one boat is a long project.
 */
export function recipeCost(r, boat) {
  let k = 1;
  if (r.module) k = Math.pow(1.7, boat.count(r.module)) * Math.max(1, Math.sqrt(boat.L / 6));
  else if (r.id === 'patch') k = Math.max(1, boat.maxHp / 120);
  else if (r.id === 'lengthen') k = Math.pow(1.5, boat.design.lengthened || 0);
  const out = {};
  for (const [res, n] of Object.entries(r.cost)) out[res] = Math.ceil(n * k);
  return out;
}
function MODULE_COST(m) {
  return {
    sail: { wood: 14, cloth: 18 }, engine: { scrap: 24, parts: 8 }, storage: { wood: 14 }, shelter: { wood: 18, cloth: 10 },
    armor: { scrap: 30 }, outrigger: { wood: 22, scrap: 6 }, net: { cloth: 10, scrap: 6 }, raincatch: { cloth: 6, scrap: 4 },
    still: { scrap: 10, cloth: 4 }, planter: { wood: 8, food: 6 }, light: { scrap: 10, parts: 4 },
  }[m];
}

// ---------------------------------------------------------------------------
// Shared AI steering (followers, NPC boats, raiders).
// ---------------------------------------------------------------------------
export function isBlocked(x, z, b, ctx) {
  const top = Math.max(ctx.floorMap.groundAt(x, z), ctx.city.topAt(x, z));
  return top > ctx.water.level - b.design.draft * 0.9;
}

const NO_GO = 48 * Math.PI / 180;   // closest a square-ish rig can point to the true wind
const TACK_ANGLE = 52 * Math.PI / 180;

/**
 * Pick a heading toward (tx, tz). Sail-only boats whose target lies inside the
 * no-go cone beat upwind on alternating tacks (close-hauled at TACK_ANGLE off
 * the wind), switching when the leg timer runs out, the target crosses the
 * layline onto the other side, or the current tack runs into an obstacle.
 */
function tackHeading(b, tx, tz, dist, ctx, dt, blocked) {
  const W = ctx.wind;
  const upwind = Math.atan2(-W.x, -W.y); // heading pointing into the wind
  const bearing = Math.atan2(tx - b.x, tz - b.z);
  const off = angleDiff(upwind, bearing); // + = target to the "right" of upwind (in heading terms)
  const ai = b.ai;
  if (Math.abs(off) > NO_GO || dist < 15) { ai.tacking = false; return null; }
  if (!ai.tacking) {
    ai.tacking = true;
    ai.tack = off >= 0 ? 1 : -1; // start on the tack that already makes progress toward the target
    ai.legTimer = 0;
  }
  ai.legTimer += dt;
  const legMax = clamp(dist / 4, 12, 45);
  // Layline: once the target sits beyond the opposite close-hauled line, the other tack fetches it.
  const pastLayline = ai.tack > 0 ? off < -TACK_ANGLE * 0.35 : off > TACK_ANGLE * 0.35;
  const heading = upwind + ai.tack * TACK_ANGLE;
  if ((ai.legTimer > legMax && Math.abs(off) < NO_GO * 0.8) || pastLayline || (ai.legTimer > 4 && blocked(heading))) {
    ai.tack = -ai.tack; ai.legTimer = 0;
  }
  return upwind + ai.tack * TACK_ANGLE;
}

export function steerBoat(b, tx, tz, desiredSpeed, ctx, dt, opts = {}) {
  const dx = tx - b.x, dz = tz - b.z, dist = Math.hypot(dx, dz);
  let desired = Math.atan2(dx, dz);
  const look = 5 + b.L * 0.6 + Math.max(0, b.forwardSpeed) * 2.2;
  const blocked = (ang) => {
    for (const f of [0.35, 0.7, 1]) if (isBlocked(b.x + Math.sin(ang) * look * f, b.z + Math.cos(ang) * look * f, b, ctx)) return true;
    return false;
  };
  const canEngine = b.enginePower > 0 && ctx.fuel(b) > (opts.fuelReserve ?? 0) && !opts.preferSail;
  b.noEngine = !canEngine;
  const sailing = b.rigs.length > 0 && !canEngine && ctx.env.windSpeed < 15 && ctx.env.windSpeed > 1 && desiredSpeed > 1;
  let tackH = null;
  if (sailing) tackH = tackHeading(b, tx, tz, dist, ctx, dt, blocked);
  else b.ai.tacking = false;
  if (tackH !== null) desired = tackH;
  if (dist > 3 && blocked(desired)) {
    for (const off of [0.35, -0.35, 0.7, -0.7, 1.1, -1.1, 1.6, -1.6, 2.2, -2.2]) {
      const o = off * (b.ai.sideBias || 1);
      if (!blocked(desired + o)) { desired += o; break; }
    }
  }
  const err = angleDiff(b.heading, desired);
  b.rudder = clamp(err * 2.2, -1, 1);
  const u = b.forwardSpeed;
  let thr = clamp((desiredSpeed - u) * 0.6 + desiredSpeed * 0.1, -0.6, 1);
  if (Math.abs(err) > 1.3 && dist < 25) thr = Math.min(thr, 0.35);
  if (b.rigs.length) {
    const W = ctx.wind;
    const wn = Math.hypot(W.x, W.y) + 1e-4;
    const cosA = (Math.sin(desired) * -W.x + Math.cos(desired) * -W.y) / wn;
    const alpha = Math.acos(clamp(cosA, -1, 1)) * 180 / Math.PI;
    b.sailsUp = (tackH !== null || alpha > 45) && ctx.env.windSpeed < 15 && desiredSpeed > 1 && dist > 12;
    if (b.sailsUp && !canEngine) {
      // Sail does the work. Only scull/paddle while the bow swings through the wind or the boat is nearly stopped.
      const inIrons = (b.sailDrive ?? 0) < 0.1 || u < 0.6;
      thr = inIrons ? 0.35 : 0;
    }
  }
  // Stuck recovery: reverse briefly with opposite rudder.
  if (thr > 0.3 && b.speed < 0.3) b.ai.stuck += dt; else b.ai.stuck = Math.max(0, b.ai.stuck - dt);
  if (b.ai.reverse > 0) {
    b.ai.reverse -= dt; thr = -0.8; b.rudder = -b.rudder;
  } else if (b.ai.stuck > 4) { b.ai.reverse = 2.5; b.ai.stuck = 0; b.ai.sideBias = -(b.ai.sideBias || 1); if (b.ai.tacking) { b.ai.tack = -b.ai.tack; b.ai.legTimer = 0; } }
  b.throttle = thr;
  return dist;
}

// ---------------------------------------------------------------------------
export class Fleet {
  constructor(game) {
    this.game = game;
    this.boats = [];
    this.player = null;
    this.inv = { wood: 6, scrap: 3, cloth: 2, parts: 0, fuel: 14, food: 14, water: 18 };
    this.mode = 'follow';
    this.detached = false;
    this.trail = [];
    this.morale = 65;
    this.stats = { rescued: 0, lost: 0, boatsJoined: 0, animals: 0 };
    this.starving = false; this.thirsty = false;
  }

  get capacity() { return this.boats.reduce((a, b) => a + b.capacity, 0) + 80; }
  get load() { return RESOURCES.reduce((a, r) => a + this.inv[r], 0); }
  get people() { return this.boats.flatMap((b) => b.crew); }
  get animals() { return this.boats.flatMap((b) => b.animals); }

  add(boat) {
    if (this.boats.includes(boat)) return;
    this.boats.push(boat); boat.fleet = this;
    if (boat !== this.player) boat.role = 'follower';
    boat.anchored = false;
    if (boat.flag) boat.flag.material = new THREE.MeshStandardMaterial({ color: 0xff7a1a, side: THREE.DoubleSide });
    this.game.world.claimBoat(boat);
  }
  remove(boat) {
    const i = this.boats.indexOf(boat); if (i >= 0) this.boats.splice(i, 1);
    boat.fleet = null;
  }

  /** Give resources; returns the amount actually stored. */
  give(res, amt) {
    const room = Math.max(0, this.capacity - this.load);
    const a = Math.min(amt, room);
    this.inv[res] += a;
    return a;
  }
  canAfford(cost) { return Object.entries(cost).every(([r, n]) => this.inv[r] >= n); }
  pay(cost) { for (const [r, n] of Object.entries(cost)) this.inv[r] -= n; }

  setPlayerBoat(boat) {
    const pp = this.game.playerPerson;
    const old = this.player;
    if (old === boat) return;
    if (old) { old.role = 'follower'; old.throttle = 0; old.rudder = 0; if (pp.boat === old) old.removePerson(pp); }
    this.player = boat; boat.role = 'player'; boat.anchored = false;
    if (pp.boat && pp.boat !== boat) pp.boat.removePerson(pp);
    boat.addPerson(pp);
    // the old player boat drops in line directly behind the new lead
    if (old) { this.boats.splice(this.boats.indexOf(old), 1); this.boats.splice(1, 0, old); }
    this.boats.splice(this.boats.indexOf(boat), 1); this.boats.unshift(boat);
    this.trail = [{ x: boat.x, z: boat.z }];
    this.game.camCtl.snapTo && this.game.camCtl.snapTo(boat);
  }

  cycleLead(dir = 1) {
    if (this.boats.length < 2) return null;
    // order by index, skip boats with no crew
    const order = this.boats.slice().sort((a, b) => a.design.seed - b.design.seed);
    let i = order.indexOf(this.player);
    for (let k = 0; k < order.length; k++) {
      i = (i + dir + order.length) % order.length;
      const b = order[i];
      if (b !== this.player && !b.sinking) { this.setPlayerBoat(b); return b; }
    }
    return null;
  }

  toggleDetach() {
    if (!this.detached) {
      this.detached = true;
      for (const b of this.boats) if (b !== this.player) b.anchored = true;
      return 'Detached. The floatilla drops anchor and waits. Press F again to call them to you.';
    }
    this.detached = false;
    this.trail = [{ x: this.player.x, z: this.player.z }];
    for (const b of this.boats) b.anchored = false;
    return 'Floatilla, form up! They will make their way to you.';
  }
  toggleHold() {
    this.mode = this.mode === 'follow' ? 'hold' : 'follow';
    for (const b of this.boats) if (b !== this.player) b.anchored = this.mode === 'hold' || this.detached;
    return this.mode === 'hold' ? 'All boats: hold position.' : 'All boats: follow the lead.';
  }

  trailPoint(back) {
    const t = this.trail; const p = this.player;
    let px = p.x, pz = p.z, acc = 0;
    for (let i = t.length - 1; i >= 0; i--) {
      const sx = t[i].x, sz = t[i].z;
      const seg = Math.hypot(px - sx, pz - sz);
      if (acc + seg >= back) { const f = (back - acc) / (seg || 1); return { x: px + (sx - px) * f, z: pz + (sz - pz) * f, ok: true }; }
      acc += seg; px = sx; pz = sz;
    }
    return { x: px, z: pz, ok: false };
  }

  update(dt, ctx, gameHours) {
    const lead = this.player;
    if (!lead) return;
    // breadcrumb trail
    const last = this.trail[this.trail.length - 1];
    if (!last || Math.hypot(lead.x - last.x, lead.z - last.z) > 1.5) {
      this.trail.push({ x: lead.x, z: lead.z });
      if (this.trail.length > 2500) this.trail.splice(0, 500);
    }
    let back = lead.L * 0.5 + 6;
    for (const b of this.boats) {
      if (b === lead || b.sinking) continue;
      back += b.L * 0.5;
      const myBack = back;
      back += b.L * 0.5 + 7;
      if (b.crew.length === 0) { b.throttle = 0; b.anchored = true; continue; }
      if (this.detached || this.mode === 'hold') { b.throttle = 0; b.rudder = 0; b.sailsUp = false; b.anchored = true; continue; }
      b.anchored = false;
      const tp = this.trailPoint(myBack);
      const dTarget = Math.hypot(tp.x - b.x, tp.z - b.z);
      let tx, tz, spd;
      if (!tp.ok && dTarget < 25) { tx = tp.x; tz = tp.z; spd = 0; }
      else if (dTarget > 90) { // too far from the trail: head for the lead directly
        tx = lead.x; tz = lead.z; spd = 9;
      } else {
        const look = this.trailPoint(Math.max(0, myBack - (8 + b.L)));
        tx = look.x; tz = look.z;
        const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
        const ahead = (tp.x - b.x) * fx + (tp.z - b.z) * fz;
        spd = clamp(lead.speed + ahead * 0.3, 0, 11);
        if (dTarget < 3 && lead.speed < 0.5) spd = 0;
      }
      steerBoat(b, tx, tz, spd, ctx, dt, { fuelReserve: 4 });
      if (spd === 0 && dTarget < 6) { b.throttle = 0; b.sailsUp = false; }
    }
    this.economy(gameHours, ctx);
  }

  economy(dh, ctx) {
    const env = ctx.env;
    const people = this.people, animals = this.animals;
    const n = people.length;
    // consumption
    const foodNeed = (n * 1.2 + animals.reduce((a, x) => a + x.def.food * 24, 0)) / 24 * dh;
    const waterNeed = n * 2.0 / 24 * dh;
    this.starving = this.inv.food < foodNeed; this.thirsty = this.inv.water < waterNeed;
    this.inv.food = Math.max(0, this.inv.food - foodNeed);
    this.inv.water = Math.max(0, this.inv.water - waterNeed);
    for (const p of people) {
      if (this.thirsty) p.health -= 4 * dh;
      else if (this.starving) p.health -= 2 * dh;
      else p.health = Math.min(100, p.health + 3 * dh);
    }
    // production & repairs
    const moraleK = 0.6 + this.morale / 125;
    const day = env.dayFactor;
    let shelters = 0;
    for (const b of this.boats) {
      const tc = b.taskCounts || {};
      const net = b.count('net');
      this.give('food', (tc.fish || 0) * 0.15 * (1 + net * 0.9) * moraleK * dh);
      this.give('water', b.count('raincatch') * env.rainAmt * 3.0 * dh + b.count('still') * day * 0.45 * dh);
      this.give('food', b.count('planter') * day * 0.3 * dh);
      for (const a of b.animals) if (a.def.produces) this.give('food', a.def.produces * dh);
      shelters += b.count('shelter');
      if ((tc.repair || 0) > 0 && b.hp < b.maxHp && !b.sinking) {
        const amount = Math.min(b.maxHp - b.hp, tc.repair * 5 * dh * moraleK);
        const res = this.inv.wood >= this.inv.scrap ? 'wood' : 'scrap';
        const cost = amount * 0.15;
        if (this.inv[res] >= cost) { this.inv[res] -= cost; b.hp += amount; }
      }
    }
    // morale
    let target = 55 + Math.min(20, animals.length * 4) + Math.min(10, shelters * 3) + Math.min(10, this.boats.length * 2);
    if (this.starving) target -= 25; if (this.thirsty) target -= 35;
    if (env.state === 'storm') target -= 12;
    if (env.night > 0.5 && !this.boats.some((b) => b.lightOn)) target -= 4;
    this.morale += (clamp(target, 5, 100) - this.morale) * clamp(dh * 0.15, 0, 1);
  }
}

export { KINDS };
