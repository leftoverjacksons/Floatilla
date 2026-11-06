import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameStats } from '../src/performance.js';

test('slow frames remain visible below 20 fps', () => {
  const stats = new FrameStats();
  for (let i = 0; i < 120; i++) stats.add(0.1);
  assert.equal(stats.summary().fps, 10);
  assert.equal(stats.summary().p95, 100);
});

test('p95 captures stalls instead of averaging instantaneous fps', () => {
  const stats = new FrameStats(100);
  for (let i = 0; i < 90; i++) stats.add(0.01);
  for (let i = 0; i < 10; i++) stats.add(0.1);
  assert.ok(Math.abs(stats.summary().fps - 1000 / 19) < 0.001);
  assert.equal(stats.summary().p95, 100);
});

test('rolling window recovers and excludes tab suspension', () => {
  const stats = new FrameStats(10);
  for (let i = 0; i < 10; i++) stats.add(0.1);
  for (const bad of [0, -1, NaN, Infinity, 5]) stats.add(bad);
  assert.equal(stats.summary().fps, 10);
  for (let i = 0; i < 10; i++) stats.add(0.02);
  assert.equal(stats.summary().fps, 50);
  assert.equal(stats.summary().p95, 20);
});
