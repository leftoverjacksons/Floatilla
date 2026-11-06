import * as THREE from 'three';

/**
 * Interactive wake: a linear deep-water wave field around the camera focus that boats press on.
 *
 * State per cell (RGBA float): r = height h, g = previous height, b = foam, a = hull pressure head P.
 * Linear theory with surface pressure gives  ∂²h/∂t² = −g·|k|·(h + P)  (P in metres of water). The
 * |k| operator ("vertical derivative") is a convolution whose kernel is least-squares fitted to |k|
 * on the grid (±4 % for k ≥ 0.3 rad/cell, never negative so the scheme is stable). That dispersion
 * (ω² = g|k|) is what makes a moving hull leave a true Kelvin wake rather than a Mach cone.
 * Time stepping follows Tessendorf's iWave:  h⁺ = [h(2−αΔt) − h⁻ − gΔt²/Δx · K∗(h+P)] / (1+αΔt).
 */
export const WAKE_N = 256, WAKE_CELL = 0.8, WAKE_KP = 9;
const MAX_BOATS = 16, MAX_SPLASH = 8, STEP = 1 / 60;

/** Radially symmetric kernel with K∗h ≈ |k|·h (k in rad/cell), fitted over the grid's frequency square. */
export function fitKernel(P = WAKE_KP) {
  const classes = [];
  for (let i = 0; i <= P; i++) for (let j = 0; j <= i; j++) {
    if ((i === 0 && j === 0) || Math.hypot(i, j) > P + 0.5) continue;
    classes.push([i, j]);
  }
  const tapsOf = ([a, b]) => {
    const s = new Set();
    for (const [x, y] of [[a, b], [b, a]]) for (const sx of [1, -1]) for (const sy of [1, -1]) s.add(`${sx * x},${sy * y}`);
    return [...s].map((t) => t.split(',').map(Number));
  };
  const T = classes.map(tapsOf), M = classes.length;
  const N = Array.from({ length: M }, () => new Float64Array(M)), r = new Float64Array(M);
  const G = 72, row = new Float64Array(M);
  for (let a = 0; a < G; a++) for (let b = 0; b < G; b++) {
    const kx = -Math.PI + 2 * Math.PI * (a + 0.5) / G, ky = -Math.PI + 2 * Math.PI * (b + 0.5) / G, k = Math.hypot(kx, ky);
    for (let m = 0; m < M; m++) { let s = 0; for (const [x, y] of T[m]) s += Math.cos(kx * x + ky * y) - 1; row[m] = s; }
    const w = k < 0.06 ? 0.5 : k < 0.7 ? 8 : k < 2.2 ? 1 : 0.15; // favour the long waves wakes live in
    for (let i = 0; i < M; i++) { r[i] += w * row[i] * k; for (let j = 0; j < M; j++) N[i][j] += w * row[i] * row[j]; }
  }
  for (let i = 0; i < M; i++) N[i][i] += 1e-6;
  for (let i = 0; i < M; i++) { // Gaussian elimination with partial pivoting
    let p = i; for (let k = i + 1; k < M; k++) if (Math.abs(N[k][i]) > Math.abs(N[p][i])) p = k;
    [N[i], N[p]] = [N[p], N[i]]; [r[i], r[p]] = [r[p], r[i]];
    for (let k = i + 1; k < M; k++) { const f = N[k][i] / N[i][i]; for (let j = i; j < M; j++) N[k][j] -= f * N[i][j]; r[k] -= f * r[i]; }
  }
  const c = new Float64Array(M);
  for (let i = M - 1; i >= 0; i--) { let s = r[i]; for (let j = i + 1; j < M; j++) s -= N[i][j] * c[j]; c[i] = s / N[i][i]; }
  const taps = [[0, 0, 0]];
  T.forEach((ts, m) => { for (const [x, y] of ts) { taps.push([x, y, c[m]]); taps[0][2] -= c[m]; } });
  return taps;
}

const QUAD_VERT = 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }';

const COMMON = /* glsl */`
precision highp float;
uniform sampler2D uState, uFloor;
uniform vec4 uFloorRect;
uniform vec2 uOrigin;   // world xz of texel (0,0)'s corner
uniform float uLevel, uDt;
const int N = ${WAKE_N};
const float CELL = ${WAKE_CELL.toFixed(3)};
vec4 at(ivec2 c){ return texelFetch(uState, clamp(c, ivec2(0), ivec2(N - 1)), 0); }
vec2 worldOf(ivec2 c){ return uOrigin + (vec2(c) + 0.5) * CELL; }
bool isLand(vec2 w){ return texture2D(uFloor, (w - uFloorRect.xy) / uFloorRect.zw).r > uLevel - 0.15; }
`;

