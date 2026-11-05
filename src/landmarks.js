import * as THREE from 'three';
import { groundHeight } from './terrain.js';
import { patchFloodMaterial } from './shaders.js';
import { buildHullGeometry } from './boat.js';
import { rectDistance } from './city.js';
import { floodLevel } from './environment.js';
import { mulberry32, pick, rand } from './util.js';

// Plots the procedural city must leave empty.
export const LANDMARK_RESERVED = [
  { minx: -335, maxx: -265, minz: -205, maxz: -125 }, // church
  { minx: -725, maxx: -555, minz: -400, maxz: -260 }, // stadium
  { minx: 585, maxx: 655, minz: -635, maxz: -565 },   // radio station
  { minx: -485, maxx: -415, minz: 95, maxz: 160 },    // funfair pier
];

const NOTES = {
  lighthouse: {
    title: "Keeper's log — last entry",
    text: 'Lamp oil for nine more nights. The town’s lights went out one street at a time, like someone walking home and switching them off behind them. I’ll keep this one burning as long as I can. If you are reading this, I hope you followed it here.',
  },
  ship: {
    title: 'MV Kestrel Bay — bridge log',
    text: 'Day 3 of the surge. Harbour master ordered all vessels out; we lost steerage at the breakwater and grounded on the bar. Crew of 14 evacuated by the coast guard. Two stayed with the ship. There is fuel in the aft bunkers and the reefer containers are still cold. Whoever finds her: she was a good ship.',
  },
  funfair: {
    title: 'Hand-painted sign, ticket booth',
    text: '“RIDES CLOSED — FLOOD WARNING.” Underneath, in marker: “Waited for Mum here 2 days. Gone to the church on the hill road. — Ellie (age 12) + Biscuit.” Someone has crossed out “church” and written “stadium?”',
  },
  church: {
    title: "St. Brendan's — notice on the door",
    text: 'Patron saint of sailors. The bell still rings. If you are lost on the water, ring it once at dusk and wait: people in the drowned streets will hear and show themselves. We have gone to higher ground. Take what you need from the crypt. — Fr. Okafor',
  },
  stadium: {
    title: 'Evacuation notice (laminated)',
    text: 'HARBOR STADIUM — DESIGNATED SHELTER. Buses to the northern ridge depart from Gate C every two hours. Bring water, medication, ID. Pets permitted in carriers. … The last bus left on the Tuesday. Not everyone was on it.',
  },
  radio: {
    title: 'KFLD relay station — transcript taped to the console',
    text: '“…this is KFLD on emergency power. If you can hear this, you are not alone. Boats are gathering in the east channel. Light a fire on your roof at night. Do not drink the floodwater. Repeat: you are not alone…” The transmitter still works. It just needs someone to speak.',
  },
};

export class Landmarks {
  constructor(game, scene, city, floorMap, uniforms) {
    this.game = game; this.scene = scene; this.city = city; this.floorMap = floorMap; this.uniforms = uniforms;
    this.rng = mulberry32(777);
    this.list = [];
    this.blinkers = []; this.nightGlow = [];
    const before = city.colliders.length;
    this.buildLighthouse();
    this.buildShip();
    this.buildFunfair();
    this.buildChurch();
    this.buildStadium();
    this.buildRadio();
    for (let i = before; i < city.colliders.length; i++) {
      const c = city.colliders[i]; floorMap.stampBox(c.minx, c.maxx, c.minz, c.maxz, c.top);
    }
    city.mark = new Int32Array(city.colliders.length);
  }

