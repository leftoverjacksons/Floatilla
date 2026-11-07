import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { registerTownKit } from './townkit.js';

// Authored models (built in Blender, see tools/blender). Each GLB carries a
// "floatilla" JSON blob in its root node's extras with gameplay data in game
// coordinates: deck height, walkable outline, platforms/walls, helm, rig sizes.
export const MODELS = {};

export async function loadModels() {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL;
  const kinds = ['sloop', 'raft', 'rowboat', 'skiff', 'raider', 'fishing', 'tug', 'yacht', 'houseboat', 'barge', 'schooner'];
  await Promise.all([(async () => {
    try { registerTownKit(await loader.loadAsync(`${base}models/town.glb`)); }
    catch (e) { console.warn('Town kit unavailable, using box buildings:', e && e.message); }
  })(), ...kinds.map(async (kind) => {
    try {
      const gltf = await loader.loadAsync(`${base}models/${kind}.glb`);
      let root = null;
      gltf.scene.traverse((o) => { if (!root && o.userData && o.userData.floatilla) root = o; });
      const info = JSON.parse(root.userData.floatilla);
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = !o.name.startsWith('WaterMask');
        o.receiveShadow = true;
        o.userData.fromModel = true;
      });
      MODELS[kind] = { scene: mergeStatic(gltf.scene, info), info };
    } catch (e) {
      console.warn(`Model "${kind}" unavailable, using the procedural boat:`, e && e.message);
    }
  })]);
}

/** Boat design kind → model key. */
export function modelFor(kind) { return MODELS[kind === 'sailboat' ? 'sloop' : kind] || null; }

/**
 * Collapse the model's many static parts into one mesh per material (transforms baked in),
 * keeping named nodes the game animates or replaces (BoomPivot subtree, WaterMask) separate.
 * Cuts ~150 draw calls per boat to ~20.
 */
// everything that stands on a mast and comes down with it (stays and shrouds are hidden when it is struck)
const RIG = /^(Mast|Masthead|MastLight|Topmast|Springstay|Radar|Spreader|Windex|FurledJib|JibCover|Forestay|Backstay|LowerShroud|UpperShroud|Shroud)/;
const STAY = /(Shroud|stay)/;
function mergeStatic(scene, info = {}) {
  scene.updateMatrixWorld(true);
  const keep = new Set();
  // animated or replaced nodes stay separate: booms, oars, propellers
  scene.traverse((o) => { if (/^(BoomPivot|OarPivot|Prop)/.test(o.name)) o.traverse((c) => keep.add(c)); });
  // Masts and their rigging merge separately, one set per mast, so a mast can be struck (folded down).
  const mastZ = info.rigs ? info.rigs.map((r) => r.mastZ) : info.mast ? [info.mast[2]] : [];
  const rigOf = (o) => { for (let q = o; q && q !== scene; q = q.parent) if (RIG.test(q.name)) return q; return null; };
  const groups = new Map(), victims = [], box = new THREE.Box3();
  scene.traverse((o) => {
    if (!o.isMesh || keep.has(o) || o.name.startsWith('WaterMask')) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    let key = 'hull';
    const rig = rigOf(o);
    if (rig) {
      g.computeBoundingBox(); box.copy(g.boundingBox);
      const z = (box.min.z + box.max.z) / 2;
      if (!mastZ.length) mastZ.push(z);
      let k = 0; mastZ.forEach((m, i) => { if (Math.abs(m - z) < Math.abs(mastZ[k] - z)) k = i; });
      key = `${STAY.test(rig.name) ? 'shroud' : 'rig'}${k}`;
    }
    const sig = key + '|' + o.material.uuid + '|' + Object.keys(g.attributes).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, { key, material: o.material, geos: [] });
    groups.get(sig).geos.push(g);
    victims.push(o);
  });
  for (const o of victims) o.parent.remove(o);
  const holders = {};
  const holder = (key) => {
    if (holders[key]) return holders[key];
    const h = new THREE.Group();
    h.name = key === 'hull' ? 'StaticMerged' : key.startsWith('rig') ? `RigGroup${key.slice(3)}` : `RigShroud${key.slice(6)}`;
    scene.add(h); return (holders[key] = h);
  };
  for (const { key, material, geos } of groups.values()) {
    const geo = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    if (!geo) continue;
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true; m.receiveShadow = true; m.userData.fromModel = true;
    m.name = material.name;
    holder(key).add(m);
  }
  // where each mast stands: the foot of its own geometry, at its centreline
  for (const [key, h] of Object.entries(holders)) {
    if (!key.startsWith('rig')) continue;
    box.setFromObject(h);
    h.userData.foot = [0, box.min.y, mastZ[+key.slice(3)] ?? (box.min.z + box.max.z) / 2];
  }
  return scene;
}
