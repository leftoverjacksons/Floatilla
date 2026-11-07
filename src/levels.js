import { RIVERS } from './terrain.js';

/**
 * The voyage is a short run of levels, each a district of the drowned valley with the water held at
 * one height. Every level has a way in and one or more ways out; the exit chosen decides the next
 * level. Higher levels sit further inland and higher up, with the water higher too, so each one
 * floods a different part of the town and the bridges and shallows become different chokepoints.
 *
 * A level's playable area is a union of capsules (segment + radius). Near the edge the fog closes in;
 * past it, the boat is turned back.
 */

const at = (ri, t) => {
  const P = RIVERS[ri].pts, f = t * (P.length - 1), i = Math.min(P.length - 2, Math.floor(f)), u = f - i;
  return { x: P[i].x + (P[i + 1].x - P[i].x) * u, z: P[i].z + (P[i + 1].z - P[i].z) * u };
};
const headingAlong = (ri, t) => { const a = at(ri, t), b = at(ri, t + 0.01); return Math.atan2(b.x - a.x, b.z - a.z); };
/** Capsules following a river between t0 and t1. */
function riverCorridor(ri, t0, t1, r) {
  const out = [];
  const n = Math.max(2, Math.ceil((t1 - t0) / 0.04));
  for (let i = 0; i < n; i++) {
    const a = at(ri, t0 + (t1 - t0) * i / n), b = at(ri, t0 + (t1 - t0) * (i + 1) / n);
    out.push([a.x, a.z, b.x, b.z, r]);
  }
  return out;
}
const exitAt = (ri, t, to, label, blurb) => ({ ...at(ri, t), to, label, blurb });

export const LEVELS = {
  harbour: {
    name: 'The Harbour', depth: 1, water: 2.4, hour: 7,
    intro: 'The tide never went out. The water stands over the quays and laps at the pier decks, and the low streets behind the waterfront are already ankle-deep canals. Everyone with sense has gone inland.',
    region: [[-620, 230, 640, 230, 640], [60, 650, 60, 1320, 330]],
    start: { x: 60, z: 960, heading: Math.PI },
    exits: [
      exitAt(0, 0.045, 'oldtown', 'Up the river', 'The river runs north through the old town. Three road bridges cross it.'),
      exitAt(1, 0.055, 'works', 'Up the creek', 'The creek winds past the docks and the works yards. One bridge, then the marsh.'),
    ],
    boats: { n: 5, kinds: [['rowboat', 3], ['skiff', 3], ['sailboat', 2], ['houseboat', 2], ['fishing', 1.5], ['raft', 1]] },
    gear: 1, survivors: 3, caches: 4, harbour: true,
  },
  oldtown: {
    name: 'The Old Town', depth: 2, water: 4.0, hour: 7,
    intro: 'Overnight the water climbed another metre and a half. The river has spread into the streets on both banks; only the bridge decks and the upper floors stand clear. The bridges are the problem: there is not much room left beneath them.',
    region: [...riverCorridor(0, 0.0, 0.43, 210), [120, -470, 120, -470, 330]],
    start: { ...at(0, 0.02), heading: headingAlong(0, 0.02) },
    exits: [exitAt(0, 0.42, 'upper', 'The upper river', 'Beyond the last bridge the valley narrows toward the hills.')],
    boats: { n: 6, kinds: [['rowboat', 2], ['skiff', 3], ['sailboat', 2], ['fishing', 2], ['houseboat', 1.5], ['yacht', 1.5], ['tug', 1]] },
    gear: 2, survivors: 3, caches: 4,
  },
  works: {
    name: 'The Works', depth: 2, water: 4.0, hour: 7,
    intro: 'Overnight the water climbed another metre and a half. The creek has swallowed the container yards and the works, and loose cargo drifts between the cranes. There is one bridge, and it sits low.',
    region: [...riverCorridor(1, 0.0, 0.48, 220), [640, -170, 640, -170, 300]],
    start: { ...at(1, 0.02), heading: headingAlong(1, 0.02) },
    exits: [exitAt(1, 0.46, 'fells', 'The fells', 'The creek climbs into marshland and then the fells. There is talk of a camp on the high ground.')],
    boats: { n: 6, kinds: [['skiff', 2], ['fishing', 3], ['tug', 2], ['houseboat', 1.5], ['yacht', 1], ['sailboat', 1]] },
    gear: 2, survivors: 3, caches: 5,
  },
  upper: {
    name: 'The Upper River', depth: 3, water: 9, hour: 7,
    intro: 'The valley floor is gone. The river is a long lake between wooded slopes, the farms and lanes are under the water, and the camp on the ridge is the only light anyone has seen.',
    region: riverCorridor(0, 0.40, 0.86, 260),
    start: { ...at(0, 0.415), heading: headingAlong(0, 0.415) },
    exits: [exitAt(0, 0.84, 'end', 'The ridge camp', 'High ground, a fire, people. The end of the voyage.')],
    boats: { n: 5, kinds: [['fishing', 2], ['yacht', 2], ['tug', 1.5], ['schooner', 1.5], ['sailboat', 1.5], ['skiff', 1]] },
    gear: 3, survivors: 3, caches: 4,
  },
  fells: {
    name: 'The Fells', depth: 3, water: 9, hour: 7,
    intro: 'Marsh, then moor, all of it under water. The creek is a broad, shallow inland sea with hedgerows and fence posts just below the surface. The camp on the high ground is somewhere ahead.',
    region: riverCorridor(1, 0.44, 0.9, 260),
    start: { ...at(1, 0.455), heading: headingAlong(1, 0.455) },
    exits: [exitAt(1, 0.88, 'end', 'The high camp', 'High ground, a fire, people. The end of the voyage.')],
    boats: { n: 5, kinds: [['fishing', 2], ['barge', 1.5], ['tug', 1.5], ['schooner', 1.5], ['yacht', 1.5], ['houseboat', 1]] },
    gear: 3, survivors: 3, caches: 4,
  },
};
export const FIRST_LEVEL = 'harbour';
export const LEVEL_COUNT = 3;

