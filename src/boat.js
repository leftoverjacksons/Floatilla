import * as THREE from 'three';
import { rand, pick, clamp, lerp, angleDiff, damp, mulberry32, boatName } from './util.js';

// ---------------------------------------------------------------------------
// Boat archetypes. Ranges are sampled per boat so each hull is unique.
// L length, B beam, draft/fb in metres; bow = bow sharpness (0 blunt..1 fine);
// n = section superellipse exponent (2 round .. 10 boxy); engine in hp.
// ---------------------------------------------------------------------------
export const KINDS = {
  raft: { label: 'Raft', L: [3.6, 5], B: [2.6, 3.2], draft: [0.25, 0.3], fb: [0.3, 0.35], bow: [0, 0], vee: [0, 0], n: [40, 40], engine: [0, 0], open: true, sheer: [0, 0] },
  rowboat: { label: 'Rowboat', L: [3.6, 4.8], B: [1.4, 1.7], draft: [0.3, 0.38], fb: [0.45, 0.55], bow: [0.75, 0.95], vee: [0.3, 0.5], n: [2.2, 3], engine: [0, 0], open: true, sheer: [0.15, 0.3] },
  skiff: { label: 'Skiff', L: [4.8, 6.4], B: [1.9, 2.3], draft: [0.35, 0.45], fb: [0.6, 0.72], bow: [0.65, 0.9], vee: [0.5, 0.7], n: [2.5, 4], engine: [15, 30], open: true, planing: true, sheer: [0.15, 0.3] },
  sailboat: { label: 'Sloop', L: [7, 11], B: [2.5, 3.4], draft: [0.9, 1.3], fb: [0.8, 1.0], bow: [0.85, 1], vee: [0.6, 0.8], n: [2.2, 2.8], engine: [6, 12], masts: 1, sheer: [0.2, 0.35] },
  fishing: { label: 'Trawler', L: [8, 12], B: [3, 3.8], draft: [1.0, 1.4], fb: [1.0, 1.3], bow: [0.7, 0.9], vee: [0.4, 0.6], n: [2.5, 3.2], engine: [60, 110], sheer: [0.5, 0.8] },
  tug: { label: 'Tug', L: [10, 13], B: [4, 4.8], draft: [1.6, 2.0], fb: [1.1, 1.4], bow: [0.4, 0.6], vee: [0.3, 0.4], n: [2.4, 3.2], engine: [220, 320], sheer: [0.5, 0.7] },
  yacht: { label: 'Motor Yacht', L: [12, 17], B: [3.8, 4.8], draft: [1.0, 1.3], fb: [1.4, 1.8], bow: [0.9, 1], vee: [0.5, 0.7], n: [2.6, 3.4], engine: [180, 320], planing: true, sheer: [0.3, 0.5] },
  houseboat: { label: 'Houseboat', L: [9, 13], B: [3.6, 4.4], draft: [0.5, 0.7], fb: [0.5, 0.7], bow: [0.1, 0.35], vee: [0, 0.15], n: [6, 10], engine: [25, 50], sheer: [0, 0.1] },
  barge: { label: 'Barge', L: [14, 20], B: [5, 6.5], draft: [0.9, 1.2], fb: [0.8, 1.1], bow: [0, 0.2], vee: [0, 0.05], n: [8, 12], engine: [0, 0], sheer: [0, 0.1] },
  schooner: { label: 'Schooner', L: [16, 22], B: [4.2, 5.2], draft: [1.8, 2.4], fb: [1.2, 1.5], bow: [0.92, 1], vee: [0.5, 0.7], n: [2.2, 2.8], engine: [0, 40], masts: 2, sheer: [0.4, 0.7] },
  raider: { label: 'Raider', L: [5.5, 7.5], B: [2.1, 2.6], draft: [0.4, 0.5], fb: [0.6, 0.75], bow: [0.7, 0.9], vee: [0.6, 0.8], n: [3, 4], engine: [60, 90], open: true, planing: true, sheer: [0.2, 0.3] },
};

export const MODULES = {
  sail: { label: 'Mast & Sail', slot: true, max: 2, desc: 'Wind propulsion. Free, but no-go within ~35° of the wind.' },
  engine: { label: 'Outboard Motor', slot: false, max: 2, desc: '+25 hp. Burns fuel.' },
  storage: { label: 'Storage Crates', slot: true, max: 4, desc: '+40 fleet cargo capacity.' },
  shelter: { label: 'Shelter', slot: true, max: 3, desc: '+2 berths, crew rest better.' },
  armor: { label: 'Armor Plating', slot: false, max: 2, desc: '+60 max hull; raiders think twice.' },
  outrigger: { label: 'Outriggers', slot: false, max: 1, desc: 'Stability in swell, +1 berth.' },
  net: { label: 'Fishing Net & Boom', slot: true, max: 1, desc: 'Fishers catch more; auto-collect wider.' },
  raincatch: { label: 'Rain Catcher', slot: true, max: 2, desc: 'Collects drinking water in rain.' },
  still: { label: 'Solar Still', slot: true, max: 2, desc: 'Slowly makes water in sunlight.' },
  planter: { label: 'Planter Boxes', slot: true, max: 3, desc: 'Grows a little food by day.' },
  light: { label: 'Searchlight', slot: true, max: 1, desc: 'Light the night (L). Deters raiders.' },
};

const HULL_PALETTES = [
  [0xf2f2ee, 0x1f3f6b], [0x1f3f6b, 0xf2f2ee], [0xa8322a, 0xf2f2ee], [0x2f5a3a, 0xe8d8a8], [0xe8d8a8, 0x7a3a22],
  [0x6b4a2e, 0xd8c8a0], [0xd8a020, 0x222222], [0x3a6b8a, 0xffffff], [0xf2f2ee, 0x2a8a7a], [0x444b52, 0xd8a020],
];
const WOOD = [0x8a6a44, 0x9c7a50, 0x7a5a38, 0xa88a60];
const CLOTH = [0xf2eee2, 0xe8dcc0, 0xc85a3a, 0xd8b860, 0x8aa0b8];

export function randomDesign(rng, kind) {
  const K = KINDS[kind];
  const r = (a) => rand(rng, a[0], a[1]);
  const [hull, trim] = kind === 'raider' ? [0x26282a, 0x8a2a1a] : pick(rng, HULL_PALETTES);
  const d = {
    kind, label: K.label, seed: Math.floor(rng() * 1e9), name: boatName(rng),
    length: r(K.L), beam: r(K.B), draft: r(K.draft), freeboard: r(K.fb), bowSharp: r(K.bow), vee: r(K.vee), n: r(K.n),
    sheer: r(K.sheer), sternFull: rand(rng, 0.7, 0.95), engine: Math.round(r(K.engine)), masts: K.masts || 0,
    open: !!K.open, planing: !!K.planing,
    hullColor: kind === 'schooner' ? pick(rng, WOOD) : hull, trimColor: trim,
    bottomColor: pick(rng, [0x6e2a22, 0x22303e, 0x2a3a2a]), deckColor: pick(rng, WOOD), clothColor: pick(rng, CLOTH),
  };
  if (kind === 'raft') { d.sternFull = 1; }
  return d;
}

// ---------------------------------------------------------------------------
// Hull lofting
// ---------------------------------------------------------------------------
function hullProfile(d, u) {
  let w = 1;
  const bowStart = 0.5;
  if (u > bowStart) { const t = (u - bowStart) / (1 - bowStart); w = 1 - Math.pow(t, 2.2 - d.bowSharp) * (0.3 + 0.68 * d.bowSharp); }
  if (u < 0.15) { const t = (0.15 - u) / 0.15; w *= 1 - t * t * (1 - d.sternFull); }
  const hw = Math.max(0.02, d.beam * 0.5 * w);
  const top = d.freeboard + d.sheer * Math.pow(u, 3) + d.sheer * 0.25 * Math.pow(1 - u, 3);
  let bot = -d.draft;
  if (u > 0.6) { const t = (u - 0.6) / 0.4; bot = -d.draft * (1 - t * t * (0.3 + 0.55 * d.bowSharp)); }
  if (u < 0.1) { const t = (0.1 - u) / 0.1; bot = -d.draft * (1 - t * 0.2); }
  return { hw, top, bot };
}
function sectionPoint(d, prof, s) {
  const th = s * Math.PI / 2, e = 2 / d.n;
  const c = Math.max(Math.cos(th), 0), sn = Math.max(Math.sin(th), 0);
  const x = prof.hw * Math.pow(c, e);
  const se = Math.pow(sn, e);
  let y = prof.top - (prof.top - prof.bot) * se;
  y += d.vee * (x / prof.hw) * (prof.top - prof.bot) * 0.35 * se;
  return [x, Math.min(y, prof.top)];
}

