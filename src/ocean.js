import * as THREE from 'three';
import { mulberry32 } from './util.js';

// ---------------------------------------------------------------------------
// FFT ocean (Tessendorf). A wind-driven wave spectrum is evolved in time and
// inverse-FFT'd on the GPU every frame into displacement and derivative
// textures for three cascades (tile sizes chosen so their repeats never line
// up). The CPU evaluates the strongest long-wave components of the very same
// spectrum, with identical phases, so boats ride the waves that are drawn.
// ---------------------------------------------------------------------------

const G = 9.81, TWO_PI = Math.PI * 2;
export const OCEAN_N = 256;
// Each cascade owns a band of wavenumbers so no wavelength is counted twice.
export const CASCADES = [
  { L: 701.0, kMin: 0.0, kMax: 0.28, seed: 11 },  // swell: wavelengths ≥ 22 m
  { L: 97.3, kMin: 0.28, kMax: 2.4, seed: 23 },   // chop: 2.6–22 m
  { L: 16.1, kMin: 2.4, kMax: 22, seed: 37 },     // ripples: 0.3–2.6 m (shading only)
];
export const TIME_WRAP = 10000; // seconds; keeps GPU float32 phase precision

function gaussian(rng) {
  let u = 0; while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TWO_PI * rng());
}

/** CPU side: random draws (fixed forever) and the wind-dependent h0 spectra. */
export class OceanSpectrum {
  constructor(N = OCEAN_N) {
    this.N = N;
    this.xi = CASCADES.map((c) => {
      const rng = mulberry32(c.seed * 7919);
      const a = new Float32Array(N * N * 2);
      for (let i = 0; i < a.length; i++) a[i] = gaussian(rng);
      return a;
    });
    this.h0 = CASCADES.map(() => new Float32Array(N * N * 4)); // h0(k).re,im, conj(h0(-k)).re,im
  }

  /** Significant wave height for a sustained wind (Pierson–Moskowitz, scaled for play). */
  static waveHeight(V) { return 0.21 * V * V / G * 0.5 + 0.15; }
  static choppiness(V) { return Math.min(1.15, 0.85 + 0.018 * V); }

  build(V, windAngle) {
    // Fetch-limited sea (a bay, not an ocean): JONSWAP peak frequency ω_p = 22·(g²/(U·F))^(1/3)
    // with F = 30 km gives short, steep wind-waves. Phillips peaks at k = 1/(Lp·√2), so pick Lp to match.
    const FETCH = 30000;
    const wp = 22 * Math.cbrt((G * G) / (Math.max(V, 1) * FETCH));
    const kp = (wp * wp) / G;
    const N = this.N, Lp = 1 / (kp * Math.SQRT2);
    const wx = Math.cos(windAngle), wz = Math.sin(windAngle);
    let variance = 0;
    const amp = CASCADES.map(() => new Float32Array(N * N));
    CASCADES.forEach((c, ci) => {
      const dk = TWO_PI / c.L, a = amp[ci];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const nx = i < N / 2 ? i : i - N, nz = j < N / 2 ? j : j - N;
        const kx = nx * dk, kz = nz * dk, k = Math.hypot(kx, kz);
        if (k < 1e-6 || k < c.kMin || k >= c.kMax) continue;
        let cos = (kx * wx + kz * wz) / k;
        const dir = cos * cos * (cos < 0 ? 0.12 : 1); // waves mostly run downwind
        // Phillips spectrum × grid cell area, with tiny-wave damping
        const P = Math.exp(-1 / ((k * Lp) * (k * Lp))) / (k * k * k * k) * dir * Math.exp(-k * k * 0.0004) * dk * dk;
        a[j * N + i] = Math.sqrt(Math.max(P, 0) / 2);
        variance += P; // E|h0|² summed; field variance = 2 Σ E|h0|²·½ … normalised below
      }
    });
    const target = OceanSpectrum.waveHeight(V) / 4; // Hs = 4σ
    const scale = variance > 0 ? target / Math.sqrt(2 * variance) : 0;
    CASCADES.forEach((c, ci) => {
      const h0 = this.h0[ci], xi = this.xi[ci], a = amp[ci];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const id = j * N + i, mi = ((N - i) % N), mj = ((N - j) % N), mid = mj * N + mi;
        const ar = a[id] * scale, am = a[mid] * scale;
        h0[id * 4] = xi[id * 2] * ar; h0[id * 4 + 1] = xi[id * 2 + 1] * ar;
        // conj(h0(-k))
        h0[id * 4 + 2] = xi[mid * 2] * am; h0[id * 4 + 3] = -xi[mid * 2 + 1] * am;
      }
    });
    this.V = V; this.windAngle = windAngle;
    this.lambda = OceanSpectrum.choppiness(V);
    this.hs = OceanSpectrum.waveHeight(V);
  }
}

