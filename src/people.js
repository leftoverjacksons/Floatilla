import * as THREE from 'three';
import { pick, rand, FIRST_NAMES, damp, mulberry32 } from './util.js';
import { makeCard } from './crew.js';

const SKIN = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0x6b4226];
const SHIRTS = [0x2e6da4, 0x7a2e2e, 0x3d7a3d, 0x8a6d2e, 0x555a66, 0x9b4f8a, 0x2e8a86, 0xb5651d, 0x444444];
const PANTS = [0x2b2f3a, 0x3b3226, 0x4a4f5a, 0x1f2b44, 0x5a4a3a];
const HAIR = [0x1a1410, 0x3b2a1a, 0x7a5a32, 0xc8a560, 0x888888, 0x4a2a1a];

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const headGeo = new THREE.SphereGeometry(1, 10, 8);
const matCache = new Map();
function mat(hex) {
  let m = matCache.get(hex);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85 }); matCache.set(hex, m); }
  return m;
}
function part(parent, hex, sx, sy, sz, x, y, z) {
  const m = new THREE.Mesh(boxGeo, mat(hex)); m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  m.castShadow = true; parent.add(m); return m;
}

/** Simple segmented figure ~1.75 m tall; origin at the feet, facing +z. */
export function makePersonMesh(rng, opts = {}) {
  const g = new THREE.Group();
  const shirt = opts.shirt ?? pick(rng, SHIRTS), pants = pick(rng, PANTS), skin = pick(rng, SKIN), hair = pick(rng, HAIR);
  const hips = new THREE.Group(); hips.position.y = 0.9; g.add(hips);
  const legL = new THREE.Group(); legL.position.set(0.1, 0, 0); hips.add(legL);
  const legR = new THREE.Group(); legR.position.set(-0.1, 0, 0); hips.add(legR);
  part(legL, pants, 0.15, 0.88, 0.17, 0, -0.44, 0);
  part(legR, pants, 0.15, 0.88, 0.17, 0, -0.44, 0);
  const torso = new THREE.Group(); hips.add(torso);
  part(torso, shirt, 0.42, 0.58, 0.25, 0, 0.3, 0);
  if (opts.vest) part(torso, opts.vest, 0.46, 0.4, 0.29, 0, 0.36, 0);
  const head = new THREE.Group(); head.position.y = 0.72; torso.add(head);
  const hm = new THREE.Mesh(headGeo, mat(skin)); hm.scale.setScalar(0.13); hm.position.y = 0.1; hm.castShadow = true; head.add(hm);
  const hr = new THREE.Mesh(headGeo, mat(hair)); hr.scale.set(0.135, 0.09, 0.135); hr.position.set(0, 0.16, -0.015); head.add(hr);
  if (opts.hat) part(head, opts.hat, 0.3, 0.06, 0.3, 0, 0.22, 0), part(head, opts.hat, 0.2, 0.1, 0.2, 0, 0.27, 0);
  const armL = new THREE.Group(); armL.position.set(0.27, 0.56, 0); torso.add(armL);
  const armR = new THREE.Group(); armR.position.set(-0.27, 0.56, 0); torso.add(armR);
  part(armL, shirt, 0.11, 0.56, 0.12, 0, -0.27, 0);
  part(armR, shirt, 0.11, 0.56, 0.12, 0, -0.27, 0);
  return { group: g, hips, legL, legR, torso, head, armL, armR };
}

export class Person {
  constructor(rng, opts = {}) {
    // Appearance comes from a per-person seed so a saved crew looks the same after loading.
    this.seed = opts.seed ?? Math.floor(rng() * 1e9);
    const look = mulberry32(this.seed);
    this.rng = rng;
    this.name = opts.name || pick(look, FIRST_NAMES);
    this.isPlayer = !!opts.isPlayer;
    this.health = opts.health ?? 100;
    this.card = opts.card ? JSON.parse(JSON.stringify(opts.card)) : makeCard(this.seed, { captain: this.isPlayer });
    this.skill = opts.skill ?? { repair: rand(look, 0.6, 1.4), fish: rand(look, 0.6, 1.4), sail: rand(look, 0.6, 1.4) };
    this.rig = makePersonMesh(look, opts.isPlayer ? { shirt: 0x24476b, vest: 0xff7a1a, hat: 0xd9b44a } : {});
    this.mesh = this.rig.group;
    this.task = 'idle';
    this.local = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.phase = rand(rng, 0, 10);
    this.boat = null;
    this.jump = null; // {from: Vector3 world, t}
    this.state = 'aboard';
  }

