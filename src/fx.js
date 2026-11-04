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
  }
  emit(x, y, z, vx, vy, vz, life, size, kind = 0, r = 0.92, gr = 0.95, b = 0.95) {
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
      else if ((i & 7) === (this._tick & 7)) this.pos[o + 1] = water.heightAt(this.pos[o], this.pos[o + 2]) + 0.06;
      this.vel[o] *= 0.97; this.vel[o + 2] *= 0.97;
      a[i] = k === 2 ? (1 - t) * 0.35 : (1 - t) * (k === 1 ? 0.8 : 0.7);
      s[i] = this.size[i] * (k === 0 ? 0.6 + t * 1.8 : k === 2 ? 1 + t * 3 : 1);
    }
    this._tick = (this._tick || 0) + 1;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.alphaAttr.needsUpdate = true; this.sizeAttr.needsUpdate = true; this.colAttr.needsUpdate = true;
  }
}
