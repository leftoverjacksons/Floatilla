import * as THREE from 'three';
import { smoothstep } from './util.js';
import { WAKE_N, WAKE_CELL } from './wake.js';
import { OceanSpectrum, OceanCPU, OceanGPU, CASCADES, OCEAN_N, TIME_WRAP } from './ocean.js';

// Camera-centred surface: dense near the camera (~0.35 m), coarse far out (~25 m).
const GRID_H = 128, GRID_R = 1100, GRID_A = 0.04, GRID_P = 3;
const SNAP = 2;            // grid follows the camera in 2 m steps
const FADE0 = 650, FADE1 = 1000; // displacement fades out before the far ring
const RING_R = 1066;

export class Water {
  constructor(scene, floorMap) {
    this.floorMap = floorMap;
    this.time = 0; this.level = 0; this.sea = 1;
    this.center = new THREE.Vector2();
    this.spectrum = new OceanSpectrum(OCEAN_N);
    this.spectrum.build(5, -Math.PI / 2 + 0.6);
    this.cpu = new OceanCPU(this.spectrum);
    this.lambda = this.spectrum.lambda;
    this.lastBuild = { V: 5, a: -Math.PI / 2 + 0.6, t: -99 };
    const rect = floorMap.rect;
    this.uniforms = {
      uTime: { value: 0 }, uLevel: { value: 0 }, uSea: { value: 1 }, uHs: { value: 0.5 },
      uCenter: { value: this.center },
      uFloor: { value: floorMap.makeTexture() },
      uFloorRect: { value: new THREE.Vector4(rect.minx, rect.minz, rect.size, rect.size) },
      uDisp0: { value: null }, uDisp1: { value: null }, uDisp2: { value: null },
      uDer0: { value: null }, uDer1: { value: null }, uDer2: { value: null },
      uL: { value: new THREE.Vector3(CASCADES[0].L, CASCADES[1].L, CASCADES[2].L) },
      uHalfTexel: { value: 0.5 / OCEAN_N },
      uOceanOn: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uSunInt: { value: 1 },
      uSkyColor: { value: new THREE.Color(0.3, 0.5, 0.8) },
      uHorizon: { value: new THREE.Color(0.7, 0.8, 0.9) },
      uLight: { value: 1 },
      uRain: { value: 0 }, uFlash: { value: 0 },
      uWind: { value: new THREE.Vector2(1, 0) },
      uDeep: { value: new THREE.Color(0.012, 0.06, 0.085) },
      uShallow: { value: new THREE.Color(0.07, 0.22, 0.22) },
      uMurk: { value: new THREE.Color(0.15, 0.15, 0.09) },
      uSSS: { value: new THREE.Color(0.1, 0.42, 0.38) },
      uRing: { value: 0 },
      uRefl: { value: null }, uReflMatrix: { value: new THREE.Matrix4() }, uReflOn: { value: 0 },
      uWake: { value: null }, uWakeOrigin: { value: new THREE.Vector2() }, uWakeOn: { value: 0 },
      // lamps on the player's boat (just above the waterline) and the searchlight, which three.js
      // lights would not reach because the water has its own lighting
      uLampPos: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uLampCol: { value: new THREE.Color(0, 0, 0) }, uLampR: { value: 12 },
      uSpotPos: { value: new THREE.Vector3() }, uSpotDir: { value: new THREE.Vector3(0, -1, 0) },
      uSpotCol: { value: new THREE.Color(0, 0, 0) }, uSpotCos: { value: 0.95 }, uSpotR: { value: 260 },
      ...THREE.UniformsLib.fog,
    };
    const matNear = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, fog: true, depthWrite: true });
    const matFar = matNear.clone();
    matFar.uniforms = { ...this.uniforms, uRing: { value: 1 } };
    this.near = new THREE.Mesh(buildGrid(), matNear);
    const rg = new THREE.RingGeometry(RING_R, 12000, 128, 8); rg.rotateX(-Math.PI / 2);
    rg.setAttribute('aSpacing', new THREE.Float32BufferAttribute(new Float32Array(rg.attributes.position.count).fill(60), 1));
    this.far = new THREE.Mesh(rg, matFar);
    for (const m of [this.near, this.far]) { m.frustumCulled = false; m.renderOrder = 1; scene.add(m); }
    this._d = { x: 0, y: 0, z: 0 };
    this.updateUniforms();
  }

  /** Create the GPU FFT pipeline. Without float render targets the sea falls back to calm, flat shading. */
  initGPU(renderer) {
    this.gpu = new OceanGPU(renderer, this.spectrum);
    if (!this.gpu.ok) { console.warn('FFT ocean unavailable (no float render targets); flat sea fallback'); return; }
    const u = this.uniforms, cs = this.gpu.cascades;
    u.uDisp0.value = cs[0].disp.texture; u.uDisp1.value = cs[1].disp.texture; u.uDisp2.value = cs[2].disp.texture;
    u.uDer0.value = cs[0].deriv.texture; u.uDer1.value = cs[1].deriv.texture; u.uDer2.value = cs[2].deriv.texture;
    u.uOceanOn.value = 1;
    this.gpu.uploadSpectrum();
    this.gpu.initProbe(u.uFloor.value, u.uFloorRect.value, FADE0, FADE1);
  }

  /**
   * Sea state follows the slowly-varying weather wind (not gusts). The spectrum is rebuilt only
   * when the wind has drifted a few percent; amplitudes change, random phases never do, so the
   * sea never "slides".
   */
  setSeaState(sea, windAngle = 0, windSpeed = 5, rain = 0) {
    this.sea = sea; this.rain = rain;
    const lb = this.lastBuild;
    const changed = Math.abs(windSpeed - lb.V) / Math.max(lb.V, 1) > 0.04 || Math.abs(windAngle - lb.a) > 0.06;
    if (changed && this.time - lb.t > 1.5) {
      this.spectrum.build(windSpeed, windAngle);
      this.cpu.select();
      this.lambda = this.spectrum.lambda;
      if (this.gpu) this.gpu.uploadSpectrum();
      this.lastBuild = { V: windSpeed, a: windAngle, t: this.time };
    }
  }

  update(dt, level, focus) {
    this.time += dt;
    this.level = level;
    const sx = Math.round(focus.x / SNAP) * SNAP, sz = Math.round(focus.z / SNAP) * SNAP;
    this.near.position.set(sx, 0, sz);
    this.far.position.set(sx, 0, sz);
    this.center.set(sx, sz);
    this.cpu.setTime(this.time % TIME_WRAP);
    this.updateUniforms();
  }

  /** Run the GPU wave simulation for this frame (call once per frame before rendering). */
  simulate() {
    if (!this.gpu || !this.gpu.ok) return;
    this.gpu.simulate(this.time % TIME_WRAP, this.lambda);
    this.gpu.probe(this.center, this.level, this.time);
  }

  updateUniforms() {
    const u = this.uniforms;
    u.uTime.value = this.time % TIME_WRAP; u.uLevel.value = this.level; u.uSea.value = this.sea;
    u.uHs.value = this.spectrum.hs;
  }

  attenuation(x, z) {
    const depth = this.level - this.floorMap.floorAt(x, z);
    const d = Math.hypot(x - this.center.x, z - this.center.y);
    return (1 - smoothstep(FADE0, FADE1, d)) * (0.25 + 0.75 * smoothstep(0.5, 10, depth));
  }

  /** Displacement of the surface point whose rest position is (x, z) (swell + chop ≥ 5 m). */
  displace(x, z, out) {
    const a = this.attenuation(x, z);
    this.cpu.displace(x, z, this.lambda, out);
    out.x *= a; out.y *= a; out.z *= a;
    return out;
  }

  /** Surface height at world (x, z); inverts the horizontal (choppy) displacement. */
  heightAt(x, z) {
    // Near the camera: the exact rendered surface, read back from the GPU (≈1–2 frames old).
    const ph = this.gpu && this.gpu.ok ? this.gpu.probeHeight(x, z, this.time) : null;
    if (ph !== null) return this.level + ph;
    // Farther out: the strongest components of the same spectrum, evaluated on the CPU.
    const d = this._d;
    let px = x, pz = z;
    for (let it = 0; it < 3; it++) { this.displace(px, pz, d); px = x - d.x; pz = z - d.z; }
    this.displace(px, pz, d);
    return this.level + d.y;
  }

  /** Cheaper height for cosmetic things (foam, flotsam): no choppy inversion. */
  heightFast(x, z) {
    const ph = this.gpu && this.gpu.ok ? this.gpu.probeHeight(x, z, this.time) : null;
    return ph !== null ? this.level + ph : this.level + this.cpu.heightOnly(x, z) * this.attenuation(x, z);
  }

  depthAt(x, z) { return this.level - this.floorMap.floorAt(x, z); }

  // ---- planar reflection (unchanged approach) ------------------------------------------
  enableReflections(renderer) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
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