  /** Per-frame pose. `moving` is set when walking on deck. */
  animate(dt, kind) {
    const r = this.rig; this.phase += dt;
    const p = this.phase;
    let legL = 0, legR = 0, armL = 0, armR = 0, armLz = 0, armRz = 0, bend = 0, hipsY = 0.9, lie = 0, headY = 0;
    switch (kind) {
      case 'walk': legL = Math.sin(p * 8) * 0.6; legR = -legL; armL = -legL * 0.7; armR = legL * 0.7; break;
      case 'wave': armL = Math.PI * 0.95; armLz = Math.sin(p * 9) * 0.35 + 0.2; armR = Math.sin(p * 4) > 0.3 ? Math.PI * 0.9 : 0.2; armRz = -0.2; break;
      case 'helm': armL = 0.9 + Math.sin(p * 0.9) * 0.1; armR = 0.9 - Math.sin(p * 0.9) * 0.1; headY = Math.sin(p * 0.4) * 0.3; break;
      case 'row': { const s = Math.sin(p * 3); bend = 0.35 + s * 0.25; armL = armR = 1.2 + s * 0.5; hipsY = 0.45; legL = legR = 1.4; break; }
      case 'fish': armL = 0.6; armR = 0.6 + Math.sin(p * 0.7) * 0.05; hipsY = 0.45; legL = legR = 1.5; bend = 0.15; break;
      case 'repair': bend = 0.7; armR = 1.1 + Math.abs(Math.sin(p * 6)) * 0.8; armL = 0.8; legL = 0.2; legR = -0.4; hipsY = 0.75; break;
      case 'trim': armL = 1.6 + Math.sin(p * 1.2) * 0.3; armR = 1.3 - Math.sin(p * 1.2) * 0.3; bend = -0.1; break;
      case 'lookout': armR = 2.6; armRz = 0.3; headY = Math.sin(p * 0.5) * 0.9; break;
      case 'bail': bend = 0.9 + Math.sin(p * 3) * 0.3; armL = armR = 1.4 + Math.sin(p * 3) * 0.6; hipsY = 0.8; break;
      case 'sleep': lie = 1; break;
      case 'sit': hipsY = 0.45; legL = legR = 1.5; armL = armR = 0.2; break;
      case 'swim': hipsY = 0.9; armL = Math.PI * 0.8 + Math.sin(p * 5) * 0.4; armR = Math.PI * 0.8 - Math.sin(p * 5) * 0.4; legL = Math.sin(p * 6) * 0.4; legR = -legL; break;
      default: armL = armR = 0.05 + Math.sin(p * 1.3) * 0.03; headY = Math.sin(p * 0.3) * 0.5;
    }
    const k = damp(10, dt);
    r.legL.rotation.x += (-legL - r.legL.rotation.x) * k;
    r.legR.rotation.x += (-legR - r.legR.rotation.x) * k;
    r.armL.rotation.x += (-armL - r.armL.rotation.x) * k;
    r.armR.rotation.x += (-armR - r.armR.rotation.x) * k;
    r.armL.rotation.z += (armLz - r.armL.rotation.z) * k;
    r.armR.rotation.z += (armRz - r.armR.rotation.z) * k;
    r.torso.rotation.x += (bend - r.torso.rotation.x) * k;
    r.head.rotation.y += (headY - r.head.rotation.y) * k;
    r.hips.position.y += ((lie ? 0.15 : hipsY) - r.hips.position.y) * k;
    r.hips.rotation.x += ((lie ? -Math.PI / 2 : 0) - r.hips.rotation.x) * k;
  }
}