// Pass 1: scroll with the window, stamp hull pressure, splashes, foam sources.
const FORCE_FRAG = /* glsl */`
${COMMON}
uniform ivec2 uShift;
uniform vec4 uBoatA[${MAX_BOATS}];   // x, z, forward.x, forward.z
uniform vec4 uBoatB[${MAX_BOATS}];   // half length, half beam, pressure head, speed
uniform int uBoats;
uniform vec4 uSplash[${MAX_SPLASH}];  // x, z, radius, depth
uniform int uSplashes;
float edgeFoam = 0.0;
float hullP(vec2 w, vec4 A, vec4 B){
  vec2 d = w - A.xy;
  float u = dot(d, A.zw) / B.x;                  // −1 stern … +1 bow
  float v = dot(d, vec2(A.w, -A.z)) / B.y;
  if (abs(u) > 1.05) return 0.0;
  float au = min(abs(u), 1.0);
  float wd = u > 0.0 ? 1.0 - pow(au, 2.2) : 1.0 - pow(au, 5.0); // fine entry, full transom stern
  float e = (wd - abs(v)) * B.y;                 // metres inside the waterline
  float s = smoothstep(-0.5 * CELL, 0.45 * B.y + 0.5 * CELL, e);
  // white water where the hull meets the sea: a band just outside the waterline, strongest at the bow shoulders
  float band = smoothstep(-2.0 * CELL, -0.3 * CELL, e) * (1.0 - smoothstep(0.2 * CELL, 1.2 * CELL, e));
  edgeFoam = max(edgeFoam, band * (0.35 + 0.65 * smoothstep(-0.2, 0.7, u)) * smoothstep(0.8, 4.5, B.w));
  return B.z * s;
}
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  ivec2 src = c + uShift;
  bool inside = all(greaterThanEqual(src, ivec2(0))) && all(lessThan(src, ivec2(N)));
  vec4 s = inside ? at(src) : vec4(0.0);
  vec2 w = worldOf(c);
  if (isLand(w)) { gl_FragColor = vec4(0.0, 0.0, s.b * 0.9, 0.0); return; }
  float P = 0.0, spd = 0.0;
  for (int i = 0; i < ${MAX_BOATS}; i++) {
    if (i >= uBoats) break;
    float p = hullP(w, uBoatA[i], uBoatB[i]);
    if (p > P) { P = p; spd = uBoatB[i].w; }
  }
  float h = s.r, hp = s.g;
  for (int i = 0; i < ${MAX_SPLASH}; i++) {
    if (i >= uSplashes) break;
    vec4 sp = uSplash[i];
    float g = exp(-dot(w - sp.xy, w - sp.xy) / (sp.z * sp.z));
    h -= sp.w * g; hp -= sp.w * g * 0.5;          // a sudden dent radiates rings
    s.b += g * clamp(sp.w * 3.0, 0.0, 1.0);
  }
  // foam: where a hull pushes in (bow) or pulls out of the water (stern), and on steep wake crests
  float dP = (P - s.a) / uDt;
  float churn = (max(dP, 0.0) * 0.5 + max(-dP, 0.0) * 1.1) * smoothstep(0.4, 2.5, spd) * uDt;
  float gx = at(src + ivec2(1, 0)).r - at(src - ivec2(1, 0)).r, gz = at(src + ivec2(0, 1)).r - at(src - ivec2(0, 1)).r;
  float slope = length(vec2(gx, gz)) / (2.0 * CELL);
  float foam = s.b;
  if (inside) { // a little spreading so trails widen and soften as they age
    float nb = at(src + ivec2(1, 0)).b + at(src - ivec2(1, 0)).b + at(src + ivec2(0, 1)).b + at(src - ivec2(0, 1)).b;
    foam = mix(foam, nb * 0.25, 0.012);
  }
  foam = max(foam * exp(-uDt / 3.2) + churn * 0.3, edgeFoam * 0.75) + max(slope - 0.25, 0.0) * 2.0 * uDt * step(max(P, s.a), 0.001);
  gl_FragColor = vec4(h, hp, min(foam, 1.0), P);
}`;

function waveFrag(taps) {
  const lines = taps.map(([i, j, w]) => {
    const t = `at(c + ivec2(${i}, ${j}))`;
    return `  conv += ${w.toFixed(7)} * (${t}.r + ${t}.a);`;
  });
  return /* glsl */`
${COMMON}
uniform float uAlpha;
void main(){
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = at(c);
  if (isLand(worldOf(c))) { gl_FragColor = vec4(0.0, 0.0, s.b, 0.0); return; }
  float conv = 0.0;
${lines.join('\n')}
  float a = uAlpha * uDt;
  float h = (s.r * (2.0 - a) - s.g - 9.81 * uDt * uDt / CELL * conv) / (1.0 + a);
  // absorbing border so waves leave the window instead of reflecting
  float e = float(min(min(c.x, c.y), min(N - 1 - c.x, N - 1 - c.y)));
  float k = 0.86 + 0.14 * smoothstep(0.0, 20.0, e);
  h *= k;
  float hp = s.r * k;
  if (!(abs(h) < 50.0)) { h = 0.0; hp = 0.0; }     // never let a bad cell poison the field
  gl_FragColor = vec4(h, hp, s.b, s.a);
}`;
}