/** Square grid with spacing growing smoothly from the centre; aSpacing drives texture LOD. */
function buildGrid() {
  const H = GRID_H, n = 2 * H + 1;
  const f = (u) => Math.sign(u) * GRID_R * (GRID_A * Math.abs(u) + (1 - GRID_A) * Math.pow(Math.abs(u), GRID_P));
  const df = (u) => GRID_R * (GRID_A + (1 - GRID_A) * GRID_P * Math.pow(Math.abs(u), GRID_P - 1)) / H;
  const pos = new Float32Array(n * n * 3), sp = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const u = (i - H) / H, v = (j - H) / H, k = j * n + i;
    pos[k * 3] = f(u); pos[k * 3 + 1] = 0; pos[k * 3 + 2] = f(v);
    sp[k] = Math.max(df(u), df(v));
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let p = 0;
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx[p++] = a; idx[p++] = c; idx[p++] = b; idx[p++] = b; idx[p++] = c; idx[p++] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aSpacing', new THREE.BufferAttribute(sp, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

const COMMON = /* glsl */`
uniform float uTime, uLevel, uOceanOn, uHalfTexel;
uniform vec2 uCenter;
uniform vec3 uL;
uniform sampler2D uFloor, uDisp0, uDisp1, uDisp2, uDer0, uDer1, uDer2;
uniform vec4 uFloorRect;
uniform sampler2D uWake; uniform vec2 uWakeOrigin; uniform float uWakeOn;
// wake field (height, prev, foam, hull pressure), bilinear by hand (float textures may not filter)
vec4 wakeAt(vec2 w){
  vec2 g = (w - uWakeOrigin) / ${WAKE_CELL.toFixed(3)} - 0.5;
  vec2 f = fract(g); ivec2 i = ivec2(floor(g));
  ivec2 lo = ivec2(0), hi = ivec2(${WAKE_N - 1});
  vec4 a = texelFetch(uWake, clamp(i, lo, hi), 0), b = texelFetch(uWake, clamp(i + ivec2(1, 0), lo, hi), 0);
  vec4 c = texelFetch(uWake, clamp(i + ivec2(0, 1), lo, hi), 0), d = texelFetch(uWake, clamp(i + ivec2(1, 1), lo, hi), 0);
  vec2 e = min(g + 0.5, ${WAKE_N}.0 - g - 0.5);
  float fade = smoothstep(2.0, 24.0, min(e.x, e.y));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * fade;
}
float oceanAtten(vec2 p0, float depth){
  return (1.0 - smoothstep(${FADE0.toFixed(1)}, ${FADE1.toFixed(1)}, length(p0 - uCenter))) * (0.25 + 0.75 * smoothstep(0.5, 10.0, depth));
}
`;

const VERT = /* glsl */`
${COMMON}
attribute float aSpacing;
varying vec3 vWorld; varying vec2 vP0; varying float vAtten; varying float vDepth; varying float vHeight;
#include <fog_pars_vertex>
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p0 = wp.xz;
  float fl = texture2D(uFloor, (p0 - uFloorRect.xy) / uFloorRect.zw).r;
  float depth = uLevel - fl;
  float a = oceanAtten(p0, depth);
  vec3 disp = vec3(0.0);
  if (uOceanOn > 0.5) {
    // pick a mip so each cascade is never sampled finer than the local vertex spacing
    float lod0 = max(0.0, log2(aSpacing / (uL.x / ${OCEAN_N}.0)));
    float lod1 = max(0.0, log2(aSpacing / (uL.y / ${OCEAN_N}.0)));
    disp += textureLod(uDisp0, p0 / uL.x + uHalfTexel, lod0).xyz;
    disp += textureLod(uDisp1, p0 / uL.y + uHalfTexel, lod1).xyz;
    disp *= a;
  }
  float wk = uWakeOn > 0.5 ? wakeAt(p0).r : 0.0;
  wp.x += disp.x; wp.z += disp.z; wp.y = uLevel + disp.y + wk;
  vWorld = wp.xyz; vP0 = p0; vAtten = a; vDepth = depth; vHeight = disp.y;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */`
${COMMON}
uniform float uSea, uHs, uSunInt, uLight, uRain, uFlash, uRing;
uniform vec2 uWind;
uniform vec3 uSunDir, uSunColor, uSkyColor, uHorizon, uDeep, uShallow, uMurk, uSSS;
uniform sampler2D uRefl; uniform mat4 uReflMatrix; uniform float uReflOn;
uniform vec3 uLampPos[4]; uniform vec3 uLampCol; uniform float uLampR;
uniform vec3 uSpotPos, uSpotDir, uSpotCol; uniform float uSpotCos, uSpotR;
// a small light over the water: the body colour lit from above, foam catching it, and a glint
vec3 lampOn(vec3 wp, vec3 lp, vec3 lc, float range, vec3 n, vec3 V, vec3 wc, float foam){
  vec3 L = lp - wp; float d = length(L); vec3 l = L / max(d, 1e-3);
  float att = smoothstep(range, range * 0.15, d) / (1.0 + d * d * 0.08);
  float diff = max(dot(n, l), 0.0);
  float spec = pow(max(dot(n, normalize(l + V)), 0.0), 80.0);
  return lc * att * ((wc * 2.5 + 0.04) * diff + foam * 0.7 * diff + spec * 2.0);
}
varying vec3 vWorld; varying vec2 vP0; varying float vAtten; varying float vDepth; varying float vHeight;
#include <common>
#include <fog_pars_fragment>
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
void main(){
  if (uRing < 0.5 && length(vP0 - uCenter) > ${(RING_R + 4).toFixed(1)}) discard;
  float camDist = length(cameraPosition - vWorld);

  // Slopes and Jacobian from all three cascades (mipmapping filters distant detail).
  float sx = 0.0, sz = 0.0, jxx = 0.0, jzz = 0.0, jxz = 0.0;
  // boat wakes: the turbulent trail damps the finest ripples (wakes read as smooth "slicks")
  vec4 wk0 = uWakeOn > 0.5 ? wakeAt(vP0) : vec4(0.0);
  float slick = smoothstep(0.01, 0.25, wk0.b) * 0.75;
  if (uOceanOn > 0.5) {
    vec4 d0 = texture2D(uDer0, vP0 / uL.x + uHalfTexel), d1 = texture2D(uDer1, vP0 / uL.y + uHalfTexel), d2 = texture2D(uDer2, vP0 / uL.z + uHalfTexel);
    float x0 = texture2D(uDisp0, vP0 / uL.x + uHalfTexel).w, x1 = texture2D(uDisp1, vP0 / uL.y + uHalfTexel).w, x2 = texture2D(uDisp2, vP0 / uL.z + uHalfTexel).w;
    float a = vAtten, ar = mix(0.55, 1.0, vAtten) * (1.0 - slick); // ripples persist a little over shallows
    sx = (d0.x + d1.x) * a + d2.x * ar; sz = (d0.y + d1.y) * a + d2.y * ar;
    jxx = (d0.z + d1.z) * a + d2.z * ar; jzz = (d0.w + d1.w) * a + d2.w * ar; jxz = (x0 + x1) * a + x2 * ar;
  }
  // rain rings
  float rr = 0.0;
  if (uRain > 0.01) {
    vec2 q = vWorld.xz * 3.5; vec2 id = floor(q); vec2 fq = fract(q) - 0.5;
    float t = fract(uTime * 1.3 + h21(id) * 7.0);
    float ring = abs(length(fq) - t * 0.4);
    rr = (1.0 - smoothstep(0.0, 0.04, ring)) * (1.0 - t) * step(0.4, h21(id + 0.37)) * uRain * 0.6;
  }
  vec3 n = normalize(vec3(-sx / max(1.0 + jxx, 0.2), 1.0, -sz / max(1.0 + jzz, 0.2)) + vec3(rr * 0.6, 0.0, rr * 0.4));
  n = normalize(mix(n, vec3(0.0, 1.0, 0.0), smoothstep(400.0, 3000.0, camDist) * 0.5));
  float J = (1.0 + jxx) * (1.0 + jzz) - jxz * jxz;
  // boat wakes: slopes from the wake field, foam it carries
  float wakeFoam = 0.0;
  if (uWakeOn > 0.5) {
    const float E = ${(WAKE_CELL * 0.75).toFixed(3)};
    vec4 w0 = wk0;
    float wx = (wakeAt(vP0 + vec2(E, 0.0)).r - wakeAt(vP0 - vec2(E, 0.0)).r) / (2.0 * E);
    float wz = (wakeAt(vP0 + vec2(0.0, E)).r - wakeAt(vP0 - vec2(0.0, E)).r) / (2.0 * E);
    n = normalize(n + vec3(-wx, 0.0, -wz));
    wakeFoam = w0.b;
  }

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(n, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  vec3 R = reflect(-V, n);
  vec3 sky = mix(uHorizon, uSkyColor, clamp(R.y * 1.6, 0.0, 1.0));
  if (uReflOn > 0.5) {
    vec4 rc = uReflMatrix * vec4(vWorld.x, uLevel, vWorld.z, 1.0);
    vec2 ruv = rc.xy / rc.w * 0.5 + 0.5;
    ruv += n.xz * (0.05 / (1.0 + camDist * 0.004));
    vec3 refl = texture2D(uRefl, clamp(ruv, 0.001, 0.999)).rgb;
    if (any(isnan(refl)) || any(isinf(refl)) || !(abs(refl.r) < 1e5) || !(abs(refl.g) < 1e5) || !(abs(refl.b) < 1e5)) refl = uHorizon;
    // rough, wavy water shouldn't be a perfect mirror: blend toward the sky gradient as slopes grow
    sky = mix(min(refl, vec3(40.0)), sky, clamp(length(vec2(sx, sz)) * 1.5, 0.0, 0.6));
  }

  // body colour: depth, murk of floodwater, light through thin crests
  float depthF = smoothstep(0.0, 14.0, vDepth);
  vec3 wc = mix(uShallow, uDeep, depthF);
  float murk = smoothstep(150.0, -150.0, vWorld.z) * 0.6;
  wc = mix(wc, uMurk, murk * (0.5 + 0.5 * depthF));
  float sunUp = clamp(uSunDir.y * 4.0, 0.0, 1.0);
  vec3 body = wc * (0.3 + 0.7 * max(dot(n, uSunDir), 0.0) * sunUp) * uLight;
  float crest = clamp(vHeight / max(uHs * 0.5, 0.1), 0.0, 1.5);
  vec3 sunFlat = normalize(vec3(uSunDir.x, 0.0, uSunDir.z) + 1e-4);
  float back = pow(max(dot(-V, sunFlat), 0.0), 3.0) * (0.25 + 0.75 * (1.0 - ndv));
  body += uSSS * (crest * 0.35 + back * crest * 1.2) * (0.25 + 0.75 * sunUp) * uLight;
  vec3 col = mix(body, sky, fres);

  // sun glitter: sharper on calm water, broader in a blow
  vec3 H = normalize(uSunDir + V);
  float nh = max(dot(n, H), 0.0);
  float shin = mix(600.0, 180.0, clamp(uSea / 3.0, 0.0, 1.0));
  col += uSunColor * (pow(nh, shin) * 6.0 + pow(nh, 50.0) * 0.1) * uSunInt;

  // foam: breaking crests (Jacobian folds), broken up by noise anchored to the water; shorelines
  vec2 wob = vec2(sin(uTime * 0.11), cos(uTime * 0.083)) * 0.6;
  float fn = vnoise(vP0 * 0.9 + wob) * 0.6 + vnoise(vP0 * 3.1 - wob * 1.3 + 5.0) * 0.4;
  float breaking = smoothstep(0.42, -0.1, J) * vAtten; // only the steepest folds whiten
  float shore = (1.0 - smoothstep(0.0, 1.2, vDepth)) * step(-0.6, vDepth);
  // wake foam: dense and creamy where fresh, breaking into lace and streaks as it thins out
  float wf = clamp(wakeFoam, 0.0, 1.2);
  float lace = vnoise(vP0 * 1.7 + 3.0) * 0.55 + vnoise(vP0 * 5.3 - 2.0) * 0.45;
  float bub = vnoise(vP0 * 11.0 + 1.7);
  float th = clamp(1.0 - wf * 1.3, 0.0, 1.0) * 0.9;           // thinner foam → fewer, smaller patches
  float wakeF = smoothstep(th, th + 0.18, lace * 0.85 + bub * 0.15) * min(1.0, wf * 2.5) * 0.9;
  float foam = clamp(breaking * smoothstep(0.25, 0.75, fn) * 1.6 + shore * smoothstep(0.35, 0.8, fn) * 0.9 + wakeF, 0.0, 1.0);
  foam *= 1.0 - smoothstep(600.0, 1400.0, camDist) * 0.7;
  col = mix(col, vec3(0.86, 0.9, 0.9) * (0.35 + 0.65 * uLight), foam * 0.85);
  col += vec3(0.6, 0.65, 0.8) * uFlash;
  if (uLampCol.r + uLampCol.g > 0.001) for (int i = 0; i < 4; i++) col += lampOn(vWorld, uLampPos[i], uLampCol, uLampR, n, V, wc, foam);
  if (uSpotCol.r > 0.001) {
    vec3 toP = vWorld - uSpotPos; float d = length(toP);
    float cone = smoothstep(uSpotCos, mix(uSpotCos, 1.0, 0.35), dot(toP / max(d, 1e-3), uSpotDir));
    float att = cone * smoothstep(uSpotR, uSpotR * 0.3, d) / (1.0 + d * d * 0.0012);
    vec3 l = -toP / max(d, 1e-3);
    float spec = pow(max(dot(n, normalize(l + V)), 0.0), 120.0);
    col += uSpotCol * att * ((wc * 2.5 + 0.05) * max(dot(n, l), 0.0) + foam * 0.9 + spec * 3.0);
  }

  float alpha = mix(0.72, 0.97, smoothstep(0.0, 9.0, vDepth));
  alpha = clamp(max(alpha, fres) + foam, 0.0, 1.0);
  if (any(isnan(col)) || any(isinf(col)) || !(abs(col.r) < 1e5) || !(abs(col.g) < 1e5) || !(abs(col.b) < 1e5)) col = vec3(0.0);
  col = min(col, vec3(40.0));
  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;
