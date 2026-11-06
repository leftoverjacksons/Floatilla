import { Boat } from './boat.js';
import { Person, Animal } from './people.js';
import { findSpot, waterInfo, groundHeight } from './terrain.js';
import { floodDaysFor } from './environment.js';

// Save format is plain JSON in localStorage. Transient world entities (floating
// supplies, rooftop survivors, derelicts, raiders) are not stored; they are
// regenerated around the floatilla for the current water level on load.
export const SAVE_KEY = 'floatilla-save-v1';
const LOAD_FLAG = 'floatilla-load-on-start';

export function readSave() {
  try { const raw = localStorage.getItem(SAVE_KEY); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
export function requestLoadOnReload() { try { sessionStorage.setItem(LOAD_FLAG, '1'); } catch { /* ignore */ } location.reload(); }
export function consumeLoadFlag() {
  try { const f = sessionStorage.getItem(LOAD_FLAG); sessionStorage.removeItem(LOAD_FLAG); return !!f; } catch { return false; }
}

export function serialize(game) {
  const { env, fleet } = game;
  return {
    v: 1, savedAt: Date.now(),
    env: { hours: env.hours, day: env.day, elapsedDays: env.elapsedDays, state: env.state, stateTimer: env.stateTimer,
      cur: { ...env.cur }, windAngle: env.windAngle, levelOffset: env.levelOffset, floodDays: env.floodDays, floodPace: env.floodPace },
    fleet: { inv: { ...fleet.inv }, morale: fleet.morale, stats: { ...fleet.stats }, mode: fleet.mode, detached: fleet.detached,
      playerIndex: fleet.boats.indexOf(fleet.player) },
    landmarks: game.landmarks ? game.landmarks.serialize() : null,
    boats: fleet.boats.filter((b) => !b.sinking).map((b) => ({
      design: { ...b.design }, modules: [...b.modules], x: b.x, z: b.z, heading: b.heading, hp: b.hp,
      anchored: b.anchored, sailsUp: b.sailsUp, throttle: b.role === 'player' ? b.throttle : 0, lightOn: b.lightOn,
      crew: b.crew.map((p) => ({ seed: p.seed, name: p.name, isPlayer: p.isPlayer, health: p.health, skill: p.skill })),
      animals: b.animals.map((a) => ({ type: a.type, seed: a.seed })),
    })),
  };
}

export function writeSave(game) {
  if (game.over || !game.fleet.player) return false;
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(game))); return true; } catch { return false; }
}

/** Rebuilds the floatilla from a save. Called on a fresh page instead of the new-game setup. */
export function restore(game, data) {
  const { env, fleet, world, scene, rng } = game;
  Object.assign(env, { hours: data.env.hours, day: data.env.day, elapsedDays: data.env.elapsedDays, state: data.env.state,
    stateTimer: data.env.stateTimer, windAngle: data.env.windAngle, levelOffset: data.env.levelOffset || 0 });
  // saves from before the adjustable flood: carry the old water level over onto the new curve
  if (data.env.floodDays !== undefined) { env.floodDays = data.env.floodDays; env.floodPace = data.env.floodPace ?? 1; }
  else { const t = Math.min(1, data.env.elapsedDays / 60); env.floodDays = floodDaysFor(4 + 71 * (0.15 * t + 0.85 * t * t * (3 - 2 * t))); env.floodPace = 1; }
  Object.assign(env.cur, data.env.cur);
  Object.assign(fleet.inv, data.fleet.inv);
  Object.assign(fleet.stats, data.fleet.stats);
  fleet.morale = data.fleet.morale;
  if (game.landmarks) game.landmarks.restore(data.landmarks);
  const boats = data.boats.map((s, i) => {
    const b = new Boat(s.design, { x: s.x, z: s.z, heading: s.heading, modules: s.modules, role: i === data.fleet.playerIndex ? 'player' : 'follower', flagColor: 0xff7a1a });
    b.hp = Math.min(b.maxHp, s.hp); b.sailsUp = s.sailsUp; b.throttle = s.throttle; b.lightOn = !!s.lightOn;
    scene.add(b.root); world.boats.push(b);
    fleet.boats.push(b); b.fleet = fleet;
    for (const c of s.crew) {
      const p = new Person(rng, c);
      if (p.isPlayer) game.playerPerson = p;
      b.addPerson(p);
    }
    for (const a of s.animals) b.addAnimal(new Animal(rng, a.type, a.seed));
    return b;
  });
  // Saves from an older map can put boats on land: move any stranded boat to open water off the river mouth.
  boats.forEach((b, i) => {
    if (env.level - groundHeight(b.x, b.z) > b.design.draft + 0.6) return;
    const p = findSpot(-40 + (i % 4) * 25, -150 + Math.floor(i / 4) * 25, -40, env.level - b.design.draft - 1.5, 500, (x, z) => waterInfo(x, z).d < -15);
    b.x = p.x; b.z = p.z; b.vx = b.vz = 0;
  });
  fleet.player = boats[data.fleet.playerIndex] || boats[0];
  fleet.player.role = 'player';
  if (!game.playerPerson) { game.playerPerson = new Person(rng, { isPlayer: true, name: 'You' }); fleet.player.addPerson(game.playerPerson); }
  fleet.trail = [{ x: fleet.player.x, z: fleet.player.z }];
  fleet.mode = data.fleet.mode; fleet.detached = data.fleet.detached;
  for (const b of boats) if (b !== fleet.player) b.anchored = fleet.mode === 'hold' || fleet.detached;
  game.camCtl.snapTo(fleet.player);
}
