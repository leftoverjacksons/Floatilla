// Seeded RNG, value noise and small math helpers shared by every module.
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x, y, seed) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function valueNoise(x, y, seed = 0) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}

/** Fractal noise in roughly [-1, 1]. */
export function fbm(x, y, oct = 4, seed = 0) {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * (valueNoise(x * f, y * f, seed + i * 17) * 2 - 1);
    norm += amp; amp *= 0.5; f *= 2.03;
  }
  return sum / norm;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(e0, e1, x) {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}
export function angleDiff(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
export const rand = (rng, a, b) => a + (b - a) * rng();
export const randInt = (rng, a, b) => Math.floor(a + (b - a + 1) * rng());
/** Exponential approach factor, frame-rate independent. */
export const damp = (rate, dt) => 1 - Math.exp(-rate * dt);

export const FIRST_NAMES = ['Ada', 'Bram', 'Cleo', 'Dmitri', 'Esme', 'Farid', 'Greta', 'Hiro', 'Ines', 'Jonah', 'Kai', 'Lena',
  'Mateo', 'Nia', 'Oskar', 'Priya', 'Quinn', 'Rosa', 'Sol', 'Tomas', 'Uma', 'Viktor', 'Wren', 'Ximena', 'Yusuf', 'Zora',
  'Ansel', 'Bea', 'Cyrus', 'Dalia', 'Emeka', 'Fern', 'Gus', 'Hana', 'Ivo', 'June', 'Kofi', 'Lior', 'Mags', 'Nell'];

const BOAT_A = ['Saint', 'Lucky', 'Old', 'Little', 'Brave', 'Salt', 'Grey', 'Red', 'Wandering', 'Last', 'Stubborn', 'Quiet', 'Iron', 'Drowned'];
const BOAT_B = ['Gull', 'Marlin', 'Heron', 'Margaret', 'Otter', 'Promise', 'Lantern', 'Tern', 'Pike', 'Mabel', 'Ark', 'Barnacle', 'Crow', 'Dory', 'Comet'];
export function boatName(rng) { return `${pick(rng, BOAT_A)} ${pick(rng, BOAT_B)}`; }