function buildHullGeometry(d) {
  const N = 28, M = 10, L = d.length;
  const pos = [], col = [], idx = [];
  const cHull = new THREE.Color(d.hullColor), cTrim = new THREE.Color(d.trimColor), cBot = new THREE.Color(d.bottomColor);
  const sections = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, prof = hullProfile(d, u), z = (u - 0.5) * L;
    const pts = [];
    for (let j = 0; j <= 2 * M; j++) {
      const s = j <= M ? j / M : (2 * M - j) / M;
      const [x, y] = sectionPoint(d, prof, s);
      pts.push([j <= M ? x : -x, y]);
      pos.push(j <= M ? x : -x, y, z);
      let c = cHull;
      if (y < 0.06) c = cBot; else if (y < 0.2) c = cTrim; else if (y > prof.top - 0.1) c = cTrim;
      col.push(c.r, c.g, c.b);
    }
    sections.push({ u, z, prof, pts });
  }
  const W = 2 * M + 1;
  for (let i = 0; i < N; i++) for (let j = 0; j < 2 * M; j++) {
    const a = i * W + j, b = (i + 1) * W + j, c = (i + 1) * W + j + 1, e = i * W + j + 1;
    idx.push(a, b, c, a, c, e);
  }
  // Transom (and blunt bow) caps.
  const cap = (sec, sign) => {
    if (sec.prof.hw < 0.12) return;
    const base = pos.length / 3;
    let cy = 0; sec.pts.forEach((p) => (cy += p[1])); cy /= sec.pts.length;
    pos.push(0, cy, sec.z); col.push(cHull.r, cHull.g, cHull.b);
    sec.pts.forEach(([x, y]) => { pos.push(x, y, sec.z); const c = y < 0.06 ? cBot : cHull; col.push(c.r, c.g, c.b); });
    for (let j = 0; j < sec.pts.length - 1; j++) {
      if (sign < 0) idx.push(base, base + 2 + j, base + 1 + j); else idx.push(base, base + 1 + j, base + 2 + j);
    }
    // close across the top
    if (sign < 0) idx.push(base, base + 1, base + sec.pts.length); else idx.push(base, base + sec.pts.length, base + 1);
  };
  cap(sections[0], -1); cap(sections[N], 1);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return { geo, sections };
}

/** Deck/floor surface: at height y, bounded by the hull's inner width at that height. */
function buildDeckGeometry(d, sections, deckY) {
  const pos = [], idx = [], uv = [], profile = [];
  let rows = 0;
  for (const s of sections) {
    const y = Math.min(deckY, s.prof.top - 0.06);
    // walk port half from gunwale to keel; find crossing of y
    let w = 0;
    const half = s.pts.slice(0, Math.floor(s.pts.length / 2) + 1);
    for (let j = 0; j < half.length - 1; j++) {
      const [x0, y0] = half[j], [x1, y1] = half[j + 1];
      if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) { w = x0 + (x1 - x0) * (y - y0) / (y1 - y0); break; }
      if (j === 0 && y >= y0) { w = x0; break; }
    }
    w = Math.max(0, w - 0.02);
    profile.push({ z: s.z, w, y });
    pos.push(w, y, s.z, -w, y, s.z);
    uv.push(w / 1.2, s.z / 4, -w / 1.2, s.z / 4);
    rows++;
  }
  for (let i = 0; i < rows - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx); geo.computeVertexNormals();
  geo.userData.profile = profile;
  return geo;
}

/**
 * Invisible lid across the hull opening at gunwale height. It writes depth only
 * and is drawn after the boat but before the water, so the water surface cannot
 * show through the inside of an open hull.
 */
function buildWaterMask(sections) {
  const pos = [], idx = [];
  sections.forEach((s, i) => {
    const hw = s.prof.hw, top = s.prof.top - 0.02;
    pos.push(hw, top, s.z, -hw, top, s.z);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 3, a, a + 3, a + 2); }
  });
  // close the transom and blunt bows with a fan so the lid has no gaps
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  return geo;
}
export const WATER_MASK_MAT = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, side: THREE.DoubleSide });

// Procedural plank texture for decks (canvas, tinted by the material colour).
let PLANK_TEX = null;
function plankTexture() {
  if (PLANK_TEX) return PLANK_TEX;
  const c = document.createElement('canvas'); c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#d8d8d8'; g.fillRect(0, 0, 256, 256);
  const n = 8, w = 256 / n;
  for (let i = 0; i < n; i++) {
    const shade = 200 + Math.floor(Math.random() * 50);
    g.fillStyle = `rgb(${shade},${shade},${shade})`; g.fillRect(i * w + 1, 0, w - 2, 256);
    for (let k = 0; k < 14; k++) { // grain
      g.strokeStyle = `rgba(90,90,90,${0.05 + Math.random() * 0.08})`; g.lineWidth = 1;
      const x = i * w + 2 + Math.random() * (w - 4);
      g.beginPath(); g.moveTo(x, 0); g.bezierCurveTo(x + 3, 80, x - 3, 170, x + 1, 256); g.stroke();
    }
    g.fillStyle = 'rgba(40,40,40,0.55)'; g.fillRect(i * w, 0, 1.5, 256); // seams
    const off = Math.random() * 256; g.fillRect(i * w, off, w, 1.5); // butt joint
  }
  PLANK_TEX = new THREE.CanvasTexture(c);
  PLANK_TEX.wrapS = PLANK_TEX.wrapT = THREE.RepeatWrapping;
  PLANK_TEX.colorSpace = THREE.SRGBColorSpace;
  PLANK_TEX.anisotropy = 8;
  return PLANK_TEX;
}

// ---------------------------------------------------------------------------
// Small mesh helpers
// ---------------------------------------------------------------------------
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10);
const mats = new Map();
function M(hex, opts = {}) {
  const { map, ...rest } = opts;
  const key = hex + JSON.stringify(rest) + (map ? map.uuid : '');
  let m = mats.get(key);
  if (!m) { m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, ...opts }); mats.set(key, m); }
  return m;
}
function box(parent, hex, sx, sy, sz, x, y, z, opts) {
  const m = new THREE.Mesh(BOX, M(hex, opts)); m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function cyl(parent, hex, r, h, x, y, z, opts) {
  const m = new THREE.Mesh(CYL, M(hex, opts)); m.scale.set(r, h, r); m.position.set(x, y, z);
  m.castShadow = true; parent.add(m); return m;
}
const WINDOW = 0x18222c;

function makeSailGeometry() {
  const g = new THREE.PlaneGeometry(1, 1, 6, 10);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const px = p.getX(i) + 0.5, py = p.getY(i) + 0.5;
    p.setXYZ(i, Math.sin(Math.PI * Math.min(px, 1)) * Math.pow(1 - py, 0.5), py, -px * (1 - py * 0.92));
  }
  g.computeVertexNormals();
  return g;
}
const SAIL_GEO = makeSailGeometry();

