import test from 'node:test';
import assert from 'node:assert/strict';
import { segmentBoxEntry } from '../src/camera.js';

const wall = { min: { x: 2, y: -10, z: -2 }, max: { x: 4, y: 8, z: 2 } };
test('camera orbit is blocked before entering a warehouse', () => {
  assert.equal(segmentBoxEntry({ x: 0, y: 2, z: 0 }, { x: 10, y: 3, z: 0 }, wall), 0.2);
  assert.equal(segmentBoxEntry({ x: 10, y: 3, z: 0 }, { x: 0, y: 2, z: 0 }, wall), 0.6);
});
test('camera can see above roofs and outside parallel walls', () => {
  assert.equal(segmentBoxEntry({ x: 0, y: 12, z: 0 }, { x: 10, y: 12, z: 0 }, wall), null);
  assert.equal(segmentBoxEntry({ x: 0, y: 2, z: 4 }, { x: 10, y: 2, z: 4 }, wall), null);
  assert.equal(segmentBoxEntry({ x: 0, y: 2, z: 0 }, { x: 0, y: 2, z: 10 }, wall), null);
});