export class WakeSim {
  constructor(renderer, floorTex, floorRect) {
    this.r = renderer;
    this.ok = renderer.capabilities.isWebGL2 && renderer.extensions.has('EXT_color_buffer_float');
    this.origin = new THREE.Vector2(); // world corner of the window
    this.size = WAKE_N * WAKE_CELL;
    this.acc = 0; this.boats = []; this.splashes = [];
    if (!this.ok) return;
    const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.A = new THREE.WebGLRenderTarget(WAKE_N, WAKE_N, opts);
    this.B = new THREE.WebGLRenderTarget(WAKE_N, WAKE_N, opts);
    this.scene = new THREE.Scene();
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(tri); this.quad.frustumCulled = false; this.scene.add(this.quad);
    const common = () => ({
      uState: { value: null }, uFloor: { value: floorTex }, uFloorRect: { value: floorRect },
      uOrigin: { value: this.origin }, uLevel: { value: 0 }, uDt: { value: STEP },
    });
    const mk = (frag, extra) => new THREE.ShaderMaterial({ glslVersion: null, vertexShader: QUAD_VERT, fragmentShader: frag, uniforms: { ...common(), ...extra }, depthTest: false, depthWrite: false });
    this.forceMat = mk(FORCE_FRAG, {
      uShift: { value: new THREE.Vector2() },
      uBoatA: { value: Array.from({ length: MAX_BOATS }, () => new THREE.Vector4()) },
      uBoatB: { value: Array.from({ length: MAX_BOATS }, () => new THREE.Vector4()) },
      uBoats: { value: 0 },
      uSplash: { value: Array.from({ length: MAX_SPLASH }, () => new THREE.Vector4()) },
      uSplashes: { value: 0 },
    });
    this.waveMat = mk(waveFrag(fitKernel()), { uAlpha: { value: 0.07 } });
    this.started = false;
  }

  get texture() { return this.ok ? this.A.texture : null; }

  /** Is world (x, z) inside the simulated window (with a margin)? */
  covers(x, z, margin = 12) {
    return this.ok && this.started && x > this.origin.x + margin && x < this.origin.x + this.size - margin && z > this.origin.y + margin && z < this.origin.y + this.size - margin;
  }

  /** Boats pressing on the water this frame. `heading` 0 faces +z. */
  addBoat(x, z, heading, halfL, halfB, head, speed) { if (this.boats.length < MAX_BOATS) this.boats.push([x, z, Math.sin(heading), Math.cos(heading), halfL, halfB, head, speed]); }
  /** A dent in the water (something hitting it): rings and foam. */
  splash(x, z, radius, depth) { if (this.splashes.length < MAX_SPLASH) this.splashes.push([x, z, radius, depth]); }

  update(dt, focus, level) {
    if (!this.ok) return;
    // window follows the focus in whole cells
    const ox = Math.round((focus.x - this.size / 2) / WAKE_CELL) * WAKE_CELL;
    const oz = Math.round((focus.z - this.size / 2) / WAKE_CELL) * WAKE_CELL;
    let shift = [0, 0];
    if (!this.started) { this.origin.set(ox, oz); this.started = true; this.clear(); } else {
      shift = [Math.round((ox - this.origin.x) / WAKE_CELL), Math.round((oz - this.origin.y) / WAKE_CELL)];
      if (Math.abs(shift[0]) >= WAKE_N || Math.abs(shift[1]) >= WAKE_N) { this.origin.set(ox, oz); this.clear(); shift = [0, 0]; }
    }
    this.acc = Math.min(this.acc + dt, STEP * 4);
    const fu = this.forceMat.uniforms;
    fu.uBoats.value = this.boats.length;
    this.boats.forEach((b, i) => { fu.uBoatA.value[i].set(b[0], b[1], b[2], b[3]); fu.uBoatB.value[i].set(b[4], b[5], b[6], b[7]); });
    const prev = this.r.getRenderTarget();
    let first = true;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      if (first) {
        // move the window: texel c now shows what src = c + shift showed
        this.origin.x += shift[0] * WAKE_CELL; this.origin.y += shift[1] * WAKE_CELL;
        fu.uShift.value.set(shift[0], shift[1]);
        fu.uSplashes.value = this.splashes.length;
        this.splashes.forEach((s, i) => fu.uSplash.value[i].set(s[0], s[1], s[2], s[3]));
      } else { fu.uShift.value.set(0, 0); fu.uSplashes.value = 0; }
      first = false;
      for (const m of [this.forceMat, this.waveMat]) m.uniforms.uLevel.value = level;
      fu.uState.value = this.A.texture; this.pass(this.forceMat, this.B);
      this.waveMat.uniforms.uState.value = this.B.texture; this.pass(this.waveMat, this.A);
    }
    if (!first) this.splashes.length = 0;
    this.boats.length = 0;
    this.r.setRenderTarget(prev);
  }

  clear() {
    const prev = this.r.getRenderTarget(), col = new THREE.Color(), a = this.r.getClearAlpha();
    this.r.getClearColor(col);
    this.r.setClearColor(0x000000, 0);
    for (const t of [this.A, this.B]) { this.r.setRenderTarget(t); this.r.clear(true, false, false); }
    this.r.setClearColor(col, a); this.r.setRenderTarget(prev);
  }

  pass(mat, target) { this.quad.material = mat; this.r.setRenderTarget(target); this.r.render(this.scene, this.cam); }
}