/** Mast + boom + triangular sail. Sail local frame: unit bulge in x, height in y, foot along -z. */
function makeRig(parent, z, h, foot, cloth, deckY) {
  const g = new THREE.Group(); g.position.set(0, deckY, z); parent.add(g);
  cyl(g, 0xb8b8b0, 0.06 + h * 0.003, h, 0, h / 2, 0, { metalness: 0.5 });
  const pivot = new THREE.Group(); pivot.position.y = 1.0; g.add(pivot);
  const boom = cyl(pivot, 0x8a8a84, 0.05, foot, 0, 0, -foot / 2); boom.rotation.x = Math.PI / 2;
  boom.userData.noWalk = true;
  const sail = new THREE.Mesh(SAIL_GEO, M(cloth, { side: THREE.DoubleSide, roughness: 0.95 }));
  sail.castShadow = true;
  sail.scale.set(0.2, h - 1.3, foot); // y scale = luff height, z scale = foot length
  pivot.add(sail);
  return { group: g, pivot, sail, h, foot, area: 0.5 * (h - 1.3) * foot };
}

// ---------------------------------------------------------------------------
export class Boat {
  constructor(design, opts = {}) {
    this.design = design;
    this.rng = mulberry32(design.seed);
    this.modules = opts.modules ? [...opts.modules] : [];
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.x = opts.x || 0; this.z = opts.z || 0; this.heading = opts.heading || 0;
    this.vx = 0; this.vz = 0; this.yawRate = 0;
    this.y = 0; this.vy = 0; this.pitch = 0; this.vp = 0; this.roll = 0; this.vr = 0;
    this.throttle = 0; this.rudder = 0; this.sailsUp = false; this.sailDeploy = 0;
    this.crew = []; this.animals = [];
    this.fleet = null; this.role = opts.role || 'derelict'; // player|follower|derelict|npc|raider
    this.anchored = false;
    this.sinkOffset = 0; this.sinking = false; this.sunk = false;
    this.lightOn = false;
    this.flagColor = opts.flagColor ?? 0xffffff;
    this.taskTimer = 0;
    this.taskCounts = {};
    this.damageCooldown = 0;
    this.rowing = false; this.engineOn = false;
    this.ai = { stuck: 0, target: null };
    this.recompute();
    this.hp = opts.hpFrac !== undefined ? this.maxHp * opts.hpFrac : this.maxHp;
    this.build();
  }

  get L() { return this.design.length; }
  get B() { return this.design.beam; }
  get name() { return this.design.name; }
  get speed() { return Math.hypot(this.vx, this.vz); }
  get forwardSpeed() { return this.vx * Math.sin(this.heading) + this.vz * Math.cos(this.heading); }
  count(t) { return this.modules.filter((m) => m === t).length; }
  get usedSlots() { return this.modules.filter((m) => MODULES[m].slot).length; }
  get totalCrew() { return this.crew.length; }

  recompute() {
    const d = this.design;
    const n = (t) => this.count(t);
    this.slots = Math.max(2, Math.floor(d.length / 2.2));
    this.enginePower = d.engine + n('engine') * 25;
    this.maxCrew = Math.max(2, Math.round(d.length * d.beam / 6)) + n('shelter') * 2 + n('outrigger') +
      (d.kind === 'houseboat' || d.kind === 'yacht' ? 3 : 0);
    this.capacity = Math.round(d.length * d.beam * 5) + n('storage') * 40 + (d.kind === 'barge' ? 200 : 0);
    const oldMax = this.maxHp;
    this.maxHp = Math.round(d.length * d.beam * 7 + 30) + n('armor') * 60;
    if (oldMax && this.hp !== undefined) this.hp = Math.min(this.maxHp, this.hp + (this.maxHp - oldMax));
    this.mass = 110 * d.length * d.beam * (d.draft + d.freeboard);
    // Tuned for game feel rather than naval-architecture accuracy: roughly 2x real-world speeds.
    this.cF = 18 * d.beam * (d.draft + 0.3);
    this.hullSpeed = (d.planing ? 3.0 : 2.0) * Math.sqrt(d.length);
    this.stability = 1 + n('outrigger') * 1.2 + (d.kind === 'raft' ? 0.5 : 0);
    this.deckY = d.kind === 'raft' ? d.freeboard : d.open ? -d.draft * 0.35 : d.freeboard - 0.28;
  }