/**
 * CPU wave model: the strongest components of the swell and chop cascades,
 * evaluated directly as travelling sinusoids with exactly the GPU's phases.
 */
export class OceanCPU {
  constructor(spectrum, k0 = 56, k1 = 40) {
    this.spec = spectrum; this.k0 = k0; this.k1 = k1;
    this.comps = []; this.h = new Float32Array(0);
    this.select();
  }
  select() {
    const N = this.spec.N, out = [];
    [[0, this.k0, 99], [1, this.k1, 1.25]].forEach(([ci, count, kCap]) => {
      const c = CASCADES[ci], dk = TWO_PI / c.L, h0 = this.spec.h0[ci], cand = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const nx = i < N / 2 ? i : i - N, nz = j < N / 2 ? j : j - N;
        if (nx < 0 || (nx === 0 && nz <= 0)) continue; // one of each ±k pair
        const kx = nx * dk, kz = nz * dk, k = Math.hypot(kx, kz);
        if (k > kCap) continue;
        const id = (j * N + i) * 4;
        const m = Math.hypot(h0[id], h0[id + 1]) + Math.hypot(h0[id + 2], h0[id + 3]);
        if (m > 0) cand.push({ m, kx, kz, k, w: Math.sqrt(G * k), a: h0[id], b: h0[id + 1], c: h0[id + 2], d: h0[id + 3] });
      }
      cand.sort((p, q) => q.m - p.m);
      out.push(...cand.slice(0, count));
    });
    this.comps = out;
    this.h = new Float32Array(out.length * 2);
    this.t = -1;
  }
  /** Evaluate h(k,t) for every component once per time step. */
  setTime(t) {
    if (t === this.t) return;
    this.t = t;
    const cs = this.comps, h = this.h;
    for (let n = 0; n < cs.length; n++) {
      const c = cs[n], er = Math.cos(c.w * t), ei = Math.sin(c.w * t);
      // h0·e^{iωt} + conj(h0(-k))·e^{-iωt}
      h[n * 2] = c.a * er - c.b * ei + c.c * er + c.d * ei;
      h[n * 2 + 1] = c.a * ei + c.b * er + c.d * er - c.c * ei;
    }
  }
  /** Displacement (dx, dy, dz) of the surface point whose rest position is (x, z). */
  displace(x, z, lambda, out) {
    const cs = this.comps, h = this.h;
    let dx = 0, dy = 0, dz = 0;
    for (let n = 0; n < cs.length; n++) {
      const c = cs[n], th = c.kx * x + c.kz * z, ct = Math.cos(th), st = Math.sin(th);
      const zr = h[n * 2] * ct - h[n * 2 + 1] * st, zi = h[n * 2] * st + h[n * 2 + 1] * ct;
      dy += 2 * zr; dx += 2 * (c.kx / c.k) * zi; dz += 2 * (c.kz / c.k) * zi;
    }
    out.x = dx * lambda; out.y = dy; out.z = dz * lambda;
    return out;
  }
  heightOnly(x, z) {
    const cs = this.comps, h = this.h; let dy = 0;
    for (let n = 0; n < cs.length; n++) {
      const c = cs[n], th = c.kx * x + c.kz * z;
      dy += 2 * (h[n * 2] * Math.cos(th) - h[n * 2 + 1] * Math.sin(th));
    }
    return dy;
  }
}

