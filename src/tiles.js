import * as THREE from 'three';

// Large instanced batches are split into spatial tiles so frustum culling (main
// view, shadow map, reflection) can skip whole tiles instead of drawing every
// instance in the city in every pass.
export const TILE = 300;
// Objects on this layer are skipped by the water reflection pass (trees, cars, small props).
export const LAYER_NO_REFLECT = 1;

export function tiled(items, posOf, build) {
  const map = new Map();
  for (const it of items) {
    const [x, z] = posOf(it);
    const k = `${Math.floor(x / TILE)},${Math.floor(z / TILE)}`;
    let a = map.get(k); if (!a) map.set(k, (a = [])); a.push(it);
  }
  const g = new THREE.Group();
  for (const sub of map.values()) {
    const m = build(sub);
    m.computeBoundingSphere();
    g.add(m);
  }
  return g;
}