  // ---- visual construction --------------------------------------------------
  build() {
    if (this.body) this.root.remove(this.body);
    const d = this.design, L = d.length, B = d.beam;
    this.recompute();
    const body = new THREE.Group(); this.body = body; this.root.add(body);
    this.rigs = []; this.props = []; this.oars = []; this.lanterns = [];
    const rng = mulberry32(d.seed);

    if (d.kind === 'raft') this.buildRaft(body, rng);
    else {
      const { geo, sections } = buildHullGeometry(d);
      const hull = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }));
      hull.castShadow = true; hull.receiveShadow = true; body.add(hull);
      const deckGeo = buildDeckGeometry(d, sections, this.deckY);
      this.deckProfile = deckGeo.userData.profile;
      const deck = new THREE.Mesh(deckGeo, M(d.deckColor, { side: THREE.DoubleSide, roughness: 0.85, map: plankTexture() }));
      deck.receiveShadow = true; body.add(deck);
      const mask = new THREE.Mesh(buildWaterMask(sections), WATER_MASK_MAT);
      mask.renderOrder = 0.5; mask.frustumCulled = false; body.add(mask);
      this.sections = sections;
    }
    const dy = this.deckY;
    // free deck zone (z range) for modules; kinds narrow it.
    let zone = [-L * 0.32, L * 0.3];
    this.helm = new THREE.Vector3(0, dy, -L * 0.36);
    switch (d.kind) {
      case 'rowboat':
        box(body, d.deckColor, B * 0.8, 0.05, 0.25, 0, dy + 0.3, -L * 0.05);
        box(body, d.deckColor, B * 0.7, 0.05, 0.25, 0, dy + 0.3, L * 0.22);
        for (const s of [1, -1]) {
          const o = new THREE.Group(); o.position.set(s * B * 0.48, d.freeboard, -L * 0.05); body.add(o);
          const shaft = box(o, 0xb08a5a, 0.06, 0.06, 2.6, s * 0.9, 0, 0); shaft.rotation.y = s * 1.2;
          this.oars.push({ g: o, s });
        }
        this.helm.set(0, dy, -L * 0.05);
        break;
      case 'skiff': case 'raider':
        box(body, d.kind === 'raider' ? 0x333333 : 0xe8e8e2, 0.7, 0.9, 0.6, 0, dy + 0.45, -L * 0.05);
        box(body, WINDOW, 0.7, 0.35, 0.05, 0, dy + 1.05, -L * 0.05 + 0.3, { roughness: 0.15, transparent: true, opacity: 0.6 });
        this.helm.set(0, dy, -L * 0.05 - 0.6);
        if (d.kind === 'raider') {
          for (let i = 0; i < 4; i++) {
            const c = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.8, 5), M(0x777777, { metalness: 0.7 }));
            c.rotation.x = Math.PI / 2; c.position.set((i - 1.5) * 0.25, d.freeboard + 0.1, L * 0.5); body.add(c);
          }
          box(body, 0x5a4a3a, 0.05, 0.4, L * 0.6, B * 0.5, d.freeboard * 0.6, 0, { metalness: 0.6, roughness: 0.6 });
          box(body, 0x5a4a3a, 0.05, 0.4, L * 0.6, -B * 0.5, d.freeboard * 0.6, 0, { metalness: 0.6, roughness: 0.6 });
        }
        zone = [-L * 0.3, L * 0.25];
        break;
      case 'sailboat': {
        box(body, 0xf2f2ee, B * 0.55, 0.5, L * 0.32, 0, dy + 0.25, -L * 0.02);
        for (const s of [1, -1]) box(body, WINDOW, 0.04, 0.16, L * 0.2, s * B * 0.276, dy + 0.3, -L * 0.02, { roughness: 0.15 });
        this.rigs.push(makeRig(body, L * 0.12, L * 1.25, L * 0.42, d.clothColor, dy));
        this.helm.set(0, dy, -L * 0.36);
        zone = [-L * 0.32, -L * 0.2];
        break;
      }
      case 'fishing': {
        const wz = L * 0.12;
        box(body, 0xeeeeea, B * 0.6, 2.0, 2.4, 0, dy + 1.0, wz);
        box(body, 0x2a2a2a, B * 0.66, 0.12, 2.7, 0, dy + 2.05, wz);
        box(body, WINDOW, B * 0.61, 0.5, 0.05, 0, dy + 1.5, wz + 1.2, { roughness: 0.15 });
        for (const s of [1, -1]) box(body, WINDOW, 0.05, 0.5, 1.6, s * B * 0.305, dy + 1.5, wz, { roughness: 0.15 });
        cyl(body, 0xd0a020, 0.06, 4.5, 0, dy + 2.2, wz - 1.5);
        const af = box(body, 0x8a8a8a, B * 0.9, 0.12, 0.12, 0, dy + 3.0, -L * 0.42, { metalness: 0.6 });
        for (const s of [1, -1]) { const leg = box(body, 0x8a8a8a, 0.1, 3.0, 0.1, s * B * 0.43, dy + 1.5, -L * 0.42, { metalness: 0.6 }); }
        const drum = cyl(body, 0x335533, 0.4, B * 0.5, 0, dy + 0.5, -L * 0.3); drum.rotation.z = Math.PI / 2;
        this.helm.set(0, dy, wz);
        this.helmEnclosed = true;
        zone = [-L * 0.25, wz - 1.5];
        void af;
        break;
      }
      case 'tug': {
        const wz = L * 0.08;
        box(body, 0xf2f2ee, B * 0.7, 1.8, 4, 0, dy + 0.9, wz - 0.5);
        box(body, 0xf2f2ee, B * 0.55, 1.5, 2.4, 0, dy + 2.55, wz);
        box(body, 0x2a2a2a, B * 0.6, 0.1, 2.7, 0, dy + 3.35, wz);
        box(body, WINDOW, B * 0.56, 0.6, 0.05, 0, dy + 2.8, wz + 1.21, { roughness: 0.15 });
        for (const s of [1, -1]) box(body, WINDOW, 0.05, 0.5, 1.8, s * B * 0.277, dy + 2.8, wz, { roughness: 0.15 });
        const fun = cyl(body, d.trimColor, 0.45, 2.4, 0, dy + 2.6, wz - 2.2);
        cyl(body, 0x222222, 0.47, 0.4, 0, dy + 3.7, wz - 2.2);
        void fun;
        const tire = new THREE.TorusGeometry(0.35, 0.14, 6, 12);
        for (let i = 0; i < 5; i++) for (const s of [1, -1]) {
          const t = new THREE.Mesh(tire, M(0x1a1a1a, { roughness: 1 }));
          t.rotation.y = Math.PI / 2; t.position.set(s * (B * 0.5 + 0.08), d.freeboard * 0.55, (i - 2) * L * 0.15); body.add(t);
        }
        this.helm.set(0, dy + 1.8, wz);
        this.helmEnclosed = true;
        zone = [-L * 0.42, -L * 0.25];
        break;
      }
      case 'yacht': {
        const cz = -L * 0.05;
        box(body, 0xf8f8f6, B * 0.78, 1.3, L * 0.5, 0, dy + 0.65, cz);
        box(body, 0xf8f8f6, B * 0.6, 1.0, L * 0.28, 0, dy + 1.8, cz - L * 0.04);
        for (const s of [1, -1]) {
          box(body, WINDOW, 0.05, 0.45, L * 0.42, s * B * 0.392, dy + 0.75, cz, { roughness: 0.1, metalness: 0.3 });
          box(body, WINDOW, 0.05, 0.4, L * 0.22, s * B * 0.302, dy + 1.85, cz - L * 0.04, { roughness: 0.1, metalness: 0.3 });
        }
        box(body, WINDOW, B * 0.6, 0.45, 0.05, 0, dy + 1.0, cz + L * 0.251, { roughness: 0.1 });
        cyl(body, 0xcccccc, 0.04, 1.4, 0, dy + 2.9, cz - L * 0.1, { metalness: 0.8 });
        this.helm.set(0, dy + 2.3, cz);
        zone = [-L * 0.45, -L * 0.33];
        break;
      }
      case 'houseboat': {
        const hl = L * 0.62, hz = -L * 0.04, hh = 2.3;
        const wallC = pick(rng, [0xe8dcc0, 0xc5d8e0, 0xe0c0b0, 0xd8e8c8]);
        box(body, wallC, B * 0.86, hh, hl, 0, dy + hh / 2, hz);
        const roof = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4, 1), M(0x6b4a3a));
        roof.rotation.y = Math.PI / 4; roof.scale.set(B * 0.7, 1.1, hl * 0.72); roof.position.set(0, dy + hh + 0.55, hz); roof.castShadow = true; body.add(roof);
        for (const s of [1, -1]) for (let i = 0; i < 3; i++) box(body, WINDOW, 0.05, 0.7, 0.9, s * B * 0.432, dy + 1.3, hz + (i - 1) * hl * 0.3, { roughness: 0.2 });
        box(body, 0x5a3a2a, 0.9, 1.8, 0.05, 0, dy + 0.9, hz + hl / 2 + 0.01);
        cyl(body, 0x8a3a2a, 0.3, 0.4, B * 0.3, dy + 0.2, hz + hl / 2 + 0.8);
        const plant = new THREE.Mesh(new THREE.SphereGeometry(0.35, 7, 6), M(0x3a7a3a)); plant.position.set(B * 0.3, dy + 0.6, hz + hl / 2 + 0.8); body.add(plant);
        this.helm.set(0, dy, hz + hl / 2 + 0.6);
        zone = [-L * 0.45, -L * 0.38];
        break;
      }
      case 'barge': {
        const rows = Math.floor(L / 6.5);
        for (let i = 0; i < rows; i++) for (const s of [-1, 1]) {
          if (rng() < 0.3) continue;
          const stack = 1 + Math.floor(rng() * 2);
          for (let k = 0; k < stack; k++) box(body, pick(rng, [0xb33a2e, 0x2e5fa3, 0x2f8a52, 0xd19a2a, 0x6b6f75]), B * 0.42, 2.5, 6, s * B * 0.23, dy + 1.25 + k * 2.55, -L * 0.25 + i * 6.4);
        }
        box(body, 0xdddddd, B * 0.4, 1.8, 2.2, 0, dy + 0.9, -L * 0.43);
        box(body, WINDOW, B * 0.41, 0.4, 1.4, 0, dy + 1.4, -L * 0.43, { roughness: 0.2 });
        this.helm.set(0, dy, -L * 0.43 + 1.4);
        zone = [-L * 0.36, -L * 0.3];
        break;
      }
      case 'schooner': {
        this.rigs.push(makeRig(body, L * 0.2, L * 1.05, L * 0.3, d.clothColor, dy));
        this.rigs.push(makeRig(body, -L * 0.08, L * 1.15, L * 0.34, d.clothColor, dy));
        const sprit = cyl(body, 0x6b4a2e, 0.08, L * 0.25, 0, d.freeboard + d.sheer + 0.2, L * 0.6); sprit.rotation.x = Math.PI / 2 - 0.2;
        box(body, 0x7a5a38, B * 0.4, 0.8, L * 0.15, 0, dy + 0.4, -L * 0.28);
        this.helm.set(0, dy, -L * 0.42);
        zone = [-L * 0.22, -L * 0.12];
        break;
      }
    }
    if (d.engine > 0 && (d.kind === 'skiff' || d.kind === 'raider' || d.kind === 'sailboat')) this.makeOutboard(body, 0);
    if (this.helmEnclosed === undefined) this.helmEnclosed = false;

    // stern flag + lantern
    const flagPole = new THREE.Group(); flagPole.position.set(B * 0.3, this.deckSurfaceY(-L * 0.45) + 0.1, -L * 0.45); body.add(flagPole);
    cyl(flagPole, 0x999999, 0.025, 1.6, 0, 0.8, 0);
    this.flag = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.35), M(this.flagColor, { side: THREE.DoubleSide }));
    this.flag.geometry.translate(0.3, 0, 0); this.flag.position.y = 1.4; flagPole.add(this.flag);
    const lantern = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), new THREE.MeshStandardMaterial({ color: 0xffe0a0, emissive: 0xffc060, emissiveIntensity: 0 }));
    lantern.position.y = 1.65; flagPole.add(lantern); this.lanterns.push(lantern);

    this.flag.userData.noWalk = true; lantern.userData.noWalk = true;
    this.buildModules(body, zone);
    this.computeStations(zone);
    this.computeWalkable(body);
    this.zone = zone;
  }

  deckSurfaceY() { return this.deckY; }

  /**
   * Walkable deck for the player on foot: the deck outline (half-width per
   * station along the keel) plus every solid deck structure as a local AABB.
   * Structures lower than a step (0.6 m) are platforms you can climb onto.
   */
  computeWalkable(body) {
    this.obstacles = [];
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    const m = new THREE.Matrix4(), box = new THREE.Box3();
    const dy = this.deckY;
    body.traverse((o) => {
      if (!o.isMesh || o.userData.noWalk || o.material === WATER_MASK_MAT || !o.geometry) return;
      if (o.geometry.type !== 'BoxGeometry' && o.geometry.type !== 'CylinderGeometry' && o.geometry.type !== 'ConeGeometry') return;
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      m.multiplyMatrices(inv, o.matrixWorld);
      box.copy(o.geometry.boundingBox).applyMatrix4(m);
      const sx = box.max.x - box.min.x, sz = box.max.z - box.min.z;
      if (sx < 0.18 || sz < 0.18) return;              // masts, rails, stanchions
      if (box.min.y > dy + 0.5 || box.max.y < dy + 0.12) return; // overhead or flush with deck
      if (Math.abs(box.min.x) > this.B * 0.6) return;    // outboard things (outriggers, tires)
      this.obstacles.push({ minx: box.min.x, maxx: box.max.x, minz: box.min.z, maxz: box.max.z, top: box.max.y });
    });
    // merge platform tops that sit on top of other obstacles (cabin roofs over walls)
    const p = this.deckProfile.filter((s) => s.w > 0.3);
    this.walkZ = p.length ? [p[0].z + 0.3, p[p.length - 1].z - 0.3] : [-this.L * 0.4, this.L * 0.4];
  }

  /** Deck half-width and height at local z (linear between loft stations). */
  deckAt(z) {
    const p = this.deckProfile;
    if (!p || !p.length) return { w: this.B * 0.4, y: this.deckY };
    if (z <= p[0].z) return p[0];
    for (let i = 1; i < p.length; i++) if (z <= p[i].z) {
      const t = (z - p[i - 1].z) / (p[i].z - p[i - 1].z || 1);
      return { w: p[i - 1].w + (p[i].w - p[i - 1].w) * t, y: p[i - 1].y + (p[i].y - p[i - 1].y) * t };
    }
    return p[p.length - 1];
  }

  buildRaft(body, rng) {
    const d = this.design, L = d.length, B = d.beam;
    const n = Math.max(5, Math.round(B / 0.32));
    const r = B / n / 2;
    for (let i = 0; i < n; i++) {
      const log = cyl(body, pick(rng, WOOD), r, L * rand(rng, 0.92, 1.0), -B / 2 + r + i * 2 * r, d.freeboard - r, 0);
      log.rotation.x = Math.PI / 2;
    }
    for (const z of [-L * 0.35, 0, L * 0.35]) box(body, 0x5a4028, B * 1.05, 0.12, 0.2, 0, d.freeboard + 0.02, z);
    for (const [x, z] of [[B * 0.35, L * 0.35], [-B * 0.35, L * 0.35], [B * 0.35, -L * 0.35], [-B * 0.35, -L * 0.35]]) {
      const b = cyl(body, pick(rng, [0x2e5fa3, 0x2f6f3a, 0x8a2a1a]), 0.3, 0.8, x, -0.05, z); b.rotation.x = Math.PI / 2;
    }
    this.sections = null;
    this.deckProfile = [-0.5, -0.25, 0, 0.25, 0.5].map((t) => ({ z: t * L * 0.96, w: B * 0.48, y: d.freeboard }));
  }

  makeOutboard(body, offset) {
    const d = this.design, L = d.length;
    const g = new THREE.Group(); g.position.set(offset, d.freeboard * 0.8, -L / 2 - 0.15); body.add(g);
    box(g, 0x222222, 0.42, 0.55, 0.55, 0, 0.25, -0.15);
    box(g, 0x3a3a3a, 0.12, d.freeboard + d.draft + 0.2, 0.18, 0, -(d.freeboard + d.draft) / 2, -0.2);
    const prop = box(g, 0x999999, 0.5, 0.05, 0.08, 0, -(d.freeboard + d.draft) + 0.05, -0.25, { metalness: 0.8 });
    this.props.push(prop);
  }

  buildModules(body, zone) {
    const d = this.design, L = d.length, B = d.beam, dy = this.deckY;
    const slotMods = this.modules.filter((m) => MODULES[m].slot);
    const ns = Math.max(1, slotMods.length);
    let si = 0;
    let engines = 0;
    for (const m of this.modules) {
      if (m === 'engine') { this.makeOutboard(body, (engines === 0 && this.props.length === 0) ? 0 : (engines % 2 ? -0.45 : 0.45)); engines++; continue; }
      if (m === 'armor') {
        for (const s of [1, -1]) box(body, 0x5c5e60, 0.06, d.freeboard * 0.8, L * 0.7, s * (B * 0.5 + 0.04), d.freeboard * 0.45, 0, { metalness: 0.7, roughness: 0.5 });
        continue;
      }
      if (m === 'outrigger') {
        for (const s of [1, -1]) {
          const f = cyl(body, 0xe8e8e2, 0.22, L * 0.6, s * (B / 2 + 1.3), 0.05, 0); f.rotation.x = Math.PI / 2;
          for (const z of [-L * 0.15, L * 0.15]) box(body, 0x6b4a2e, 1.5, 0.1, 0.12, s * (B / 2 + 0.7), d.freeboard * 0.7, z);
        }
        continue;
      }
      // slot modules spread through the free zone
      const z = zone[0] + (zone[1] - zone[0]) * ((si + 0.5) / ns);
      const side = si % 2 ? -1 : 1; si++;
      const g = new THREE.Group(); g.position.set(0, dy, z); body.add(g);
      switch (m) {
        case 'sail': this.rigs.push(makeRig(body, z, 2.5 + L * 0.9, Math.max(2, L * 0.5), d.clothColor, dy)); break;
        case 'storage':
          box(g, 0x8a6a44, 0.7, 0.6, 0.7, side * B * 0.2, 0.3, 0); box(g, 0x7a5a38, 0.6, 0.5, 0.6, side * B * 0.2, 0.85, 0.05);
          cyl(g, 0x2e5fa3, 0.25, 0.8, -side * B * 0.2, 0.4, 0); break;
        case 'shelter': {
          const t = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 4), M(0x5a7a5a, { side: THREE.DoubleSide }));
          t.rotation.y = Math.PI / 4; t.scale.set(Math.min(B * 0.55, 1.4), 1.5, 1.4); t.position.y = 0.75; t.castShadow = true; g.add(t); break;
        }
        case 'net': {
          const arm = box(g, 0x8a8a8a, 0.08, 0.08, 2.5, side * B * 0.4, 1.8, 0, { metalness: 0.6 }); arm.rotation.z = side * 0.5;
          cyl(g, 0x8a8a8a, 0.06, 1.8, side * B * 0.4, 0.9, 0);
          box(g, 0x2a3a2a, 0.6, 0.6, 1.2, side * B * 0.25, 0.3, 0); break;
        }
        case 'raincatch': {
          const c = new THREE.Mesh(new THREE.ConeGeometry(0.8, 0.6, 8, 1, true), M(0x2e6fb3, { side: THREE.DoubleSide }));
          c.rotation.x = Math.PI; c.position.set(side * B * 0.15, 1.4, 0); g.add(c);
          cyl(g, 0x2e5fa3, 0.3, 1.0, side * B * 0.15, 0.5, 0); break;
        }
        case 'still':
          box(g, 0x222222, 1.1, 0.15, 0.8, side * B * 0.15, 0.08, 0);
          box(g, 0xaaddff, 1.0, 0.45, 0.7, side * B * 0.15, 0.38, 0, { transparent: true, opacity: 0.4, roughness: 0.05 }); break;
        case 'planter':
          box(g, 0x6b4a2e, 1.2, 0.35, 0.6, side * B * 0.15, 0.18, 0);
          for (let i = 0; i < 4; i++) { const p = new THREE.Mesh(new THREE.SphereGeometry(0.18, 6, 5), M(0x3e8a3a)); p.position.set(side * B * 0.15 + (i - 1.5) * 0.28, 0.45, 0); g.add(p); }
          break;
        case 'light': {
          g.position.z = Math.min(L * 0.38, zone[1] + 1);
          cyl(g, 0x555555, 0.05, 1.6, 0, 0.8, 0);
          const head = cyl(g, 0x333333, 0.18, 0.35, 0, 1.7, 0.1); head.rotation.x = Math.PI / 2;
          const lens = new THREE.Mesh(new THREE.CircleGeometry(0.16, 12), new THREE.MeshStandardMaterial({ color: 0xffffee, emissive: 0xffffcc, emissiveIntensity: 0 }));
          lens.position.set(0, 1.7, 0.28); g.add(lens); this.lens = lens;
          this.lightHead = g;
          break;
        }
      }
    }
  }

  computeStations(zone) {
    const L = this.L, B = this.B, dy = this.deckY;
    const w = this.design.kind === 'raft' ? B * 0.38 : B * 0.3;
    this.stations = {
      helm: this.helm.clone(),
      bow: new THREE.Vector3(0, dy, L * (this.design.kind === 'raft' ? 0.35 : 0.33)),
      mast: this.rigs.length ? new THREE.Vector3(B * 0.18, dy, this.rigs[0].group.position.z - 0.7) : new THREE.Vector3(0, dy, 0),
      fishP: new THREE.Vector3(w, dy, lerp(zone[0], zone[1], 0.3)),
      fishS: new THREE.Vector3(-w, dy, lerp(zone[0], zone[1], 0.7)),
      mid: new THREE.Vector3(0, dy, (zone[0] + zone[1]) / 2),
    };
  }

  /** Random walkable point on deck (local). */
  deckPoint(rng) {
    const z = rand(rng, this.zone[0], this.zone[1]);
    return new THREE.Vector3(rand(rng, -1, 1) * this.B * 0.25, this.deckY, z);
  }

  canAdd(mod) {
    const def = MODULES[mod];
    if (this.count(mod) >= def.max) return 'Already at max';
    if (def.slot && this.usedSlots >= this.slots) return 'No free deck slots';
    if (mod === 'sail' && this.design.kind === 'raider') return 'Not on this hull';
    return null;
  }
  addModule(mod) { this.modules.push(mod); this.rebuild(); }
  lengthen(dL) {
    this.design.length += dL;
    this.rebuild();
  }
  rebuild() {
    const people = [...this.crew, ...this.animals];
    for (const p of people) this.root.remove(p.mesh);
    this.build();
    for (const p of people) { this.root.add(p.mesh); p.local.copy(this.deckPoint(this.rng)); }
  }

  // ---- crew --------------------------------------------------------------------
  addPerson(p) {
    this.crew.push(p); p.boat = this; p.state = 'aboard';
    this.root.add(p.mesh);
    p.local.copy(this.deckPoint(this.rng)); p.target.copy(p.local);
    this.taskTimer = 0;
  }
  removePerson(p) {
    const i = this.crew.indexOf(p); if (i >= 0) this.crew.splice(i, 1);
    this.root.remove(p.mesh); p.boat = null; this.taskTimer = 0;
  }
  addAnimal(a) {
    this.animals.push(a); a.boat = this; this.root.add(a.mesh);
    a.local.copy(this.deckPoint(this.rng)); a.target.copy(a.local);
  }
  removeAnimal(a) { const i = this.animals.indexOf(a); if (i >= 0) this.animals.splice(i, 1); this.root.remove(a.mesh); a.boat = null; }
  get freeBerths() { return this.maxCrew - this.crew.length; }

  assignTasks(ctx) {
    const counts = { helm: 0, repair: 0, trim: 0, row: 0, fish: 0, lookout: 0, sleep: 0, bail: 0 };
    const night = ctx.env.night > 0.6 && ctx.env.state !== 'storm';
    let helmTaken = this.crew.some((p) => p.isPlayer && !p.manual);
    const others = this.crew.filter((p) => !p.isPlayer);
    const needRow = this.rowingWanted;
    let fishSide = 0;
    others.forEach((p, i) => {
      let task;
      if (!helmTaken && this.role !== 'derelict') { task = 'helm'; helmTaken = true; }
      else if (this.hp < this.maxHp * 0.35 && counts.bail < 1) task = 'bail';
      else if (this.hp < this.maxHp - 1 && counts.repair < 2 && ctx.canRepair) task = 'repair';
      else if (this.sailDeploy > 0.3 && counts.trim < this.rigs.length) task = 'trim';
      else if (needRow && counts.row < 4) task = 'row';
      else if (night && i % 2 === 1) task = 'sleep';
      else if (counts.lookout < 1 && i % 3 === 2) task = 'lookout';
      else task = 'fish';
      counts[task]++;
      p.task = task;
      let t;
      switch (task) {
        case 'helm': t = this.stations.helm; break;
        case 'trim': t = this.stations.mast; break;
        case 'lookout': t = this.stations.bow; break;
        case 'fish': t = (fishSide++ % 2 ? this.stations.fishS : this.stations.fishP).clone().add(new THREE.Vector3(0, 0, (fishSide >> 1) * 0.8)); break;
        case 'row': t = new THREE.Vector3(0, this.deckY, -this.L * 0.05 + counts.row * 0.6 - 0.6); break;
        default: t = this.deckPoint(this.rng);
      }
      p.target.copy(t);
    });
    for (const p of this.crew) if (p.isPlayer && !p.manual) { p.task = this.rowingWanted && others.length === 0 ? 'row' : 'helm'; p.target.copy(this.stations.helm); }
    this.taskCounts = counts;
  }

  updatePeople(dt, ctx) {
    this.taskTimer -= dt;
    if (this.taskTimer <= 0) { this.taskTimer = 2.5; this.assignTasks(ctx); }
    const halfW = this.B * 0.42;
    for (const p of this.crew) {
      if (p.jump || p.manual) continue;
      const dx = p.target.x - p.local.x, dz = p.target.z - p.local.z;
      const dist = Math.hypot(dx, dz);
      let anim = p.task;
      if (dist > 0.25) {
        const step = Math.min(dist, 1.3 * dt);
        p.local.x += dx / dist * step; p.local.z += dz / dist * step;
        p.mesh.rotation.y = Math.atan2(dx, dz);
        anim = 'walk';
      } else {
        let face = 0;
        if (p.task === 'fish') face = p.local.x > 0 ? Math.PI / 2 : -Math.PI / 2;
        if (p.task === 'repair' || p.task === 'bail') face = p.local.x > 0 ? Math.PI / 2 : -Math.PI / 2;
        if (p.task === 'trim') face = -Math.PI / 2 * Math.sign(this.rigs[0]?.pivot.rotation.y || 1);
        p.mesh.rotation.y += angleDiff(p.mesh.rotation.y, face) * damp(4, dt);
        if (p.task === 'helm' && this.helmEnclosed) anim = 'helm';
      }
      p.local.x = clamp(p.local.x, -halfW, halfW);
      p.mesh.position.set(p.local.x, this.deckY + (p.task === 'sleep' ? 0.05 : 0), p.local.z);
      p.animate(dt, anim);
    }
    for (const a of this.animals) {
      if (a.jump) continue;
      const dx = a.target.x - a.local.x, dz = a.target.z - a.local.z, dist = Math.hypot(dx, dz);
      if (dist < 0.2) { if (this.rng() < dt * 0.3) a.target.copy(this.deckPoint(this.rng)); a.animate(dt, false); }
      else {
        const st = Math.min(dist, 0.8 * dt); a.local.x += dx / dist * st; a.local.z += dz / dist * st;
        a.mesh.rotation.y = Math.atan2(dx, dz); a.animate(dt, true);
      }
      a.mesh.position.set(a.local.x, this.deckY, a.local.z);
    }
  }

  // ---- physics ----------------------------------------------------------------
  update(dt, ctx) {
    if (this.sunk) return;
    const { water, env, city, floorMap } = ctx;
    const d = this.design, L = d.length, B = d.beam;
    const sh = Math.sin(this.heading), ch = Math.cos(this.heading);
    const fx = sh, fz = ch, rx = -ch, rz = sh; // forward, starboard
    const lx = ch, lz = -sh; // port
    const u = this.vx * fx + this.vz * fz, v = this.vx * rx + this.vz * rz;
    let Fu = 0, Fv = 0;
    const crewN = this.crew.length;
    const control = crewN > 0 && !this.sinking;

    // Engine.
    this.engineOn = false; this.rowing = false; this.rowingWanted = false;
    const thr = control ? this.throttle : 0;
    if (Math.abs(thr) > 0.02) {
      if (this.enginePower > 0 && ctx.fuel(this) > 0 && !this.noEngine) {
        const T = 900 * Math.pow(this.enginePower, 0.62) * thr * (thr < 0 ? 0.5 : 1);
        Fu += T; this.engineOn = true;
        ctx.useFuel(Math.abs(thr) * Math.pow(this.enginePower, 0.6) * 0.0012 * dt, this);
      } else if (this.sailDeploy < 0.5 || thr < 0 || (this.sailDrive ?? 0) < 0.1) {
        this.rowingWanted = true;
        const rowers = Math.max(1, Math.min(crewN, L < 9 ? 4 : 6));
        Fu += thr * rowers * (L < 9 ? 120 : 220) * (thr < 0 ? 0.6 : 1) * (this.design.kind === 'raft' ? 0.8 : 1);
        this.rowing = true;
      }
    }

    // Sails.
    const sailArea = this.rigs.reduce((a, r) => a + r.area, 0);
    this.sailDeploy += ((this.sailsUp && control && sailArea > 0 ? 1 : 0) - this.sailDeploy) * damp(1.2, dt);
    const W = ctx.wind; // world wind vector (blowing toward)
    const ax = W.x - this.vx, az = W.y - this.vz;
    const aw = Math.hypot(ax, az) + 1e-4;
    const cosA = (fx * -ax + fz * -az) / aw; // angle off the apparent wind (0 = head to wind)
    const alpha = Math.acos(clamp(cosA, -1, 1)) * 180 / Math.PI;
    let cDrive;
    if (alpha < 32) cDrive = 0;
    else if (alpha < 50) cDrive = (alpha - 32) / 18 * 0.9;
    else if (alpha < 110) cDrive = 0.9 + (alpha - 50) / 60 * 0.2;
    else cDrive = 1.1 - (alpha - 110) / 70 * 0.15;
    this.sailAlpha = alpha; this.sailDrive = cDrive;
    const q = 0.5 * 1.2 * aw * aw;
    let heel = 0;
    if (this.sailDeploy > 0.01 && sailArea > 0) {
      Fu += q * sailArea * cDrive * this.sailDeploy * 6.0;
      const leeSide = Math.sign(W.x * rx + W.y * rz) || 1;
      const Fs = q * sailArea * this.sailDeploy * 0.4 * Math.sin(alpha * Math.PI / 180);
      Fv += Fs * leeSide;
      heel = clamp(Fs / (this.mass * 9.81) * 2.2, 0, 0.5) * leeSide / this.stability;
      if (env.windSpeed > 15.5 && this.sailDeploy > 0.5) {
        this.hurt((env.windSpeed - 15.5) * 0.6 * dt, ctx, true);
        if (this.role === 'player' && this.rng() < dt * 0.5) ctx.warn('Gale! Reef the sails (R) before they tear the rig apart.');
      }
    }
    // windage on hull
    const windForce = 0.5 * 1.2 * L * (d.freeboard + 0.5) * 0.25;
    let Fwx = W.x * Math.abs(W.x) * windForce * 0.05, Fwz = W.y * Math.abs(W.y) * windForce * 0.05;

    // Drag.
    // A badly holed hull is half full of water: heavy and sluggish until repaired.
    this.waterlogged = clamp(1 - this.hp / (this.maxHp * 0.5), 0, 1);
    let du = this.cF * (u * Math.abs(u) + 1.5 * u) * (1 + 3 * this.waterlogged);
    const au = Math.abs(u);
    if (au > this.hullSpeed) du += Math.sign(u) * this.cF * 12 * (au - this.hullSpeed) ** 2;
    Fu -= du;
    Fv -= this.cF * 14 * (v * Math.abs(v) + 1.2 * v);

    // Ground / shoals.
    const level = water.level;
    this.grounded = false;
    for (const t of [0.42, 0, -0.42]) {
      const px = this.x + fx * L * t, pz = this.z + fz * L * t;
      const gnd = Math.max(floorMap.groundAt(px, pz), city.topAt(px, pz));
      if (gnd > level - d.draft * 0.85) {
        this.grounded = true;
        if (gnd > level - 0.1 && floorMap.groundAt(px, pz) >= gnd - 0.01) {
          // terrain beach: push back downhill
          const e = 2;
          const gx = floorMap.groundAt(px + e, pz) - floorMap.groundAt(px - e, pz);
          const gz = floorMap.groundAt(px, pz + e) - floorMap.groundAt(px, pz - e);
          const gl = Math.hypot(gx, gz) + 1e-5;
          this.resolveContact(-gx / gl, -gz / gl, Math.min(0.3, (gnd - level + 0.1) * 0.3), t * L, ctx, 'shore');
        }
      }
    }

    // Integrate.
    let accx = (Fu * fx + Fv * rx + Fwx) / this.mass, accz = (Fu * fz + Fv * rz + Fwz) / this.mass;
    this.vx += accx * dt; this.vz += accz * dt;
    if (this.grounded) { const k = Math.exp(-2.5 * dt); this.vx *= k; this.vz *= k; if (this.speed > 2.5) this.hurt(this.speed * 2 * dt, ctx); }
    if (this.anchored) { const k = Math.exp(-1.2 * dt); this.vx *= k; this.vz *= k; }
    if (!control && this.role === 'derelict') { this.vx += W.x * 0.02 * dt; this.vz += W.y * 0.02 * dt; }

    const lenK = Math.sqrt(6 / Math.max(4, L));
    const steerRate = this.rudder * (clamp(u, -3, 8) * 0.12 + (this.engineOn ? Math.abs(thr) * 0.28 : 0) + (this.rowing ? 0.35 : 0)) * lenK;
    this.yawRate += ((control ? steerRate : 0) - this.yawRate) * damp(2.2, dt);
    this.heading += this.yawRate * dt;
    this.x += this.vx * dt; this.z += this.vz * dt;

    // Building collisions: circles along the keel.
    const nC = Math.max(1, Math.round(L / B));
    for (let i = 0; i < nC; i++) {
      const t = nC === 1 ? 0 : -L / 2 + B / 2 + (L - B) * i / (nC - 1);
      const cx = this.x + fx * t, cz = this.z + fz * t;
      city.circleContacts(cx, cz, B * 0.55, level - d.draft * 0.6, (nx, nz, pen, c) => this.resolveContact(nx, nz, pen, t, ctx, c.kind));
    }
    this.damageCooldown -= dt;

    // Buoyancy & attitude (critically damped springs toward the wave surface).
    const hc = water.heightAt(this.x, this.z);
    const hb = water.heightAt(this.x + fx * L * 0.4, this.z + fz * L * 0.4);
    const hs = water.heightAt(this.x - fx * L * 0.4, this.z - fz * L * 0.4);
    const hp = water.heightAt(this.x + lx * B * 0.5, this.z + lz * B * 0.5);
    const hst = water.heightAt(this.x - lx * B * 0.5, this.z - lz * B * 0.5);
    // damage-induced settling / sinking
    if (this.hp <= 0 && !this.sinking) { this.sinking = true; ctx.onSinking && ctx.onSinking(this); }
    const lowHp = clamp(1 - this.hp / (this.maxHp * 0.3), 0, 1);
    if (this.sinking) this.sinkOffset += dt * 0.5; else this.sinkOffset += (lowHp * d.freeboard * 0.6 - this.sinkOffset) * damp(0.5, dt);
    if (this.sinkOffset > d.freeboard + d.draft + 4) { this.sunk = true; this.root.visible = false; return; }
    const ty = (hc * 2 + hb + hs + hp + hst) / 6 - this.sinkOffset + (d.planing ? clamp(u - 3, 0, 6) * 0.04 : 0);
    const tp = Math.atan2(hb - hs, L * 0.8) + (d.planing ? clamp(u - 2, 0, 8) * 0.012 : clamp(u, 0, 6) * 0.004) + (this.sinking ? this.sinkOffset * 0.08 : 0);
    const tr = Math.atan2(hp - hst, B) / this.stability - heel + clamp(-this.yawRate * u * 0.05, -0.15, 0.15) + (this.sinking ? this.sinkOffset * 0.1 : 0) + lowHp * 0.05;
    const w0 = 2 * Math.PI / (0.6 + L * 0.07);
    const spring = (val, vel, target, wn) => {
      const acc = wn * wn * (target - val) - 2 * 0.7 * wn * vel;
      vel += acc * dt; return [val + vel * dt, vel];
    };
    [this.y, this.vy] = spring(this.y, this.vy, ty, w0);
    [this.pitch, this.vp] = spring(this.pitch, this.vp, clamp(tp, -0.5, 0.5), w0 * 0.9);
    [this.roll, this.vr] = spring(this.roll, this.vr, clamp(tr, -0.7, 0.7), w0 * 0.8);
    if (!this.settled || Math.abs(this.y - ty) > 5) { this.y = ty; this.vy = 0; this.pitch = 0; this.roll = 0; this.settled = true; }

    this.root.position.set(this.x, this.y, this.z);
    this.root.rotation.set(-this.pitch, this.heading, this.roll);

    this.updateVisuals(dt, ctx, u, alpha, W, lx, lz);
    this.updatePeople(dt, ctx);

    // wake & spray
    if (ctx.fx && ctx.nearCamera(this)) {
      const sp = Math.abs(u);
      if (sp > 0.6 && Math.random() < dt * 30) {
        const sx = this.x - fx * L * 0.5, sz = this.z - fz * L * 0.5;
        ctx.fx.emit(sx + (Math.random() - 0.5) * B * 0.6, hc, sz + (Math.random() - 0.5) * B * 0.6, -fx * 0.3 + (Math.random() - 0.5), 0, -fz * 0.3 + (Math.random() - 0.5), 4 + sp * 0.5, B * 0.5 + sp * 0.15, 0);
        for (const s of [1, -1]) ctx.fx.emit(this.x + fx * L * 0.35 + lx * B * 0.5 * s, hc, this.z + fz * L * 0.35 + lz * B * 0.5 * s, lx * s * sp * 0.25, 0, lz * s * sp * 0.25, 3, B * 0.25 + sp * 0.06, 0);
      }
      if (sp > 3.5 && Math.random() < dt * (sp - 3) * 4 * (1 + ctx.water.sea)) {
        ctx.fx.emit(this.x + fx * L * 0.48, hc + 0.3, this.z + fz * L * 0.48, lx * (Math.random() - 0.5) * 3 + fx * sp * 0.4, 1.5 + Math.random() * 2, lz * (Math.random() - 0.5) * 3 + fz * sp * 0.4, 0.9, 0.35, 1);
      }
      if (this.engineOn && this.design.kind === 'tug' && Math.random() < dt * 6) {
        const p = this.root.localToWorld(new THREE.Vector3(0, this.deckY + 4, this.L * 0.08 - 2.2));
        ctx.fx.emit(p.x, p.y, p.z, W.x * 0.3, 1.2, W.y * 0.3, 4, 1.2, 2, 0.25, 0.25, 0.25);
      }
    }
  }

  resolveContact(nx, nz, pen, along, ctx, kind) {
    this.x += nx * pen; this.z += nz * pen;
    const vn = this.vx * nx + this.vz * nz;
    if (vn < 0) {
      const e = 0.25;
      this.vx -= (1 + e) * vn * nx; this.vz -= (1 + e) * vn * nz;
      const fx = Math.sin(this.heading), fz = Math.cos(this.heading);
      this.yawRate += along * (fx * nz - fz * nx) * -vn * 0.08 / Math.max(1, this.L * 0.3);
      const impact = -vn;
      if (impact > 1.4 && this.damageCooldown <= 0) {
        const dmg = (impact - 1.4) * 7 * (kind === 'shore' ? 0.4 : 1);
        this.hurt(dmg, ctx);
        this.damageCooldown = 0.4;
        if (ctx.onImpact) ctx.onImpact(this, impact);
      }
    }
  }

  hurt(dmg, ctx, silent) {
    const armorK = 1 - this.count('armor') * 0.15;
    this.hp = Math.max(0, this.hp - dmg * armorK);
    if (!silent && ctx && this.role === 'player' && dmg > 3) ctx.warn(`Hull damage! ${Math.round(this.hp)}/${this.maxHp}`);
  }

  updateVisuals(dt, ctx, u, alpha, W, lx, lz) {
    const night = ctx.env.night;
    // Sails: boom swings to leeward, sail fills with drive.
    const fromPort = (-W.x * lx + -W.y * lz) > 0;
    const beta = clamp((alpha - 25) * 0.5, 4, 80) * Math.PI / 180;
    for (const r of this.rigs) {
      const target = beta * (fromPort ? 1 : -1);
      r.pivot.rotation.y += angleDiff(r.pivot.rotation.y, target) * damp(1.5, dt);
      const luff = this.sailDrive < 0.05 && this.sailDeploy > 0.2;
      const fill = luff ? Math.sin(performance.now() * 0.02) * 0.08 : this.sailDrive * 0.35 + 0.05;
      r.sail.scale.x = -Math.sign(r.pivot.rotation.y || 1) * fill * r.foot * this.sailDeploy;
      r.sail.scale.y = (r.h - 1.3) * (0.06 + 0.94 * this.sailDeploy);
    }
    // Outboard prop spin + oars.
    for (const p of this.props) p.rotation.z += (this.engineOn ? this.throttle * 40 : 0) * dt;
    for (const o of this.oars) {
      const t = performance.now() * 0.003;
      o.g.rotation.y = this.rowing ? Math.sin(t * 2) * 0.5 * o.s : 0;
      o.g.rotation.z = this.rowing ? (Math.cos(t * 2) * 0.15 - 0.1) * o.s : -0.25 * o.s;
    }
    // Flag points downwind (in boat-local yaw).
    if (this.flag) {
      const windYaw = Math.atan2(W.x, W.y) - this.heading;
      this.flag.parent.rotation.y = windYaw - Math.PI / 2;
      this.flag.rotation.y = Math.sin(performance.now() * 0.012 + this.design.seed) * 0.25;
    }
    for (const l of this.lanterns) l.material.emissiveIntensity = night * 3;
    if (this.lens) this.lens.material.emissiveIntensity = this.lightOn ? 4 : 0;
  }

  dispose(scene) { scene.remove(this.root); }
}