  // ---- helpers ---------------------------------------------------------------
  mat(color, opts = {}) {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, ...opts });
    patchFloodMaterial(m, this.uniforms, false);
    return m;
  }
  box(parent, color, sx, sy, sz, x, y, z, opts) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), color.isMaterial ? color : this.mat(color, opts));
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  }
  /** World-space axis-aligned box: visual + collider. */
  solid(parent, color, minx, maxx, y0, y1, minz, maxz, opts, roof) {
    this.box(parent, color, maxx - minx, y1 - y0, maxz - minz, (minx + maxx) / 2, (y0 + y1) / 2, (minz + maxz) / 2, opts);
    return this.city.addCollider(minx, maxx, minz, maxz, y1, 'landmark', roof);
  }
  minGround(x, z, r) {
    let g = Infinity;
    for (const [dx, dz] of [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) g = Math.min(g, groundHeight(x + dx, z + dz));
    return g;
  }
  add(def) {
    const lm = { discovered: false, visited: false, rescued: false, actionDay: -1, groupSpawned: false, note: NOTES[def.id], ...def };
    this.list.push(lm);
    return lm;
  }

  // ---- the six landmarks --------------------------------------------------------
  buildLighthouse() {
    // Geometry already exists in the city; add the keeper and the story.
    const p = this.city.lighthousePos;
    const c = this.city.colliders.find((k) => k.kind === 'lighthouse');
    c.roof = { minx: p.x - 3, maxx: p.x + 3, minz: p.z - 3, maxz: p.z + 3, top: 21.6 };
    this.add({ id: 'lighthouse', name: 'Breakwater Lighthouse', x: p.x, z: p.z, range: 1400,
      reach: { minx: p.x - 10, maxx: p.x + 10, minz: p.z - 10, maxz: p.z + 10 }, reachLevel: null,
      blurb: 'the lighthouse at the end of the breakwater. Its lamp is still lit.',
      loot: { fuel: 8, food: 4, cloth: 3, wood: 4 }, group: { c, people: 1, animal: 'cat' } });
  }

  buildShip() {
    const L = 150, B = 24, cx = 330, cz = 192, y0 = -2.6;
    const d = { length: L, beam: B, draft: 9, freeboard: 11, bowSharp: 0.75, vee: 0.25, n: 5, sheer: 2, sternFull: 0.95,
      hullColor: 0x2a3a4c, trimColor: 0xd8d8d0, bottomColor: 0x8a2a22 };
    const g = new THREE.Group(); g.position.set(cx, y0, cz); g.rotation.set(0.0, Math.PI / 2, 0.045); this.scene.add(g);
    const { geo } = buildHullGeometry(d);
    const hm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.2, side: THREE.DoubleSide });
    patchFloodMaterial(hm, this.uniforms, false);
    const hull = new THREE.Mesh(geo, hm); hull.castShadow = hull.receiveShadow = true; g.add(hull);
    const deckY = d.freeboard - 0.4;
    this.box(g, 0x5a5048, B * 0.94, 0.4, L * 0.84, 0, deckY, -L * 0.02);
    // containers (instanced)
    const cols = [0xb33a2e, 0x2e5fa3, 0x2f8a52, 0xd19a2a, 0x6b6f75, 0xa34f2e, 0x2a7f8a, 0xdadada];
    const slots = [];
    for (let zz = -L * 0.26; zz < L * 0.38; zz += 6.6) for (let xx = -B * 0.4; xx <= B * 0.4 + 0.01; xx += 2.6) {
      const h = 1 + Math.floor(this.rng() * 4);
      for (let k = 0; k < h; k++) slots.push([xx, deckY + 0.2 + 1.3 + k * 2.6, zz]);
    }
    const cm = this.mat(0xffffff, { roughness: 0.6, metalness: 0.3 });
    const inst = new THREE.InstancedMesh(new THREE.BoxGeometry(2.45, 2.55, 6.1), cm, slots.length);
    const m4 = new THREE.Matrix4(), col = new THREE.Color();
    slots.forEach((s, i) => { m4.makeTranslation(s[0], s[1], s[2]); inst.setMatrixAt(i, m4); inst.setColorAt(i, col.setHex(pick(this.rng, cols))); });
    inst.castShadow = inst.receiveShadow = true; g.add(inst);
    // bridge, funnel
    const bz = -L * 0.37;
    this.box(g, 0xeeeeea, B * 0.86, 14, 10, 0, deckY + 7, bz);
    for (let k = 0; k < 4; k++) this.box(g, 0x1a2530, B * 0.86 + 0.3, 0.9, 10.3, 0, deckY + 3 + k * 3, bz, { roughness: 0.15, metalness: 0.4 });
    this.box(g, 0xeeeeea, B * 1.0, 0.6, 7, 0, deckY + 13.6, bz + 1);
    this.box(g, 0xb33a2e, 4, 10, 5, 0, deckY + 17, bz - 7);
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.4, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 0 }));
    lamp.position.set(0, deckY + 23, bz - 7); g.add(lamp); this.blinkers.push(lamp.material);
    const top = y0 + deckY + 0.4;
    const crew = { minx: cx - L * 0.37 - 4, maxx: cx - L * 0.37 + 14, minz: cz - B / 2, maxz: cz + B / 2, top };
    const c = this.city.addCollider(cx - L / 2, cx + L / 2, cz - B / 2, cz + B / 2, top, 'landmark', crew);
    this.add({ id: 'ship', name: 'MV Kestrel Bay (aground)', x: cx, z: cz, range: 1500,
      reach: { minx: cx - L / 2, maxx: cx + L / 2, minz: cz - B / 2, maxz: cz + B / 2 }, reachLevel: null,
      blurb: 'a container ship aground on the bar, listing gently.',
      loot: { scrap: 18, parts: 6, fuel: 15, food: 8, water: 10, cloth: 4 }, group: { c, people: 2, animal: false } });
  }

  buildFunfair() {
    const cx = -450, cz = 125;
    const g = new THREE.Group(); this.scene.add(g);
    // pier platform on piles
    this.solid(g, 0x6b5640, cx - 25, cx + 25, -6, 3, cz - 25, cz + 25);
    // ticket booth with striped awning
    const booth = { minx: cx + 10, maxx: cx + 18, minz: cz - 20, maxz: cz - 13 };
    const bc = this.solid(g, 0xe8d8b0, booth.minx, booth.maxx, 3, 6.5, booth.minz, booth.maxz, undefined, { ...booth, top: 6.5 });
    for (let k = 0; k < 4; k++) this.box(g, k % 2 ? 0xffffff : 0xc8302a, 2, 0.25, 8.5, booth.minx + 1 + k * 2, 6.8, (booth.minz + booth.maxz) / 2);
    // the wheel: rims, spokes, gondolas, A-frame legs
    const hubY = 31, R = 24;
    const wheel = new THREE.Group(); wheel.position.set(cx, hubY, cz); g.add(wheel);
    const red = this.mat(0xc8302a, { metalness: 0.5, roughness: 0.5 });
    for (const zz of [-1.6, 1.6]) { const t = new THREE.Mesh(new THREE.TorusGeometry(R, 0.35, 6, 72), red); t.position.z = zz; t.castShadow = true; wheel.add(t); }
    const white = this.mat(0xf0f0ea, { metalness: 0.4, roughness: 0.5 });
    const N = 18;
    const bulbs = new THREE.MeshStandardMaterial({ color: 0xfff0c0, emissive: 0xffd080, emissiveIntensity: 0 });
    this.nightGlow.push(bulbs);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const sp = new THREE.Mesh(new THREE.BoxGeometry(0.25, R, 0.25), white);
      sp.position.set(Math.cos(a) * R / 2, Math.sin(a) * R / 2, 0); sp.rotation.z = a - Math.PI / 2; sp.castShadow = true; wheel.add(sp);
      const gx = Math.cos(a) * R, gy = Math.sin(a) * R;
      const gondola = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.4, 2.6), this.mat(pick(this.rng, [0x3a8ac8, 0xe8b830, 0x48a858, 0xd86848, 0xa060c0])));
      gondola.position.set(gx, gy - 1.8, 0); gondola.castShadow = true; wheel.add(gondola);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.25, 6, 4), bulbs); bulb.position.set(gx, gy, 1.9); wheel.add(bulb);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 4.2, 12), white); hub.rotation.x = Math.PI / 2; wheel.add(hub);
    wheel.rotation.z = 0.12; // stopped mid-turn
    for (const s of [-1, 1]) for (const zz of [-4, 4]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.8, 31, 0.8), white);
      leg.position.set(cx + s * 7, 3 + 14, cz + zz); leg.rotation.z = s * 0.24; leg.castShadow = true; g.add(leg);
    }
    this.city.addCollider(cx - 12, cx + 12, cz - 5, cz + 5, 40, 'landmark');
    this.add({ id: 'funfair', name: 'Pier 9 Funfair', x: cx, z: cz, range: 1500,
      reach: { minx: cx - 26, maxx: cx + 26, minz: cz - 26, maxz: cz + 26 }, reachLevel: null,
      blurb: 'a Ferris wheel standing in the harbour, stopped mid-turn.',
      loot: { cloth: 10, wood: 8, food: 3 }, group: { c: bc, people: 1, animal: 'dog', names: ['Ellie'] } });
  }

  buildChurch() {
    const cx = -300, cz = -165;
    const gr = this.minGround(cx, cz, 20) - 0.6;
    const g = new THREE.Group(); this.scene.add(g);
    const stone = 0xb9b2a2;
    const navH = 12;
    this.solid(g, stone, cx - 8, cx + 8, gr, gr + navH, cz - 18, cz + 14);
    // pitched nave roof
    const pr = new THREE.BufferGeometry();
    const v = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5, 0, 1, 0.5,
      -0.5, 0, 0.5, -0.5, 0, -0.5, 0, 1, -0.5, -0.5, 0, 0.5, 0, 1, -0.5, 0, 1, 0.5,
      0.5, 0, -0.5, 0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5];
    pr.setAttribute('position', new THREE.Float32BufferAttribute(v, 3)); pr.computeVertexNormals();
    const rm = this.mat(0x3f4650); rm.side = THREE.DoubleSide;
    const r = new THREE.Mesh(pr, rm); r.scale.set(17.5, 7, 33); r.position.set(cx, gr + navH, cz - 2); r.castShadow = true; g.add(r);
    // stained-glass windows glow faintly at night
    const glass = new THREE.MeshStandardMaterial({ color: 0x302838, emissive: 0xc08040, emissiveIntensity: 0 });
    this.nightGlow.push(glass);
    for (const s of [-1, 1]) for (let k = 0; k < 5; k++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.2, 5, 1.6), glass); w.position.set(cx + s * 8.05, gr + 6.5, cz - 14 + k * 6); g.add(w);
    }
    // tower + spire at the harbour (south) end
    const tz0 = cz + 14, tz1 = cz + 22, towerTop = gr + 28;
    this.solid(g, stone, cx - 4.5, cx + 4.5, gr, towerTop, tz0, tz1);
    for (const [dx, dz] of [[0, 4.6], [0, -4.6], [4.6, 0], [-4.6, 0]]) this.box(g, 0x18181c, Math.abs(dx) ? 0.3 : 3, 4, Math.abs(dz) ? 0.3 : 3, cx + dx, towerTop - 4, (tz0 + tz1) / 2 + dz);
    const spire = new THREE.Mesh(new THREE.ConeGeometry(6.2, 20, 4), this.mat(0x3f4650)); spire.rotation.y = Math.PI / 4;
    spire.position.set(cx, towerTop + 10, (tz0 + tz1) / 2); spire.castShadow = true; g.add(spire);
    this.box(g, 0xd8b040, 0.3, 3, 0.3, cx, towerTop + 21.5, (tz0 + tz1) / 2, { metalness: 0.8, roughness: 0.3 });
    this.box(g, 0xd8b040, 1.6, 0.3, 0.3, cx, towerTop + 22, (tz0 + tz1) / 2, { metalness: 0.8, roughness: 0.3 });
    this.box(g, 0x4a2a1a, 3, 4.5, 0.3, cx, gr + 2.25, tz1 + 0.1);
    this.add({ id: 'church', name: "St. Brendan's Church", x: cx, z: cz, range: 1300,
      reach: { minx: cx - 9, maxx: cx + 9, minz: cz - 19, maxz: tz1 + 1 }, reachLevel: null,
      blurb: 'a church spire over the drowned harbour district.',
      loot: { food: 8, water: 10, wood: 6 },
      action: { label: '[E] Ring the bell', desc: 'Once a day: survivors within earshot show themselves.' } });
  }

  buildStadium() {
    const cx = -640, cz = -330, rx = 72, rz = 56;
    const gr = this.minGround(cx, cz, 60) - 0.6;
    const g = new THREE.Group(); this.scene.add(g);
    // pitch
    this.box(g, 0x3e7a3a, rx * 1.3, 0.3, rz * 1.25, cx, gr + 0.15, cz);
    for (const zz of [-1, 1]) this.box(g, 0xf0f0f0, rx * 1.1, 0.4, 0.4, cx, gr + 0.2, cz + zz * rz * 0.5);
    const wallC = this.mat(0xb8b4aa), seatA = this.mat(0x2e5fa3), seatB = this.mat(0xc8302a);
    const N = 32, gates = new Set([31, 0, 1, 15, 16, 17]);
    let stand = null;
    for (let k = 0; k < N; k++) {
      if (gates.has(k)) continue;
      const a = (k / N) * Math.PI * 2;
      const seg = (2 * Math.PI * Math.sqrt((rx * rx + rz * rz) / 2)) / N + 0.6;
      // outer wall
      const ox = cx + Math.cos(a) * rx, oz = cz + Math.sin(a) * rz;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(5, 20, seg), wallC);
      wall.position.set(ox, gr + 10, oz); wall.rotation.y = -a; wall.castShadow = true; wall.receiveShadow = true; g.add(wall);
      const hx = Math.abs(Math.cos(a)) * 2.5 + Math.abs(Math.sin(a)) * seg / 2, hz = Math.abs(Math.sin(a)) * 2.5 + Math.abs(Math.cos(a)) * seg / 2;
      this.city.addCollider(ox - hx, ox + hx, oz - hz, oz + hz, gr + 20, 'landmark');
      // stepped stands inside the wall
      for (let t = 0; t < 3; t++) {
        const r0 = 1 - (7 + t * 5) / rx * 0.9;
        const sx = cx + Math.cos(a) * rx * r0, sz = cz + Math.sin(a) * rz * r0;
        const h = 14 - t * 4.5;
        const st = new THREE.Mesh(new THREE.BoxGeometry(5, h, seg * r0), t % 2 ? seatB : seatA);
        st.position.set(sx, gr + h / 2, sz); st.rotation.y = -a; st.castShadow = true; st.receiveShadow = true; g.add(st);
        const shx = Math.abs(Math.cos(a)) * 2.5 + Math.abs(Math.sin(a)) * seg * r0 / 2, shz = Math.abs(Math.sin(a)) * 2.5 + Math.abs(Math.cos(a)) * seg * r0 / 2;
        const c = this.city.addCollider(sx - shx, sx + shx, sz - shz, sz + shz, gr + h, 'landmark');
        if (k === 8 && t === 2) stand = c; // north-side front row
      }
    }
    // floodlight towers
    const lamps = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xf8f4e0, emissiveIntensity: 0 });
    this.nightGlow.push(lamps);
    for (const a of [0.7, 2.45, 3.85, 5.6]) {
      const x = cx + Math.cos(a) * (rx + 8), z = cz + Math.sin(a) * (rz + 8);
      this.box(g, 0x9a9a9a, 1.2, 42, 1.2, x, gr + 21, z, { metalness: 0.6 });
      const head = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 1), lamps); head.position.set(x, gr + 42, z); head.lookAt(cx, gr, cz); g.add(head);
      this.city.addCollider(x - 1, x + 1, z - 1, z + 1, gr + 42, 'landmark');
    }
    const reachLevel = gr + 1.6;
    this.add({ id: 'stadium', name: 'Harbor Stadium', x: cx, z: cz, range: 1600,
      reach: { minx: cx - rx * 0.55, maxx: cx + rx * 0.55, minz: cz - rz * 0.5, maxz: cz + rz * 0.5 }, reachLevel,
      blurb: 'a stadium bowl rising out of the east side. Its gates face east and west.',
      loot: { food: 15, water: 15, cloth: 6, parts: 2 }, group: { c: stand, people: 3, animal: 'goat' } });
  }

  buildRadio() {
    const cx = 620, cz = -600;
    const gr = this.minGround(cx, cz, 12) - 0.4;
    const g = new THREE.Group(); this.scene.add(g);
    this.solid(g, 0xd8d0c0, cx - 4, cx + 4, gr, gr + 3.6, cz - 3, cz + 3);
    this.box(g, 0x555555, 8.6, 0.3, 6.6, cx, gr + 3.75, cz);
    const dish = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8, 0, Math.PI * 2, 0, Math.PI / 3), this.mat(0xe8e8e8, { side: THREE.DoubleSide }));
    dish.position.set(cx + 2, gr + 4.4, cz); dish.rotation.x = -1.0; g.add(dish);
    // lattice mast: four tapering legs with cross-bracing, red/white bands
    const mx = cx - 9, mz = cz, H = 92;
    for (let k = 0; k < 12; k++) {
      const y0 = gr + (k / 12) * H, y1 = gr + ((k + 1) / 12) * H, w = 3.2 * (1 - k / 14);
      const c = k % 2 ? 0xc8302a : 0xf0f0f0;
      for (const [sx, sz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) this.box(g, c, 0.3, y1 - y0, 0.3, mx + sx * w / 2, (y0 + y1) / 2, mz + sz * w / 2, { metalness: 0.5 });
      for (const s of [1, -1]) {
        const br = this.box(g, 0x999999, w * 1.4, 0.12, 0.12, mx, (y0 + y1) / 2, mz + s * w / 2, { metalness: 0.5 }); br.rotation.z = 0.8;
        const br2 = this.box(g, 0x999999, 0.12, 0.12, w * 1.4, mx + s * w / 2, (y0 + y1) / 2, mz, { metalness: 0.5 }); br2.rotation.x = 0.8;
      }
    }
    const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6), new THREE.MeshStandardMaterial({ color: 0xff2010, emissive: 0xff2010, emissiveIntensity: 0 }));
    beacon.position.set(mx, gr + H + 0.6, mz); g.add(beacon); this.blinkers.push(beacon.material);
    this.city.addCollider(mx - 2, mx + 2, mz - 2, mz + 2, gr + H, 'landmark');
    this.add({ id: 'radio', name: 'KFLD Relay Station', x: cx, z: cz, range: 2000,
      reach: { minx: cx - 6, maxx: cx + 6, minz: cz - 5, maxz: cz + 5 }, reachLevel: gr + 1.3,
      blurb: 'a radio mast on the east side, red light still blinking.',
      loot: { parts: 6, scrap: 8 },
      action: { label: '[E] Broadcast to survivors', desc: 'Once: boats out there will come looking for you.', once: true } });
  }

  // ---- runtime ------------------------------------------------------------------
  /** Day on which the flood first reaches `lvl` (ignoring tides), for the journal. */
  dayForLevel(lvl) {
    const env = this.game.env; const off = env.levelOffset;
    for (let d = 0; d < 400; d += 0.25) if (floodLevel(d) + off >= lvl) return Math.floor(d) + 1;
    return null;
  }
  reachable(lm) { return lm.reachLevel == null || this.game.env.level >= lm.reachLevel; }

  update(dt, ctx) {
    const g = this.game, pl = g.fleet.player; if (!pl) return;
    const night = ctx.env.night, t = performance.now() / 1000;
    for (const m of this.blinkers) m.emissiveIntensity = (Math.sin(t * 2.2) > 0.6 ? 4 : 0.2) * (0.3 + night);
    for (const m of this.nightGlow) m.emissiveIntensity = night * 1.6 * Math.max(0.15, g.floodUniforms.uPower.value);
    this.timer = (this.timer || 0) - dt;
    if (this.timer > 0) return;
    this.timer = 1;
    const sight = g.ui.sight || 320;
    for (const lm of this.list) {
      const d = Math.hypot(lm.x - pl.x, lm.z - pl.z);
      if (!lm.discovered && d < Math.min(lm.range, Math.max(330, sight * 1.6))) {
        lm.discovered = true;
        g.ui.toast(`Landmark sighted: ${lm.name} — ${lm.blurb}`, 'info');
        g.audio.chime();
      }
      // landmark survivors appear when you're close enough to see them, until rescued
      if (lm.group && !lm.rescued && !lm.groupSpawned && d < 700 && lm.group.c.roof.top > ctx.water.level + 0.3) {
        const grp = g.world.spawnSurvivorGroup(lm.group.c, { people: lm.group.people, animal: lm.group.animal });
        grp.landmark = lm;
        if (lm.group.names) grp.people.forEach((p, i) => { if (lm.group.names[i]) p.name = lm.group.names[i]; });
        lm.groupSpawned = true;
      }
    }
  }

  /** Interaction offered by a landmark near the player's boat, if any. */
  findInteraction(pl) {
    let best = null, bd = Infinity;
    for (const lm of this.list) {
      if (!lm.discovered) continue;
      const d = rectDistance(lm.reach, pl.x, pl.z) - pl.B * 0.5;
      if (d > 9 || d >= bd || !this.reachable(lm)) continue;
      if (!lm.visited) { bd = d; best = { kind: 'landmark', target: lm, label: `[E] Explore ${lm.name}` }; }
      else if (lm.action && !(lm.action.once && lm.actionDone)) { bd = d; best = { kind: 'landmark', target: lm, label: lm.action.label }; }
    }
    return best;
  }

  interact(lm) {
    const g = this.game, f = g.fleet, ui = g.ui;
    if (!lm.visited) {
      lm.visited = true;
      const got = [];
      for (const [r, n] of Object.entries(lm.loot || {})) { const a = f.give(r, n); if (a > 0) got.push(`+${Math.round(a)} ${r}`); }
      ui.toast(`${lm.name}: ${got.join(', ') || 'your holds are full'}`, 'loot');
      f.morale = Math.min(100, f.morale + 3);
      ui.showNote(lm.note.title, lm.note.text);
      g.audio.chime();
      return;
    }
    if (lm.id === 'church') {
      if (lm.actionDay === g.env.day) { ui.toast('The bell has rung today. Come back tomorrow.'); return; }
      lm.actionDay = g.env.day;
      const w = g.world; let n = 0;
      for (const grp of w.groups) if (Math.hypot(grp.x - lm.x, grp.z - lm.z) < 1600) { grp.seen = true; n++; }
      for (const c of w.caches) if (Math.hypot(c.x - lm.x, c.z - lm.z) < 1600) c.seen = true;
      w.groupTimer = Math.min(w.groupTimer, 0.3);
      f.morale = Math.min(100, f.morale + 3);
      g.audio.tone(392, 3.5, 'sine', 0.18); g.audio.tone(196, 4.5, 'sine', 0.12, 0.05);
      ui.toast(n ? `The bell rolls out over the water. ${n} group${n > 1 ? 's' : ''} of survivors answer — marked on your chart.` : 'The bell rolls out over the water. Somewhere out there, someone will have heard.', 'good');
    } else if (lm.id === 'radio') {
      lm.actionDone = true;
      const w = g.world;
      for (let i = 0; i < 2; i++) {
        const pt = w.randomWaterPoint(lm.x, lm.z, 350, 650, 2.5, 6, 12);
        if (!pt) continue;
        const kind = pick(w.rng, ['fishing', 'sailboat', 'houseboat', 'skiff']);
        const b = w.spawnBoat(kind, pt.x, pt.z, 'npc');
        const PersonCtor = g.playerPerson.constructor;
        const n = 1 + Math.floor(w.rng() * 3);
        for (let k = 0; k < n; k++) b.addPerson(new PersonCtor(w.rng));
        b.ai.target = { x: g.fleet.player.x + rand(w.rng, -30, 30), z: g.fleet.player.z + rand(w.rng, -30, 30) };
        b.ai.seekPlayer = true;
        b.seen = true;
      }
      ui.toast('“…this is the floatilla. We are at the relay station. We have room.” Two boats answer. They are coming.', 'good');
      g.audio.chime();
    }
  }

  // ---- save / load ------------------------------------------------------------------
  serialize() {
    const out = {};
    for (const lm of this.list) out[lm.id] = { d: lm.discovered, v: lm.visited, r: lm.rescued, a: lm.actionDay, ad: !!lm.actionDone };
    return out;
  }
  restore(data) {
    if (!data) return;
    for (const lm of this.list) {
      const s = data[lm.id]; if (!s) continue;
      lm.discovered = s.d; lm.visited = s.v; lm.rescued = s.r; lm.actionDay = s.a; lm.actionDone = s.ad;
    }
  }
}
