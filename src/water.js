import * as THREE from 'three';
import { smoothstep } from './util.js';

// Gerstner wave set. The first NDISP waves displace geometry (and are what
// boats feel); the rest only perturb shading normals.
const G = 9.81;
const BASE = [
  { L: 74, A: 0.30, a: 0.0 },
  { L: 41, A: 0.17, a: 0.55 },
  { L: 23, A: 0.10, a: -0.45 },
  { L: 13, A: 0.055, a: 0.95 },
  { L: 7.3, A: 0.03, a: -0.8 },
  { L: 4.4, A: 0.016, a: 0.3 },
  { L: 2.7, A: 0.008, a: -1.2 },
];
const NDISP = 3; // longest three waves displace geometry (shortest 23 m: >5 vertices per wavelength)
// Capillary/short gravity ripples for shading only: fixed world directions (golden-angle spread),
// geometric wavelengths 0.35–2.3 m, deep-water dispersion with surface tension.
const RIPPLES = Array.from({ length: 12 }, (_, i) => {
  const lambda = 0.35 * Math.pow(1.185, i);
  const k = (2 * Math.PI) / lambda;
  const angle = i * 2.39996 + 0.7;
  return { lambda, k, angle, dx: Math.cos(angle), dz: Math.sin(angle), omega: Math.sqrt(9.81 * k + 7.4e-5 * k * k * k), phase: (i * 1.618) % (2 * Math.PI), amp: 0.045 / k };
});
const Q = 1.0;
const SWELL = -Math.PI / 2; // swell travels north (-z), in from the open sea
const FADE0 = 330, FADE1 = 440;