// ---------------------------------------------------------------------------
// GPU pipeline
// ---------------------------------------------------------------------------
const QUAD_VERT = 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }';

const SPECTRUM_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uH0; uniform float uN, uL, uTime; uniform int uWhich;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 h0 = texelFetch(uH0, c, 0);
  float nx = float(c.x) < uN * 0.5 ? float(c.x) : float(c.x) - uN;
  float nz = float(c.y) < uN * 0.5 ? float(c.y) : float(c.y) - uN;
  vec2 k = vec2(nx, nz) * 6.283185307179586 / uL;
  float kl = length(k);
  if (kl < 1e-6) { gl_FragColor = vec4(0.0); return; }
  float ph = sqrt(9.81 * kl) * uTime;
  vec2 e = vec2(cos(ph), sin(ph));
  vec2 h = cmul(h0.xy, e) + cmul(h0.zw, vec2(e.x, -e.y));
  vec2 ih = vec2(-h.y, h.x);
  float kx = k.x, kz = k.y;
  if (uWhich == 0) {
    vec2 F1 = h + (kx / kl) * h;            // Dy + i·Dx
    vec2 F2 = -(kz / kl) * ih - kx * h;      // Dz + i·∂Dy/∂x
    gl_FragColor = vec4(F1, F2);
  } else {
    vec2 F3 = kz * ih + (kx * kx / kl) * ih; // ∂Dy/∂z + i·∂Dx/∂x
    vec2 F4 = (kz * kz / kl) * h + (kx * kz / kl) * ih; // ∂Dz/∂z + i·∂Dx/∂z
    gl_FragColor = vec4(F3, F4);
  }
}`;

// One radix-2 Stockham pass of an unnormalised inverse DFT (verified against a naive DFT).
const FFT_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uInput; uniform float uSub, uN; uniform int uHoriz;
vec2 cmul(vec2 a, vec2 b){ return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x); }
void main(){
  ivec2 fc = ivec2(gl_FragCoord.xy);
  float index = float(uHoriz == 1 ? fc.x : fc.y);
  float hs = uSub * 0.5;
  float ev = floor(index / uSub) * hs + mod(index, hs);
  ivec2 ie = uHoriz == 1 ? ivec2(int(ev), fc.y) : ivec2(fc.x, int(ev));
  ivec2 io = uHoriz == 1 ? ivec2(int(ev + uN * 0.5), fc.y) : ivec2(fc.x, int(ev + uN * 0.5));
  vec4 e = texelFetch(uInput, ie, 0), o = texelFetch(uInput, io, 0);
  float a = 6.283185307179586 * (index / uSub);
  vec2 tw = vec2(cos(a), sin(a));
  gl_FragColor = vec4(e.xy + cmul(tw, o.xy), e.zw + cmul(tw, o.zw));
}`;

