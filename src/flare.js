import * as THREE from 'three';

/**
 * A distress flare's smoke column: a few dozen large, soft puffs that leave the flare bright orange,
 * cool to grey as they rise, swell, and lean downwind. Sized to be seen from a kilometre or more so a
 * way out of a level can be steered for by eye; dimmed by the same visibility as the fog, so in thick
 * weather it is only found up close.
 */
const N = 64, LIFE = 26;
const VERT = /* glsl */`
attribute float aAge; attribute float aSeed;
uniform float uScale, uVis;
varying float vAge, vSeed, vFade;
void main(){
  vAge = aAge; vSeed = aSeed;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float size = mix(4.0, 40.0, sqrt(aAge));
  gl_PointSize = size * uScale / max(1.0, -mv.z);
  float dist = length(mv.xyz);
  vFade = exp(-3.9 * dist / max(uVis, 60.0) * 0.55);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
uniform float uLight;
varying float vAge, vSeed, vFade;
void main(){
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) discard;
  // lumpy edge so the puffs do not read as discs
  float a = atan(p.y, p.x);
  float edge = 0.78 + 0.12 * sin(a * 3.0 + vSeed * 17.0) + 0.08 * sin(a * 5.0 - vSeed * 9.0);
  float soft = smoothstep(edge, edge * 0.35, r);
  float hot = smoothstep(0.18, 0.0, vAge);
  vec3 smoke = mix(vec3(0.95, 0.42, 0.16), vec3(0.62, 0.58, 0.56), smoothstep(0.05, 0.45, vAge)) * (0.35 + 0.65 * uLight);
  vec3 col = smoke + vec3(1.0, 0.55, 0.2) * hot * 4.0;
  float alpha = soft * (1.0 - smoothstep(0.55, 1.0, vAge)) * mix(0.55, 0.3, vAge) * vFade;
  gl_FragColor = vec4(col, alpha);
}`;

export class FlareColumn {
  constructor(scene, x, z) {
    this.x = x; this.z = z;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.age = new Float32Array(N);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) { this.age[i] = i / N; seed[i] = Math.random(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    this.uniforms = { uScale: { value: 600 }, uVis: { value: 3000 }, uLight: { value: 1 } };
    this.points = new THREE.Points(g, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
    this.primed = false;
  }

  update(dt, y, wind, vis, light, viewportH) {
    const P = this.pos, V = this.vel, A = this.age;
    if (!this.primed) { // start with a full column, not an empty sky
      this.primed = true;
      for (let i = 0; i < N; i++) this.spawn(i, y, wind, A[i] * LIFE);
    }
    for (let i = 0; i < N; i++) {
      A[i] += dt / LIFE;
      if (A[i] >= 1) { A[i] -= 1; this.spawn(i, y, wind, 0); continue; }
      // rise slows as the smoke cools; the wind takes over
      const o = i * 3, lift = 3.2 * (1 - A[i]) + 0.6;
      V[o] += (wind.x * 0.55 - V[o]) * dt * 0.4; V[o + 2] += (wind.y * 0.55 - V[o + 2]) * dt * 0.4;
      P[o] += V[o] * dt; P[o + 1] += lift * dt; P[o + 2] += V[o + 2] * dt;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aAge.needsUpdate = true;
    this.uniforms.uVis.value = vis; this.uniforms.uLight.value = light;
    this.uniforms.uScale.value = viewportH * 0.9;
  }

  spawn(i, y, wind, t) {
    const o = i * 3, P = this.pos, V = this.vel;
    V[o] = (Math.random() - 0.5) * 0.8; V[o + 1] = 0; V[o + 2] = (Math.random() - 0.5) * 0.8;
    P[o] = this.x + (Math.random() - 0.5) * 0.6; P[o + 1] = y + 4.4; P[o + 2] = this.z + (Math.random() - 0.5) * 0.6;
    // pre-age (priming): integrate roughly where it would be by now
    if (t > 0) {
      const lift = 3.2 * t - 1.6 * t * t / LIFE + 0.6 * t;
      P[o] += wind.x * 0.55 * Math.max(0, t - 2); P[o + 1] += lift; P[o + 2] += wind.y * 0.55 * Math.max(0, t - 2);
      V[o] = wind.x * 0.55; V[o + 2] = wind.y * 0.55;
    }
  }

  dispose(scene) { scene.remove(this.points); this.points.geometry.dispose(); this.points.material.dispose(); }
}