/** Signed distance (m) to the edge of the level's playable area: negative inside. */
export function edgeDistance(level, x, z) {
  let best = Infinity;
  // the way in and the ways out are always inside, with room to manoeuvre
  for (const e of [level.start, ...level.exits]) best = Math.min(best, Math.hypot(x - e.x, z - e.z) - 120);
  for (const [ax, az, bx, bz, r] of level.region) {
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    const d = Math.hypot(x - (ax + ex * u), z - (az + ez * u)) - r;
    if (d < best) best = d;
  }
  return best;
}
/** Direction back toward the playable area (unit [x, z]) from the nearest capsule's spine. */
export function inwardDir(level, x, z) {
  let best = Infinity, dir = [0, 0];
  for (const [ax, az, bx, bz, r] of level.region) {
    const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
    const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / l2)) : 0;
    const qx = ax + ex * u, qz = az + ez * u, d = Math.hypot(x - qx, z - qz) - r;
    if (d < best) { best = d; const l = Math.hypot(qx - x, qz - z) || 1; dir = [(qx - x) / l, (qz - z) / l]; }
  }
  return dir;
}

// ---------------------------------------------------------------------------
// Run state: which level, the path so far, and everything carried between levels (the boat, its
// gear, the crew and the stores). Stored in localStorage; a level is always (re)started from its
// beginning with the state the run had when it arrived there.
// ---------------------------------------------------------------------------
const RUN_KEY = 'floatilla-run-v1';
export function readRun() {
  try { const r = localStorage.getItem(RUN_KEY); return r ? JSON.parse(r) : null; } catch { return null; }
}
export function writeRun(run) {
  try { localStorage.setItem(RUN_KEY, JSON.stringify(run)); return true; } catch { return false; }
}
/** Bridges inside a level, and how much room each leaves at that level's water. */
export function levelBridges(level, city) {
  return city.colliders.filter((c) => c.kind === 'bridge' && edgeDistance(level, c.cx, c.cz) < 0).map((c) => ({ c, clearance: c.bottom - level.water }));
}
export function clearRun() { try { localStorage.removeItem(RUN_KEY); } catch { /* ignore */ } }
export function newRun() {
  return { v: 1, seed: (Math.random() * 1e9) | 0, level: FIRST_LEVEL, path: [FIRST_LEVEL], carry: null, startedAt: Date.now(), stats: { rescued: 0, lost: 0, swaps: 0 } };
}