const COMBINE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uA, uB; uniform float uLambda; uniform int uWhich;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 A = texelFetch(uA, c, 0), B = texelFetch(uB, c, 0); // A=(Dy,Dx,Dz,sx)  B=(sz,dxx,dzz,dxz)
  if (uWhich == 0) gl_FragColor = vec4(uLambda * A.g, A.r, uLambda * A.b, uLambda * B.a); // dx, dy, dz, ∂Dx/∂z
  else gl_FragColor = vec4(A.a, B.r, uLambda * B.g, uLambda * B.b);                    // sx, sz, ∂Dx/∂x, ∂Dz/∂z
}`;

// Height probe: the exact rendered surface height (swell + chop, choppy-inverted, attenuated)
// on a grid around the camera, read back asynchronously so physics matches the picture.
const PROBE_FRAG = /* glsl */`
precision highp float;
uniform sampler2D uDisp0, uDisp1, uFloor; uniform vec2 uL; uniform float uHalfTexel, uCell, uLevel, uFade0, uFade1;
uniform vec2 uOrigin, uCenter; uniform vec4 uFloorRect;
vec3 disp(vec2 p){
  float depth = uLevel - texture(uFloor, (p - uFloorRect.xy) / uFloorRect.zw).r;
  float a = (1.0 - smoothstep(uFade0, uFade1, length(p - uCenter))) * (0.25 + 0.75 * smoothstep(0.5, 10.0, depth));
  return (textureLod(uDisp0, p / uL.x + uHalfTexel, 0.0).xyz + textureLod(uDisp1, p / uL.y + uHalfTexel, 0.0).xyz) * a;
}
void main(){
  vec2 x = uOrigin + gl_FragCoord.xy * uCell;
  vec2 p = x; vec3 d;
  for (int it = 0; it < 4; it++) { d = disp(p); p = x - d.xz; }
  d = disp(p);
  gl_FragColor = vec4(d.y, 0.0, 0.0, 1.0);
}`;
export const PROBE_N = 128, PROBE_CELL = 3.2;

export class OceanGPU {
  constructor(renderer, spectrum) {
    this.r = renderer; this.spec = spectrum;
    const N = (this.N = spectrum.N);
    this.ok = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
    if (!this.ok) return;
    const work = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    const out = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: true, anisotropy: 4 };
    this.ping = new THREE.WebGLRenderTarget(N, N, work);
    this.cascades = CASCADES.map((c, ci) => {
      const h0Tex = new THREE.DataTexture(spectrum.h0[ci], N, N, THREE.RGBAFormat, THREE.FloatType);
      h0Tex.minFilter = h0Tex.magFilter = THREE.NearestFilter; h0Tex.needsUpdate = true;
      return { ...c, h0Tex, A: new THREE.WebGLRenderTarget(N, N, work), B: new THREE.WebGLRenderTarget(N, N, work),
        disp: new THREE.WebGLRenderTarget(N, N, out), deriv: new THREE.WebGLRenderTarget(N, N, out) };
    });
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri); this.quad.frustumCulled = false; this.scene.add(this.quad);
    const mk = (frag, uniforms) => new THREE.ShaderMaterial({ vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.specMat = mk(SPECTRUM_FRAG, { uH0: { value: null }, uN: { value: N }, uL: { value: 1 }, uTime: { value: 0 }, uWhich: { value: 0 } });
    this.fftMat = mk(FFT_FRAG, { uInput: { value: null }, uSub: { value: 2 }, uN: { value: N }, uHoriz: { value: 1 } });
    this.combMat = mk(COMBINE_FRAG, { uA: { value: null }, uB: { value: null }, uLambda: { value: 1 }, uWhich: { value: 0 } });
  }

  initProbe(floorTex, floorRect, fade0, fade1) {
    if (!this.ok) return;
    const P = PROBE_N;
    this.probeRT = new THREE.WebGLRenderTarget(P, P, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
    this.probeMat = new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: PROBE_FRAG, depthTest: false, depthWrite: false,
      uniforms: { uDisp0: { value: this.cascades[0].disp.texture }, uDisp1: { value: this.cascades[1].disp.texture }, uFloor: { value: floorTex },
        uL: { value: new THREE.Vector2(CASCADES[0].L, CASCADES[1].L) }, uHalfTexel: { value: 0.5 / this.N }, uCell: { value: PROBE_CELL },
        uLevel: { value: 0 }, uFade0: { value: fade0 }, uFade1: { value: fade1 }, uOrigin: { value: new THREE.Vector2() }, uCenter: { value: new THREE.Vector2() },
        uFloorRect: { value: floorRect } },
    });
    this.probeBuf = new Float32Array(P * P * 4);
    this.field = { data: new Float32Array(P * P), ox: 0, oz: 0, valid: false };
    this.pending = false;
  }

  /** Kick off a probe render + async readback unless one is still in flight. */
  probe(center, level, time) {
    if (!this.ok || !this.probeRT || this.pending || this.probeFailed) return;
    const P = PROBE_N, cell = PROBE_CELL, u = this.probeMat.uniforms;
    const ox = Math.round(center.x / cell) * cell - (P / 2) * cell, oz = Math.round(center.y / cell) * cell - (P / 2) * cell;
    u.uOrigin.value.set(ox, oz); u.uCenter.value.copy(center); u.uLevel.value = level;
    const prev = this.r.getRenderTarget();
    this.pass(this.probeMat, this.probeRT);
    this.r.setRenderTarget(prev);
    this.pending = true;
    const issuedAt = time;
    this.readsStarted = (this.readsStarted || 0) + 1;
    try {
      const gl = this.r.getContext();
      const req = this.r.readRenderTargetPixelsAsync(this.probeRT, 0, 0, P, P, this.probeBuf);
      // three.js leaves its pixel-pack buffer bound while it waits; unbind so other reads aren't swallowed
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      req.then(() => {
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        const f = this.field, b = this.probeBuf;
        for (let i = 0; i < P * P; i++) f.data[i] = b[i * 4];
        f.ox = ox; f.oz = oz; f.valid = true; f.time = issuedAt; this.pending = false;
        this.readsDone = (this.readsDone || 0) + 1;
      }, () => { this.pending = false; this.probeFailed = true; });
    } catch (e) { this.pending = false; this.probeFailed = true; console.warn('Ocean height probe unavailable:', e.message); }
  }

  /** Bilinear height from the last probe, or null outside it. Texel i sits at origin + (i + 0.5)·cell. */
  probeHeight(x, z, now) {
    const f = this.field; if (!f || !f.valid) return null;
    // On slow GPUs the readback can lag; a stale field would put boats on old waves.
    if (now !== undefined && Math.abs(now - f.time) > 0.2) return null;
    const P = PROBE_N, fx = (x - f.ox) / PROBE_CELL - 0.5, fz = (z - f.oz) / PROBE_CELL - 0.5;
    if (fx < 1 || fz < 1 || fx > P - 2 || fz > P - 2) return null;
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j, d = f.data;
    const a = d[j * P + i], b = d[j * P + i + 1], c = d[(j + 1) * P + i], e = d[(j + 1) * P + i + 1];
    return (a + (b - a) * u) * (1 - v) + (c + (e - c) * u) * v;
  }

  uploadSpectrum() {
    if (!this.ok) return;
    this.cascades.forEach((c, ci) => { c.h0Tex.image.data = this.spec.h0[ci]; c.h0Tex.needsUpdate = true; });
  }

  pass(mat, target) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.scene, this.cam); }

  /** Inverse 2D FFT in place (result ends back in `rt`: 2·log2(N) passes, an even count). */
  fft(rt) {
    const N = this.N, u = this.fftMat.uniforms;
    let src = rt, dst = this.ping;
    for (const horiz of [1, 0]) for (let s = 2; s <= N; s *= 2) {
      u.uInput.value = src.texture; u.uSub.value = s; u.uHoriz.value = horiz;
      this.pass(this.fftMat, dst);
      [src, dst] = [dst, src];
    }
  }

  simulate(time, lambda, cascadesToRun = 3) {
    if (!this.ok) return;
    const r = this.r, prev = r.getRenderTarget(), prevXR = r.xr.enabled;
    r.xr.enabled = false;
    const su = this.specMat.uniforms, cu = this.combMat.uniforms;
    for (let ci = 0; ci < cascadesToRun; ci++) {
      const c = this.cascades[ci];
      su.uH0.value = c.h0Tex; su.uL.value = c.L; su.uTime.value = time;
      su.uWhich.value = 0; this.pass(this.specMat, c.A);
      su.uWhich.value = 1; this.pass(this.specMat, c.B);
      this.fft(c.A); this.fft(c.B);
      cu.uA.value = c.A.texture; cu.uB.value = c.B.texture; cu.uLambda.value = lambda;
      cu.uWhich.value = 0; this.pass(this.combMat, c.disp);
      cu.uWhich.value = 1; this.pass(this.combMat, c.deriv);
    }
    r.setRenderTarget(prev); r.xr.enabled = prevXR;
  }
}