export class Water {
  constructor(scene, floorMap) {
    this.floorMap = floorMap;
    this.time = 0; this.level = 0; this.sea = 1;
    this.center = new THREE.Vector2();
    this.waves = BASE.map((w) => {
      const k = (2 * Math.PI) / w.L;
      const ang = SWELL + w.a;
      return { k, omega: Math.sqrt(G * k), dx: Math.cos(ang), dz: Math.sin(ang), A0: w.A, A: w.A };
    });
    const rect = floorMap.rect;
    this.uniforms = {
      uTime: { value: 0 }, uLevel: { value: 0 }, uSea: { value: 1 },
      uCenter: { value: this.center },
      uWaves: { value: this.waves.map(() => new THREE.Vector4()) },
      uOmega: { value: this.waves.map((w) => w.omega) },
      uFloor: { value: floorMap.makeTexture() },
      uFloorRect: { value: new THREE.Vector4(rect.minx, rect.minz, rect.size, rect.size) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunInt: { value: 1 },
      uSkyColor: { value: new THREE.Color(0.3, 0.5, 0.8) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uLight: { value: 1 },
      uRain: { value: 0 }, uFlash: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uDeep: { value: new THREE.Color(0.018, 0.12, 0.17) },
      uShallow: { value: new THREE.Color(0.09, 0.3, 0.28) },
      uMurk: { value: new THREE.Color(0.17, 0.17, 0.1) },
      uRing: { value: 0 },
      uRefl: { value: null }, uReflMatrix: { value: new THREE.Matrix4() }, uReflOn: { value: 0 },
      uRip: { value: RIPPLES.map(() => new THREE.Vector4()) }, uRipW: { value: RIPPLES.map((r) => r.omega) }, uRipPh: { value: RIPPLES.map((r) => r.phase) },
      ...THREE.UniformsLib.fog,
    };
    const matNear = new THREE.ShaderMaterial({
      defines: { WATER_WAVES: 5, WATER_RIPPLES: 4, WATER_FOAM: 1 },
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, fog: true, depthWrite: true,
    });
    const matFar = matNear.clone();
    matFar.uniforms = { ...this.uniforms, uRing: { value: 1 } };

    const size = 900, seg = 200; // ~4.5 m grid; finer detail comes from the shading ripples
    const g = new THREE.PlaneGeometry(size, size, seg, seg); g.rotateX(-Math.PI / 2);
    this.snap = size / seg;
    this.near = new THREE.Mesh(g, matNear);
    const rg = new THREE.RingGeometry(442, 9000, 128, 6); rg.rotateX(-Math.PI / 2);
    this.far = new THREE.Mesh(rg, matFar);
    for (const m of [this.near, this.far]) { m.frustumCulled = false; m.renderOrder = 1; scene.add(m); }
    this.updateUniforms();
    this.gridSegments = seg;
  }

  // Compile out unused per-pixel work; buoyancy always uses the same three waves.
  setQuality(q) {
    const segments = q === 'low' ? 96 : q === 'medium' ? 128 : 180;
    if (segments !== this.gridSegments) {
      const old = this.near.geometry;
      this.near.geometry = new THREE.PlaneGeometry(900, 900, segments, segments);
      this.near.geometry.rotateX(-Math.PI / 2);
      this.gridSegments = segments;
      this.snap = 900 / segments;
      old.dispose();
    }
    const waves = q === 'low' ? 3 : q === 'medium' ? 5 : 7;
    const ripples = q === 'low' ? 2 : q === 'medium' ? 4 : 8;
    // Keep the full range of wavelengths at every tier, rather than retaining only
    // the shortest waves (which looked like a regular fabric pattern).
    this.rippleSet = Array.from({ length: ripples }, (_, i) => RIPPLES[Math.round(i * (RIPPLES.length - 1) / (ripples - 1))]);
    for (const mesh of [this.near, this.far]) {
      const mat = mesh.material;
      mat.defines = { WATER_WAVES: waves, WATER_RIPPLES: ripples, WATER_FOAM: q === 'low' ? 0 : 1 };
      mat.needsUpdate = true;
    }
  }

  setSeaState(sea, windAngle = 0, windSpeed = 5, rain = 0) {
    this.sea = sea;
    for (const w of this.waves) w.A = w.A0 * sea;
    // Ripple directions are fixed in world space; only their amplitudes follow the wind.
    // (Rotating directions would sweep phase across the whole sea and make it appear to slide.)
    const wf = 0.25 + Math.min(1.5, windSpeed / 9);
    (this.rippleSet || RIPPLES).forEach((r, i) => {
      const align = Math.max(0, Math.cos(r.angle - windAngle));
      const amp = r.amp * wf * (0.3 + 0.7 * align * align) * (1 + rain * (r.lambda < 0.8 ? 1.5 : 0.3));
      this.uniforms.uRip.value[i].set(r.dx, r.dz, r.k, amp);
      this.uniforms.uRipW.value[i] = r.omega;
      this.uniforms.uRipPh.value[i] = r.phase;
    });
  }

  update(dt, level, focus) {
    this.time += dt;
    this.level = level;
    const sx = Math.round(focus.x / this.snap) * this.snap, sz = Math.round(focus.z / this.snap) * this.snap;
    this.near.position.set(sx, 0, sz);
    this.far.position.set(sx, 0, sz);
    this.center.set(sx, sz);
    this.updateUniforms();
  }

  updateUniforms() {
    const u = this.uniforms;
    u.uTime.value = this.time; u.uLevel.value = this.level; u.uSea.value = this.sea;
    this.waves.forEach((w, i) => u.uWaves.value[i].set(w.dx, w.dz, w.k, w.A));
  }

  attenuation(x, z) {
    const depth = this.level - this.floorMap.floorAt(x, z);
    const d = Math.hypot(x - this.center.x, z - this.center.y);
    return (1 - smoothstep(FADE0, FADE1, d)) * (0.25 + 0.75 * smoothstep(0.5, 10, depth));
  }

  /** Displacement of the surface point whose rest position is (x, z). */
  displace(x, z, out) {
    const a = this.attenuation(x, z);
    let dx = 0, dy = 0, dz = 0;
    for (let i = 0; i < NDISP; i++) {
      const w = this.waves[i];
      const f = w.k * (w.dx * x + w.dz * z) - w.omega * this.time;
      const A = w.A * a, c = Math.cos(f);
      dx += Q * A * w.dx * c; dz += Q * A * w.dz * c; dy += A * Math.sin(f);
    }
    out.x = dx; out.y = dy; out.z = dz;
    return out;
  }

  /** Surface height at world (x, z); inverts the horizontal Gerstner shift. */
  heightAt(x, z) {
    const d = this._d || (this._d = { x: 0, y: 0, z: 0 });
    let px = x, pz = z;
    for (let it = 0; it < 3; it++) { this.displace(px, pz, d); px = x - d.x; pz = z - d.z; }
    this.displace(px, pz, d);
    return this.level + d.y;
  }

  depthAt(x, z) { return this.level - this.floorMap.floorAt(x, z); }

  /**
   * Planar reflection: render the scene from the camera mirrored in the plane
   * y = level, clipped to what lies above the water, into a half-res target.
   * The water shader projects each fragment through the same mirrored camera.
   */
  enableReflections(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // ~40% of screen resolution is plenty once the waves distort it; no MSAA needed.
    this.reflRT = new THREE.WebGLRenderTarget(Math.max(1, Math.round(size.x * 0.4)), Math.max(1, Math.round(size.y * 0.4)), { type: THREE.HalfFloatType });
    this.reflCam = new THREE.PerspectiveCamera();
    this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.uniforms.uRefl.value = this.reflRT.texture;
    this.uniforms.uReflOn.value = 1;
    this.hideInReflection = [];
  }
  resizeReflections(renderer) {
    if (!this.reflRT || !this.reflectionsOn) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.reflRT.setSize(Math.max(1, Math.round(size.x * 0.4)), Math.max(1, Math.round(size.y * 0.4)));
  }
  renderReflection(renderer, scene, camera) {
    if (!this.reflRT) return;
    const L = this.level;
    const rc = this.reflCam;
    rc.fov = camera.fov; rc.aspect = camera.aspect; rc.near = camera.near; rc.far = camera.far; rc.updateProjectionMatrix();
    const dir = camera.getWorldDirection(new THREE.Vector3());
    rc.position.set(camera.position.x, 2 * L - camera.position.y, camera.position.z);
    rc.up.set(0, 1, 0);
    rc.lookAt(rc.position.x + dir.x, rc.position.y - dir.y, rc.position.z + dir.z);
    rc.updateMatrixWorld();
    this.uniforms.uReflMatrix.value.multiplyMatrices(rc.projectionMatrix, rc.matrixWorldInverse);
    this.clipPlane.constant = -(L - 0.4);
    const hidden = [this.near, this.far, ...this.hideInReflection];
    const vis = hidden.map((o) => o.visible);
    hidden.forEach((o) => (o.visible = false));
    const prevTarget = renderer.getRenderTarget(), prevClip = renderer.clippingPlanes, prevAuto = renderer.shadowMap.autoUpdate;
    renderer.shadowMap.autoUpdate = false;
    renderer.clippingPlanes = [this.clipPlane];
    renderer.setRenderTarget(this.reflRT);
    renderer.clear();
    renderer.render(scene, rc);
    renderer.setRenderTarget(prevTarget);
    renderer.clippingPlanes = prevClip;
    renderer.shadowMap.autoUpdate = prevAuto;
    hidden.forEach((o, i) => (o.visible = vis[i]));
  }
}

const VERT = /* glsl */`
uniform float uTime, uLevel;
uniform vec2 uCenter;
uniform vec4 uWaves[7];
uniform float uOmega[7];
uniform sampler2D uFloor;
uniform vec4 uFloorRect;
varying vec3 vWorld; varying vec2 vP0; varying float vAtten; varying float vDepth;
#include <fog_pars_vertex>
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p0 = wp.xz;
  float fl = texture2D(uFloor, (p0 - uFloorRect.xy) / uFloorRect.zw).r;
  float depth = uLevel - fl;
  float d = length(p0 - uCenter);
  float a = (1.0 - smoothstep(${FADE0.toFixed(1)}, ${FADE1.toFixed(1)}, d)) * (0.25 + 0.75 * smoothstep(0.5, 10.0, depth));
  vec3 disp = vec3(0.0);
  for (int i = 0; i < ${NDISP}; i++) {
    vec4 w = uWaves[i];
    float f = w.z * dot(w.xy, p0) - uOmega[i] * uTime;
    float A = w.w * a; float c = cos(f);
    disp.x += ${Q.toFixed(2)} * A * w.x * c; disp.z += ${Q.toFixed(2)} * A * w.y * c; disp.y += A * sin(f);
  }
  wp.x += disp.x; wp.z += disp.z; wp.y = uLevel + disp.y;
  vWorld = wp.xyz; vP0 = p0; vAtten = a; vDepth = depth;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
uniform float uTime, uLevel, uSea, uSunInt, uLight, uRain, uFlash, uRing;
uniform vec2 uCenter, uWind;
uniform vec4 uWaves[7];
uniform float uOmega[7];
uniform vec3 uSunDir, uSunColor, uSkyColor, uHorizon, uDeep, uShallow, uMurk;
uniform sampler2D uRefl; uniform mat4 uReflMatrix; uniform float uReflOn;
uniform sampler2D uFloor; uniform vec4 uFloorRect;
uniform vec4 uRip[12]; uniform float uRipW[12]; uniform float uRipPh[12];
varying vec3 vWorld; varying vec2 vP0; varying float vAtten; varying float vDepth;
#include <common>
#include <fog_pars_fragment>
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
void main(){
  if (uRing < 0.5 && length(vP0 - uCenter) > 443.0) discard;
  vec3 n = vec3(0.0, 1.0, 0.0);
  for (int i = 0; i < WATER_WAVES; i++) {
    vec4 w = uWaves[i];
    float f = w.z * dot(w.xy, vP0) - uOmega[i] * uTime;
    float WA = w.z * w.w * vAtten;
    float c = cos(f);
    n.x -= w.x * WA * c; n.z -= w.y * WA * c; n.y -= ${Q.toFixed(2)} * WA * sin(f);
  }
  // Short ripples: travelling waves with their own speeds and fixed directions, evaluated at the
  // rest position so they ride the swell's orbital motion. Each fades out before it can alias.
  float camDist = length(cameraPosition - vWorld);
  vec2 rg = vec2(0.0);
  for (int i = 0; i < WATER_RIPPLES; i++) {
    vec4 r = uRip[i];
    float fade = clamp(1.0 - camDist * r.z / 950.0, 0.0, 1.0);
    if (fade <= 0.0) continue;
    float ph = r.z * dot(r.xy, vP0) - uRipW[i] * uTime + uRipPh[i];
    // Pixel-footprint filtering prevents moire and crawling on the distant water.
    float filterWidth = fwidth(ph);
    fade *= 1.0 - smoothstep(0.5, 2.5, filterWidth);
    rg += r.xy * (r.z * r.w * cos(ph) * fade * 0.65);
  }
  rg *= (0.6 + 0.4 * vAtten);
  float rr = 0.0;
  if (uRain > 0.01) {
    vec2 q = vWorld.xz * 3.5; vec2 id = floor(q); vec2 fq = fract(q) - 0.5;
    float t = fract(uTime * 1.3 + h21(id) * 7.0);
    float ring = abs(length(fq) - t * 0.4);
    rr = (1.0 - smoothstep(0.0, 0.04, ring)) * (1.0 - t) * step(0.4, h21(id + 0.37)) * uRain * 0.6;
  }
  n = normalize(n - vec3(rg.x, 0.0, rg.y) + vec3(rr * 0.6, 0.0, rr * 0.4));
  // soften the remaining detail with distance (stands in for normal-map mipmapping)
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(200.0, 1600.0, camDist) * 0.6));

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uHorizon, uSkyColor, clamp(R.y * 1.6, 0.0, 1.0));
  if (uReflOn > 0.5) {
    vec4 rc = uReflMatrix * vec4(vWorld.x, uLevel, vWorld.z, 1.0);
    vec2 ruv = rc.xy / rc.w * 0.5 + 0.5;
    ruv += n.xz * (0.035 / (1.0 + camDist * 0.004));
    vec3 refl = texture2D(uRefl, clamp(ruv, 0.001, 0.999)).rgb;
    if (any(isnan(refl)) || any(isinf(refl)) || !(abs(refl.r) < 1e5) || !(abs(refl.g) < 1e5) || !(abs(refl.b) < 1e5)) refl = uHorizon;
    refl = min(refl, vec3(40.0));
    sky = refl;
  }

  // Sample floor depth per pixel: interpolating it across the coarse wave mesh
  // made stepped foam triangles around otherwise straight harbor walls.
  float surfaceDepth = uLevel - texture2D(uFloor, (vWorld.xz - uFloorRect.xy) / uFloorRect.zw).r;
  float depthF = smoothstep(0.0, 14.0, surfaceDepth);
  vec3 wc = mix(uShallow, uDeep, depthF);
  float murk = (1.0 - smoothstep(-150.0, 150.0, vWorld.z)) * 0.4;
  wc = mix(wc, uMurk, murk * (0.5 + 0.5 * depthF));
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0);
  vec3 body = wc * (0.35 + 0.65 * max(dot(n, uSunDir), 0.0) * sunUp) * uLight;
  float crest = clamp((vWorld.y - uLevel) / max(uSea * 0.6, 0.15), 0.0, 1.5) * vAtten;
  body += uShallow * 0.35 * crest * sunUp * uLight;
  vec3 col = mix(body, sky, fres);

  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(n, H), 0.0);
  col += uSunColor * (pow(nh, 350.0) * 5.0 + pow(nh, 40.0) * 0.12) * uSunInt;

  float fn = 0.5;
  #if WATER_FOAM == 1
    vec2 wob = vec2(sin(uTime * 0.11), cos(uTime * 0.083)) * 0.6;
    fn = vnoise(vP0 * 0.7 + wob) * vnoise(vP0 * 1.9 - wob * 1.3 + 5.0);
  #endif
  float foamCrest = smoothstep(0.65, 1.2, crest) * smoothstep(0.9, 1.8, uSea);
  float shore = (1.0 - smoothstep(0.0, 0.8, surfaceDepth)) * step(-0.2, surfaceDepth);
  float foam = clamp((foamCrest + shore * 0.55) * (0.2 + fn * 1.4), 0.0, 1.0);
  col = mix(col, vec3(0.85, 0.88, 0.88) * uLight, foam * 0.8);
  col += vec3(0.6, 0.65, 0.8) * uFlash;

  float alpha = mix(0.8, 0.97, smoothstep(0.0, 9.0, surfaceDepth));
  alpha = clamp(max(alpha, fres) + foam, 0.0, 1.0);
  // Guard the HDR pipeline: a single Inf/NaN pixel turns into black blocks once bloom spreads it.
  if (any(isnan(col)) || any(isinf(col)) || !(abs(col.r) < 1e5) || !(abs(col.g) < 1e5) || !(abs(col.b) < 1e5)) col = vec3(0.0);
  col = min(col, vec3(40.0));
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
