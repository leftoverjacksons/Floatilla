import * as THREE from 'three';

// Batch repeated fittings within each boat, keeping every animated hierarchy intact.
// Collision/walking bounds must be computed before replacing the source meshes.
export function batchStaticPrimitives(root, dynamicRoots, sharedGeometries) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert(), groups = new Map();
  root.traverse((mesh) => {
    if (!mesh.isMesh || mesh.isInstancedMesh || !sharedGeometries.has(mesh.geometry)) return;
    for (let parent = mesh; parent && parent !== root; parent = parent.parent) if (dynamicRoots.has(parent)) return;
    if (Array.isArray(mesh.material) || mesh.material.transparent) return;
    const key = `${mesh.geometry.uuid}/${mesh.material.uuid}/${mesh.castShadow}/${mesh.receiveShadow}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(mesh);
  });
  const matrix = new THREE.Matrix4();
  for (const meshes of groups.values()) {
    if (meshes.length < 3) continue;
    const first = meshes[0], batch = new THREE.InstancedMesh(first.geometry, first.material, meshes.length);
    batch.castShadow = first.castShadow; batch.receiveShadow = first.receiveShadow;
    meshes.forEach((mesh, i) => {
      matrix.multiplyMatrices(inverse, mesh.matrixWorld);
      batch.setMatrixAt(i, matrix);
      mesh.removeFromParent();
    });
    batch.computeBoundingSphere();
    root.add(batch);
  }
}

// Only the boat body owns these resources. Crew, cached primitives/materials and
// the shared plank texture survive rebuilds and removal of other boats.
export function disposeBoatBody(body, sharedGeometries, sharedMaterials) {
  if (!body) return;
  const geometries = new Set(), materials = new Set();
  body.traverse((mesh) => {
    if (!mesh.isMesh) return;
    if (mesh.isInstancedMesh) mesh.dispose();
    if (!sharedGeometries.has(mesh.geometry)) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material && !sharedMaterials.has(material)) materials.add(material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
