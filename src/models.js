import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Authored models (built in Blender, see tools/blender). Each GLB carries a
// "floatilla" JSON blob in its root node's extras with gameplay data in game
// coordinates: deck height, walkable outline, platforms/walls, helm, rig sizes.
export const MODELS = {};

export async function loadModels() {
  const loader = new GLTFLoader();
  const base = import.meta.env.BASE_URL;
  try {
    const gltf = await loader.loadAsync(`${base}models/sloop.glb`);
    const root = gltf.scene.getObjectByName('Sloop') || gltf.scene;
    const info = JSON.parse(root.userData.floatilla);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = !o.name.startsWith('WaterMask');
      o.receiveShadow = true;
      o.userData.fromModel = true;
    });
    MODELS.sloop = { scene: mergeStatic(gltf.scene, root), info };
  } catch (e) {
    console.warn('Sloop model unavailable, using procedural hull:', e && e.message);
  }
}

/**
 * Collapse the model's many static parts into one mesh per material (transforms baked in),
 * keeping named nodes the game animates or replaces (BoomPivot subtree, WaterMask) separate.
 * Cuts ~150 draw calls per boat to ~20.
 */
function mergeStatic(scene, root) {
  scene.updateMatrixWorld(true);
  const keep = new Set();
  const pivot = scene.getObjectByName('BoomPivot');
  if (pivot) pivot.traverse((o) => keep.add(o));
  const groups = new Map(), victims = [];
  scene.traverse((o) => {
    if (!o.isMesh || keep.has(o) || o.name.startsWith('WaterMask')) return;
    const g = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const sig = o.material.uuid + '|' + Object.keys(g.attributes).sort().join(',');
    if (!groups.has(sig)) groups.set(sig, { material: o.material, geos: [] });
    groups.get(sig).geos.push(g.index ? g : g);
    victims.push(o);
  });
  for (const o of victims) o.parent.remove(o);
  const merged = new THREE.Group(); merged.name = 'StaticMerged';
  for (const { material, geos } of groups.values()) {
    const geo = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)), false);
    if (!geo) continue;
    const m = new THREE.Mesh(geo, material);
    m.castShadow = true; m.receiveShadow = true; m.userData.fromModel = true;
    m.name = material.name;
    merged.add(m);
  }
  scene.add(merged);
  return scene;
}
