import * as THREE from 'three';
import { mulberry32, rand, pick, randInt } from './util.js';
import { groundHeight } from './terrain.js';
import { patchFloodMaterial } from './shaders.js';

const TOWER_COLORS = [0x8a96a3, 0x6f7f8f, 0xa9a59a, 0x5d6b78, 0xb8b2a6, 0x7b8a86, 0x9aa7b4, 0x4f5d6a, 0xc2b8a3];
const MID_COLORS = [0x9c5a43, 0xb07b5c, 0xc9b79b, 0x8c6e5a, 0xa39283, 0x7d6656, 0xbfa98a, 0x6e7a73];
const HOUSE_COLORS = [0xd9c9a8, 0xc5d1d9, 0xe0b9a3, 0xb7c9a8, 0xe8dcc0, 0xa8b8c9, 0xd6a8a0, 0xf0e6d2, 0x9fb3a0];
const ROOF_COLORS = [0x5a3a32, 0x3f4247, 0x6b4a3a, 0x4a4f58, 0x7a5040];
const WARE_COLORS = [0x8f8f86, 0x7a8288, 0x9a8a72, 0x6f7d73];
const CONTAINER_COLORS = [0xb33a2e, 0x2e5fa3, 0x2f8a52, 0xd19a2a, 0x6b6f75, 0xa34f2e, 0x2a7f8a];

/**
 * Procedural harbor city. Every solid thing a boat can hit is an axis-aligned
 * collider { minx, maxx, minz, maxz, top } stored in a uniform spatial hash.
 */
export class City {
  constructor(scene, uniforms, floorMap) {
    this.colliders = [];
    this.grid = new Map();
    this.cell = 40;
    this.mark = [];
    this.qid = 0;
    const rng = mulberry32(1234);
    this.walls = []; this.plain = []; this.roofs = []; this.cars = [];

    this.generateBlocks(rng);
    this.generateHarbor(rng);

    for (const c of this.colliders) floorMap.stampBox(c.minx, c.maxx, c.minz, c.maxz, c.top);
    this.mark = new Int32Array(this.colliders.length);

    this.buildMeshes(scene, uniforms);
  }

  // ---- generation -------------------------------------------------------
  box(list, minx, maxx, y0, y1, minz, maxz, color, style = 0) {
    list.push({ minx, maxx, y0, y1, minz, maxz, color, style });
  }
  addCollider(minx, maxx, minz, maxz, top, kind, roof) {
    const c = { minx, maxx, minz, maxz, top, kind, roof: roof || { minx, maxx, minz, maxz, top }, used: false, id: this.colliders.length };
    this.colliders.push(c);
    const s = this.cell;
    for (let cx = Math.floor(minx / s); cx <= Math.floor(maxx / s); cx++)
      for (let cz = Math.floor(minz / s); cz <= Math.floor(maxz / s); cz++) {
        const key = (cx + 5000) * 10000 + (cz + 5000);
        let arr = this.grid.get(key); if (!arr) this.grid.set(key, (arr = []));
        arr.push(c.id);
      }
    return c;
  }
  minGround(minx, maxx, minz, maxz) {
    return Math.min(groundHeight(minx, minz), groundHeight(maxx, minz), groundHeight(minx, maxz),
      groundHeight(maxx, maxz), groundHeight((minx + maxx) / 2, (minz + maxz) / 2));
  }

  generateBlocks(rng) {
    const BLOCK = 78, STREET = 14;
    for (let bz = -66; bz - BLOCK > -1170; bz -= BLOCK) {
      for (let bx = -1014; bx + BLOCK < 1014; bx += BLOCK) {
        const x0 = bx + STREET / 2, x1 = bx + BLOCK - STREET / 2;
        const z0 = bz - BLOCK + STREET / 2, z1 = bz - STREET / 2;
        const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
        const hs = [groundHeight(x0, z0), groundHeight(x1, z0), groundHeight(x0, z1), groundHeight(x1, z1)];
        if (Math.max(...hs) - Math.min(...hs) > 10) continue;
        this.scatterCars(rng, bx, bz, BLOCK, STREET);
        if (rng() < 0.07) continue; // park / vacant lot
        const dd = Math.hypot(cx * 0.9, (cz + 700) * 1.15);
        if (cz > -200 && Math.abs(cx) < 680) this.harborBlock(rng, x0, x1, z0, z1);
        else if (dd < 340) this.downtownBlock(rng, x0, x1, z0, z1, dd);
        else if (dd < 620) this.midBlock(rng, x0, x1, z0, z1);
        else this.houseBlock(rng, x0, x1, z0, z1);
      }
    }
  }