// ---- Animals ---------------------------------------------------------------
export const ANIMALS = {
  dog: { label: 'dog', body: [0.3, 0.3, 0.7], legH: 0.35, head: 0.22, colors: [0x7a5230, 0x2a2420, 0xc9a26b, 0xeeeeee], food: 0.02, morale: 6 },
  cat: { label: 'cat', body: [0.18, 0.18, 0.42], legH: 0.18, head: 0.15, colors: [0xd08a3a, 0x333333, 0x999999, 0xf2f2f2], food: 0.01, morale: 5 },
  goat: { label: 'goat', body: [0.35, 0.4, 0.8], legH: 0.45, head: 0.24, colors: [0xe8e2d0, 0x6b5a48, 0x3a3330], food: 0.02, morale: 3, produces: 0.12 },
  chicken: { label: 'chicken', body: [0.18, 0.22, 0.26], legH: 0.15, head: 0.1, colors: [0xf4f0e6, 0xa0522d, 0x222222], food: 0.005, morale: 2, produces: 0.07 },
  sheep: { label: 'sheep', body: [0.45, 0.45, 0.85], legH: 0.4, head: 0.22, colors: [0xf2efe6, 0xdedad0], food: 0.02, morale: 3, produces: 0.04 },
};

export class Animal {
  constructor(rng, type, seed) {
    this.seed = seed ?? Math.floor(rng() * 1e9);
    this.type = type; this.def = ANIMALS[type]; this.rng = rng;
    this.local = new THREE.Vector3(); this.target = new THREE.Vector3(); this.phase = rand(rng, 0, 10);
    this.boat = null; this.state = 'aboard'; this.jump = null;
    const d = this.def, col = pick(mulberry32(this.seed), d.colors);
    const g = new THREE.Group();
    const body = new THREE.Mesh(boxGeo, mat(col)); body.scale.set(...d.body); body.position.y = d.legH + d.body[1] / 2; body.castShadow = true; g.add(body);
    const head = new THREE.Mesh(boxGeo, mat(col)); head.scale.setScalar(d.head); head.position.set(0, d.legH + d.body[1] * 0.95, d.body[2] / 2 + d.head * 0.3); g.add(head);
    this.legs = [];
    for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      if (type === 'chicken' && sz < 0) continue;
      const lg = new THREE.Group(); lg.position.set(sx * d.body[0] * 0.35, d.legH, sz * d.body[2] * 0.35 * (type === 'chicken' ? 0 : 1)); g.add(lg);
      const l = new THREE.Mesh(boxGeo, mat(type === 'chicken' ? 0xe0a030 : col)); l.scale.set(0.06 + d.body[0] * 0.1, d.legH, 0.07); l.position.y = -d.legH / 2; lg.add(l);
      this.legs.push(lg);
    }
    if (type === 'dog' || type === 'cat') {
      const tail = new THREE.Mesh(boxGeo, mat(col)); tail.scale.set(0.05, 0.05, d.body[2] * 0.5); tail.position.set(0, d.legH + d.body[1], -d.body[2] * 0.6); tail.rotation.x = 0.6; g.add(tail); this.tail = tail;
    }
    if (type === 'chicken') { const comb = new THREE.Mesh(boxGeo, mat(0xcc2222)); comb.scale.set(0.03, 0.06, 0.08); comb.position.set(0, d.head * 0.6, 0); head.add(comb); }
    this.mesh = g; this.headMesh = head;
  }
  animate(dt, moving) {
    this.phase += dt;
    const s = moving ? Math.sin(this.phase * 10) * 0.5 : 0;
    this.legs.forEach((l, i) => { l.rotation.x = (i % 2 ? s : -s); });
    if (this.happy > 0) this.happy -= dt;
    if (this.tail) this.tail.rotation.y = Math.sin(this.phase * (this.happy > 0 ? 26 : this.type === 'dog' ? 12 : 2)) * (this.happy > 0 ? 0.8 : 0.5);
    this.headMesh.rotation.y = Math.sin(this.phase * 0.5) * 0.4;
  }
}
