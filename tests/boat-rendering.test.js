import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { batchStaticPrimitives, disposeBoatBody } from '../src/boat-rendering.js';

test('batching preserves world transforms and leaves animated fittings separate', () => {
  const boat = new THREE.Group(), body = new THREE.Group(), cabin = new THREE.Group(), moving = new THREE.Group();
  boat.position.set(9, 3, -12); boat.rotation.y = 0.7; boat.add(body);
  cabin.position.set(2, 1, 0); cabin.rotation.y = -0.3; body.add(cabin, moving);
  const geometry = new THREE.BoxGeometry(), material = new THREE.MeshStandardMaterial();
  const originals = [];
  for (let i = 0; i < 4; i++) {
    const mesh = new THREE.Mesh(geometry, material); mesh.position.set(i, 2, i * 0.5); mesh.scale.set(0.2, 1, 2);
    cabin.add(mesh); originals.push(mesh);
  }
  const prop = new THREE.Mesh(geometry, material); moving.add(prop);
  boat.updateMatrixWorld(true);
  const expected = originals.map((mesh) => mesh.matrixWorld.clone());
  batchStaticPrimitives(body, new Set([moving]), new Set([geometry]));
  boat.updateMatrixWorld(true);
  const batch = body.children.find((child) => child.isInstancedMesh);
  assert.equal(batch.count, 4);
  assert.equal(prop.parent, moving);
  expected.forEach((world, i) => {
    const instance = new THREE.Matrix4(); batch.getMatrixAt(i, instance); instance.premultiply(batch.matrixWorld);
    instance.elements.forEach((value, j) => assert.ok(Math.abs(value - world.elements[j]) < 0.00001));
  });
});

test('disposal releases owned resources once and preserves cached resources', () => {
  const body = new THREE.Group(), sharedGeo = new THREE.BoxGeometry(), ownGeo = new THREE.SphereGeometry();
  const sharedMat = new THREE.MeshStandardMaterial(), ownMat = new THREE.MeshStandardMaterial();
  body.add(new THREE.Mesh(sharedGeo, sharedMat), new THREE.Mesh(ownGeo, ownMat), new THREE.Mesh(ownGeo, ownMat));
  let geometryDisposals = 0, materialDisposals = 0;
  sharedGeo.addEventListener('dispose', () => assert.fail('Disposed cached geometry'));
  sharedMat.addEventListener('dispose', () => assert.fail('Disposed cached material'));
  ownGeo.addEventListener('dispose', () => geometryDisposals++);
  ownMat.addEventListener('dispose', () => materialDisposals++);
  disposeBoatBody(body, new Set([sharedGeo]), new Set([sharedMat]));
  assert.equal(geometryDisposals, 1); assert.equal(materialDisposals, 1);
});