  scatterCars(rng, bx, bz, BLOCK, STREET) {
    const n = randInt(rng, 0, 3);
    for (let i = 0; i < n; i++) {
      const alongX = rng() < 0.5;
      const lane = rng() < 0.5 ? -2.5 : 2.5;
      const x = alongX ? bx + rand(rng, 10, BLOCK - 10) : bx + lane;
      const z = alongX ? bz + lane : bz - rand(rng, 10, BLOCK - 10);
      this.cars.push({ x, z, y: groundHeight(x, z), rot: alongX ? Math.PI / 2 : 0, color: pick(rng, CONTAINER_COLORS.concat([0xdddddd, 0x222222, 0x8899aa])) });
    }
  }

  tower(rng, x0, x1, z0, z1, h, color, style) {
    const g = this.minGround(x0, x1, z0, z1) - 2;
    const top = g + 2 + h;
    let roof = { minx: x0, maxx: x1, minz: z0, maxz: z1, top };
    if (rng() < 0.45 && h > 30) {
      const h1 = g + 2 + h * rand(rng, 0.35, 0.65);
      this.box(this.walls, x0, x1, g, h1, z0, z1, color, style);
      const ix = (x1 - x0) * rand(rng, 0.12, 0.25), iz = (z1 - z0) * rand(rng, 0.12, 0.25);
      roof = { minx: x0 + ix, maxx: x1 - ix, minz: z0 + iz, maxz: z1 - iz, top };
      this.box(this.walls, roof.minx, roof.maxx, h1, top, roof.minz, roof.maxz, color, style);
    } else {
      this.box(this.walls, x0, x1, g, top, z0, z1, color, style);
    }
    // roof clutter
    const nAc = randInt(rng, 0, 3);
    for (let i = 0; i < nAc; i++) {
      const ax = rand(rng, roof.minx + 2, roof.maxx - 4), az = rand(rng, roof.minz + 2, roof.maxz - 4);
      this.box(this.plain, ax, ax + 2.2, top, top + 1.4, az, az + 1.6, 0x9a9a98);
    }
    if (rng() < 0.25 && h > 60) {
      const mx = (roof.minx + roof.maxx) / 2, mz = (roof.minz + roof.maxz) / 2;
      this.box(this.plain, mx - 0.6, mx + 0.6, top, top + rand(rng, 8, 22), mz - 0.6, mz + 0.6, 0xbbbbbb);
    }
    this.addCollider(x0, x1, z0, z1, top, h > 30 ? 'tower' : 'building', roof);
  }

  downtownBlock(rng, x0, x1, z0, z1, dd) {
    const layout = rng();
    const lots = [];
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    if (layout < 0.3) lots.push([x0, x1, z0, z1]);
    else if (layout < 0.6) { if (rng() < 0.5) lots.push([x0, mx - 2, z0, z1], [mx + 2, x1, z0, z1]); else lots.push([x0, x1, z0, mz - 2], [x0, x1, mz + 2, z1]); }
    else lots.push([x0, mx - 2, z0, mz - 2], [mx + 2, x1, z0, mz - 2], [x0, mx - 2, mz + 2, z1], [mx + 2, x1, mz + 2, z1]);
    const k = 1 - dd / 340;
    for (const [a, b, c, d] of lots) {
      if (rng() < 0.08) continue;
      const inset = rand(rng, 0.5, 3.5);
      const h = 32 + Math.pow(rng(), 1.4) * 200 * (0.35 + 0.65 * k);
      this.tower(rng, a + inset, b - inset, c + inset, d - inset, h, pick(rng, TOWER_COLORS), 1);
    }
  }

