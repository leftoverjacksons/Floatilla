import * as THREE from 'three';

/** Pooled foam/wake/spray particles rendered as soft round points. */
export class Fx {
  constructor(scene, max = 3000) {
    this.max = max; this.n = 0; this.head = 0;
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.kind = new Uint8Array(max); // 0 foam on surface, 1 spray (ballistic), 2 smoke
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.alphaAttr = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.sizeAttr = new THREE.BufferAttribute(new Float32Array(max), 1);
    this.colAttr = new THREE.BufferAttribute(new Float32Array(max * 3), 3);
    g.setAttribute('aAlpha', this.alphaAttr); g.setAttribute('aSize', this.sizeAttr); g.setAttribute('aColor', this.colAttr);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 400 }, uLight: { value: 1 } },
      vertexShader: `attribute float aAlpha; attribute float aSize; attribute vec3 aColor; varying float vA; varying vec3 vC; uniform float uScale;
        void main(){ vA = aAlpha; vC = aColor; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * uScale / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `varying float vA; varying vec3 vC; uniform float uLight;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = dot(d,d); if (r > 0.25) discard; gl_FragColor = vec4(vC * uLight, vA * (1.0 - r * 4.0));
        #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = 2;
    scene.add(this.points);

    // Surface foam (wakes, bow waves) as flat patches lying on the water.
    this.dMax = 1800; this.dHead = 0;
    this.d = { x: new Float32Array(this.dMax), y: new Float32Array(this.dMax), z: new Float32Array(this.dMax), vx: new Float32Array(this.dMax), vz: new Float32Array(this.dMax),
      life: new Float32Array(this.dMax), max: new Float32Array(this.dMax), size: new Float32Array(this.dMax), rot: new Float32Array(this.dMax) };
    const pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
    this.dAlpha = new THREE.InstancedBufferAttribute(new Float32Array(this.dMax), 1);
    this.dSeed = new THREE.InstancedBufferAttribute(new Float32Array(this.dMax).map(() => Math.random() * 100), 1);
    pg.setAttribute('aAlpha', this.dAlpha); pg.setAttribute('aSeed', this.dSeed);
    this.dMat = new THREE.ShaderMaterial({
      uniforms: { uLight: { value: 1 }, uTime: { value: 0 } },
      vertexShader: `attribute float aAlpha; attribute float aSeed; varying float vA; varying float vS; varying vec2 vUv;
        void main(){ vA = aAlpha; vS = aSeed; vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`,
      fragmentShader: `varying float vA; varying float vS; varying vec2 vUv; uniform float uLight; uniform float uTime;
        float h(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
        float n(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f); return mix(mix(h(i),h(i+vec2(1,0)),u.x), mix(h(i+vec2(0,1)),h(i+vec2(1,1)),u.x), u.y); }
        void main(){
          vec2 d = vUv - 0.5; float r = length(d) * 2.0;
          if (r > 1.0) discard;
          vec2 q = vUv * 6.0 + vS;
          float bub = n(q) * 0.6 + n(q * 2.3 + 7.0) * 0.4;
          float lace = smoothstep(0.42, 0.62, bub);              // lacy, broken-up foam
          float edge = 1.0 - smoothstep(0.55, 1.0, r);
          float a = lace * edge * vA;
          if (a < 0.01) discard;
          gl_FragColor = vec4(vec3(0.9, 0.93, 0.94) * uLight, a);
          #include <colorspace_fragment>
        }`,
      transparent: true, depthWrite: false,
    });
    this.decals = new THREE.InstancedMesh(pg, this.dMat, this.dMax);
    this.decals.frustumCulled = false; this.decals.renderOrder = 1.5;
    this.decals.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.dMax; i++) this.decals.setMatrixAt(i, zero);
    scene.add(this.decals);
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._p = new THREE.Vector3(); this._s = new THREE.Vector3(); this._up = new THREE.Vector3(0, 1, 0);
  }
  emitFoam(x, y, z, vx, vz, life, size) {
    const i = this.dHead; this.dHead = (this.dHead + 1) % this.dMax;
    const d = this.d;
    d.x[i] = x; d.y[i] = y; d.z[i] = z; d.vx[i] = vx; d.vz[i] = vz; d.life[i] = life; d.max[i] = life; d.size[i] = size; d.rot[i] = Math.random() * 6.28;
  }
  emit(x, y, z, vx, vy, vz, life, size, kind = 0, r = 0.92, gr = 0.95, b = 0.95) {
    if (kind === 0) return this.emitFoam(x, y, z, vx, vz, life * 1.6, size * 1.3);
    const i = this.head; this.head = (this.head + 1) % this.max;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size; this.kind[i] = kind;
    const c = this.colAttr.array; c[i * 3] = r; c[i * 3 + 1] = gr; c[i * 3 + 2] = b;
  }
  update(dt, water, light) {
    this.mat.uniforms.uLight.value = light;
    const a = this.alphaAttr.array, s = this.sizeAttr.array;
    for (let i = 0; i < this.max; i++) {
      if (this.life[i] <= 0) { a[i] = 0; continue; }
      this.life[i] -= dt;
      const t = 1 - this.life[i] / this.maxLife[i];
      const k = this.kind[i];
      const o = i * 3;
      this.pos[o] += this.vel[o] * dt; this.pos[o + 2] += this.vel[o + 2] * dt;
      if (k === 1) { this.vel[o + 1] -= 9.8 * dt; this.pos[o + 1] += this.vel[o + 1] * dt; }
      else if (k === 2) { this.pos[o + 1] += this.vel[o + 1] * dt; }
      else if ((i & 7) === (this._tick & 7)) this.pos[o + 1] = water.heightFast(this.pos[o], this.pos[o + 2]) + 0.06;
      this.vel[o] *= 0.97; this.vel[o + 2] *= 0.97;
      a[i] = k === 2 ? (1 - t) * 0.35 : (1 - t) * (k === 1 ? 0.8 : 0.7);
      s[i] = this.size[i] * (k === 0 ? 0.6 + t * 1.8 : k === 2 ? 1 + t * 3 : 1);
    }
    this._tick = (this._tick || 0) + 1;
    // foam decals
    const d = this.d, m = this._m;
    this.dMat.uniforms.uLight.value = light;
    const al = this.dAlpha.array;
    for (let i = 0; i < this.dMax; i++) {
      if (d.life[i] <= 0) { if (al[i] !== 0) { al[i] = 0; m.makeScale(0, 0, 0); this.decals.setMatrixAt(i, m); } continue; }
      d.life[i] -= dt;
      const t = 1 - d.life[i] / d.max[i];
      d.x[i] += d.vx[i] * dt; d.z[i] += d.vz[i] * dt; d.vx[i] *= 0.985; d.vz[i] *= 0.985;
      if (((i + this._tick) & 3) === 0) d.y[i] = water.heightFast(d.x[i], d.z[i]) + 0.04;
      const sc = d.size[i] * (0.5 + t * 1.6);
      this._p.set(d.x[i], d.y[i], d.z[i]); this._q.setFromAxisAngle(this._up, d.rot[i] + t * 0.3); this._s.set(sc, 1, sc);
      m.compose(this._p, this._q, this._s); this.decals.setMatrixAt(i, m);
      al[i] = Math.min(1, t * 6) * (1 - t) * 0.85;
    }
    this.decals.instanceMatrix.needsUpdate = true; this.dAlpha.needsUpdate = true;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.alphaAttr.needsUpdate = true; this.sizeAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
  }
}