  midBlock(rng, x0, x1, z0, z1) {
    const nx = randInt(rng, 1, 3), nz = randInt(rng, 1, 2);
    const w = (x1 - x0) / nx, dz = (z1 - z0) / nz;
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      if (rng() < 0.12) continue;
      const inset = rand(rng, 1, 4);
      const h = rand(rng, 10, 42);
      this.tower(rng, x0 + i * w + inset, x0 + (i + 1) * w - inset, z0 + j * dz + inset, z0 + (j + 1) * dz - inset, h,
        pick(rng, MID_COLORS), 2);
    }
  }

  houseBlock(rng, x0, x1, z0, z1) {
    const n = 3, w = (x1 - x0) / n, d = (z1 - z0) / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      if (i === 1 && j === 1) continue; // backyard
      if (rng() < 0.15) continue;
      const cx = x0 + (i + 0.5) * w + rand(rng, -2, 2), cz = z0 + (j + 0.5) * d + rand(rng, -2, 2);
      const hw = rand(rng, 4, 6.5), hd = rand(rng, 4, 6);
      const g = this.minGround(cx - hw, cx + hw, cz - hd, cz + hd) - 1;
      const wallTop = g + 1 + rand(rng, 3, 6.5);
      const roofH = rand(rng, 2, 3.5);
      this.box(this.walls, cx - hw, cx + hw, g, wallTop, cz - hd, cz + hd, pick(rng, HOUSE_COLORS), 2);
      this.roofs.push({ x: cx, z: cz, y: wallTop, w: (hw + 0.5) * 2, d: (hd + 0.5) * 2, h: roofH, color: pick(rng, ROOF_COLORS) });
      const top = wallTop + roofH;
      this.addCollider(cx - hw, cx + hw, cz - hd, cz + hd, top, 'house',
        { minx: cx - hw * 0.4, maxx: cx + hw * 0.4, minz: cz - hd * 0.4, maxz: cz + hd * 0.4, top: wallTop + roofH * 0.7 });
    }
  }

  harborBlock(rng, x0, x1, z0, z1) {
    const mz = (z0 + z1) / 2;
    const halves = rng() < 0.5 ? [[z0, z1]] : [[z0, mz - 3], [mz + 3, z1]];
    for (const [a, b] of halves) {
      if (rng() < 0.3) {
        // container yard
        for (let r = 0; r < 4; r++) {
          const cx = x0 + 6 + r * ((x1 - x0 - 12) / 4);
          const stack = randInt(rng, 1, 3);
          const g = this.minGround(cx, cx + 2.5, a, a + 12);
          for (let s = 0; s < stack; s++)
            this.box(this.plain, cx, cx + 2.5, g + s * 2.6, g + (s + 1) * 2.6, a + 2, a + 14, pick(rng, CONTAINER_COLORS));
          this.addCollider(cx, cx + 2.5, a + 2, a + 14, g + stack * 2.6, 'containers');
        }
        continue;
      }
      const inset = rand(rng, 2, 6);
      this.tower(rng, x0 + inset, x1 - inset, a + inset, b - inset, rand(rng, 7, 15), pick(rng, WARE_COLORS), 3);
    }
  }

  generateHarbor(rng) {
    // Quay wall along the shore.
    this.box(this.plain, -660, 660, -6, 2.2, -14, 2, 0x77756f);
    this.addCollider(-660, 660, -14, 2, 2.2, 'quay');
    // Piers with pilings.
    for (let x = -600; x <= 600; x += 100) {
      if (Math.abs(x) < 40) continue;
      const len = rand(rng, 45, 90);
      this.box(this.plain, x - 4, x + 4, 1.5, 2.1, 2, 2 + len, 0x6b5640);
      for (let z = 6; z < len; z += 8) {
        this.box(this.plain, x - 3.8, x - 3.2, -9, 1.5, z, z + 0.6, 0x3e3226);
        this.box(this.plain, x + 3.2, x + 3.8, -9, 1.5, z, z + 0.6, 0x3e3226);
      }
      this.addCollider(x - 4, x + 4, 2, 2 + len, 2.1, 'pier');
    }
    // Breakwater with lighthouse.
    const bwz = 330;
    for (const [a, b] of [[-950, -130], [130, 760]]) {
      for (let x = a; x < b; x += 40) {
        const e = Math.min(b, x + 40);
        this.box(this.plain, x, e, -22, 3.5 + rng() * 0.6, bwz - 7, bwz + 7, 0x6c6a64);
        this.addCollider(x, e, bwz - 7, bwz + 7, 3.8, 'breakwater');
      }
    }
    this.lighthousePos = new THREE.Vector3(-128, 0, bwz);
    this.addCollider(-136, -120, bwz - 8, bwz + 8, 26, 'lighthouse');
    // Gantry cranes on the quay.
    for (const x of [-420, -300, 260, 380]) {
      const col = x < 0 ? 0xd1a12a : 0xb8392c;
      this.box(this.plain, x - 7, x - 5.5, 2.2, 30, -12, -10.5, col);
      this.box(this.plain, x + 5.5, x + 7, 2.2, 30, -12, -10.5, col);
      this.box(this.plain, x - 7, x - 5.5, 2.2, 30, -2, -0.5, col);
      this.box(this.plain, x + 5.5, x + 7, 2.2, 30, -2, -0.5, col);
      this.box(this.plain, x - 7.5, x + 7.5, 30, 33, -12.5, 0, col);
      this.box(this.plain, x - 1.5, x + 1.5, 31, 33.5, -40, 45, col);
      this.addCollider(x - 7, x - 5.5, -12, -0.5, 30, 'crane');
      this.addCollider(x + 5.5, x + 7, -12, -0.5, 30, 'crane');
    }
  }

  // ---- meshes ------------------------------------------------------------
  instancedBoxes(list, mat, withStyle) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    let style;
    if (withStyle) {
      style = new Float32Array(list.length);
      geo.setAttribute('aStyle', new THREE.InstancedBufferAttribute(style, 1));
    }
    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    const m = new THREE.Matrix4(), col = new THREE.Color();
    list.forEach((b, i) => {
      m.makeScale(b.maxx - b.minx, b.y1 - b.y0, b.maxz - b.minz);
      m.setPosition((b.minx + b.maxx) / 2, (b.y0 + b.y1) / 2, (b.minz + b.maxz) / 2);
      mesh.setMatrixAt(i, m);
      mesh.setColorAt(i, col.setHex(b.color));
      if (style) style[i] = b.style;
    });
    mesh.castShadow = true; mesh.receiveShadow = true;
    return mesh;
  }

  buildMeshes(scene, uniforms) {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.82, metalness: 0.05 });
    patchFloodMaterial(wallMat, uniforms, true);
    scene.add(this.instancedBoxes(this.walls, wallMat, true));

    const plainMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    patchFloodMaterial(plainMat, uniforms, false);
    scene.add(this.instancedBoxes(this.plain, plainMat, false));

    // Pitched roofs: triangular prism, ridge along local z.
    const pr = new THREE.BufferGeometry();
    const v = [
      -0.5, 0, -0.5, 0.5, 0, -0.5, 0, 1, -0.5,
      0.5, 0, 0.5, -0.5, 0, 0.5, 0, 1, 0.5,
      -0.5, 0, 0.5, -0.5, 0, -0.5, 0, 1, -0.5, -0.5, 0, 0.5, 0, 1, -0.5, 0, 1, 0.5,
      0.5, 0, -0.5, 0.5, 0, 0.5, 0, 1, 0.5, 0.5, 0, -0.5, 0, 1, 0.5, 0, 1, -0.5,
    ];
    pr.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    pr.computeVertexNormals();
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, side: THREE.DoubleSide });
    patchFloodMaterial(roofMat, uniforms, false);
    const roofs = new THREE.InstancedMesh(pr, roofMat, this.roofs.length);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3(), col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    this.roofs.forEach((r, i) => {
      const alongZ = r.d >= r.w;
      q.setFromAxisAngle(up, alongZ ? 0 : Math.PI / 2);
      s.set(alongZ ? r.w : r.d, r.h, alongZ ? r.d : r.w);
      p.set(r.x, r.y, r.z);
      m.compose(p, q, s); roofs.setMatrixAt(i, m); roofs.setColorAt(i, col.setHex(r.color));
    });
    roofs.castShadow = true; roofs.receiveShadow = true;
    scene.add(roofs);

    // Abandoned cars.
    const carGeo = new THREE.BoxGeometry(1.8, 1.4, 4.2); carGeo.translate(0, 0.7, 0);
    const carMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.4 });
    patchFloodMaterial(carMat, uniforms, false);
    const cars = new THREE.InstancedMesh(carGeo, carMat, this.cars.length);
    this.cars.forEach((c, i) => {
      q.setFromAxisAngle(up, c.rot); p.set(c.x, c.y, c.z); s.set(1, 1, 1);
      m.compose(p, q, s); cars.setMatrixAt(i, m); cars.setColorAt(i, col.setHex(c.color));
    });
    scene.add(cars);

    // Lighthouse.
    const lh = new THREE.Group();
    const white = new THREE.MeshStandardMaterial({ color: 0xeeeeea, roughness: 0.6 });
    const red = new THREE.MeshStandardMaterial({ color: 0xb02a22, roughness: 0.6 });
    const t1 = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 4.2, 22, 16), white); t1.position.y = 11 - 4;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.7, 4, 16), red); band.position.y = 9;
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 3, 12), new THREE.MeshStandardMaterial({ color: 0xfff1b0, emissive: 0xffd76a, emissiveIntensity: 0.4 }));
    lamp.position.y = 19.5;
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.8, 2.5, 12), red); cap.position.y = 22.2;
    for (const o of [t1, band, cap]) { o.castShadow = true; lh.add(o); }
    lh.add(lamp);
    const beamGeo = new THREE.ConeGeometry(9, 160, 16, 1, true); beamGeo.translate(0, -80, 0); beamGeo.rotateZ(Math.PI / 2);
    this.beamMat = new THREE.MeshBasicMaterial({ color: 0xfff2c4, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(beamGeo, this.beamMat); this.beam.position.y = 19.5;
    lh.add(this.beam);
    this.lampMat = lamp.material;
    lh.position.copy(this.lighthousePos); lh.position.y = 4;
    scene.add(lh);
  }

  update(dt, night, time) {
    this.beam.rotation.y = time * 0.6;
    this.beamMat.opacity = 0.16 * night;
    this.lampMat.emissiveIntensity = 0.3 + 3 * night;
  }

  // ---- queries -----------------------------------------------------------
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
      if (x > c.minx - margin && x < c.maxx + margin && z > c.minz - margin && z < c.maxz + margin) { hit = true; return false; }
    });
    return hit;
  }
  /** Highest collider top covering the point, or -Infinity. */
  topAt(x, z) {
    let t = -Infinity;
    this.forEachNear(x, z, 0.5, (c) => { if (x >= c.minx && x <= c.maxx && z >= c.minz && z <= c.maxz && c.top > t) t = c.top; });
    return t;
  }
  /** Circle vs rectangles whose top exceeds minTop; calls fn(nx, nz, penetration, collider). */
  circleContacts(x, z, r, minTop, fn) {
    this.forEachNear(x, z, r, (c) => {
      if (c.top <= minTop) return;
      const px = Math.max(c.minx, Math.min(x, c.maxx)), pz = Math.max(c.minz, Math.min(z, c.maxz));
      let dx = x - px, dz = z - pz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) return;
      let d = Math.sqrt(d2), pen;
      if (d < 1e-4) {
        // centre inside: push out along the shallowest axis
        const l = x - c.minx, rr = c.maxx - x, b = z - c.minz, t = c.maxz - z;
        const m = Math.min(l, rr, b, t);
        if (m === l) { dx = -1; dz = 0; } else if (m === rr) { dx = 1; dz = 0; } else if (m === b) { dx = 0; dz = -1; } else { dx = 0; dz = 1; }
        pen = m + r;
      } else { dx /= d; dz /= d; pen = r - d; }
      fn(dx, dz, pen, c);
    });
  }
}

export function rectDistance(rc, x, z) {
  const dx = Math.max(rc.minx - x, 0, x - rc.maxx), dz = Math.max(rc.minz - z, 0, z - rc.maxz);
  return Math.hypot(dx, dz);
}
