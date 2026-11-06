import * as THREE from 'three';
import { clamp, angleDiff, damp } from './util.js';

// Segment/AABB entry fraction, used to keep scenery out from between boat and camera.
export function segmentBoxEntry(start, end, bounds) {
  let near = 0, far = 1;
  for (const axis of ['x', 'y', 'z']) {
    const delta = end[axis] - start[axis], min = bounds.min[axis], max = bounds.max[axis];
    if (Math.abs(delta) < 1e-8) { if (start[axis] < min || start[axis] > max) return null; continue; }
    let a = (min - start[axis]) / delta, b = (max - start[axis]) / delta;
    if (a > b) [a, b] = [b, a];
    near = Math.max(near, a); far = Math.min(far, b);
    if (near > far) return null;
  }
  return near;
}

/** Third-person orbit camera that trails the lead boat. Drag to orbit, wheel to zoom. */
export class CameraController {
  constructor(camera, dom, city = null) {
    this.camera = camera;
    this.city = city;
    this.yaw = Math.PI; this.pitch = 0.4; this.dist = 25;
    this.target = new THREE.Vector3();
    this.dragging = false; this.lastDrag = -10; this.time = 0;
    this.shake = 0;
    dom.addEventListener('mousedown', (e) => { if (e.target === dom && e.button !== 2) { this.dragging = true; this.px = e.clientX; this.py = e.clientY; } });
    window.addEventListener('mouseup', () => (this.dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (!this.dragging) return;
      this.yaw -= (e.clientX - this.px) * 0.005; this.pitch = clamp(this.pitch + (e.clientY - this.py) * 0.004, -0.05, 1.4);
      this.px = e.clientX; this.py = e.clientY; this.lastDrag = this.time;
    });
    dom.addEventListener('wheel', (e) => { this.dist = clamp(this.dist * (1 + Math.sign(e.deltaY) * 0.1), 5, 220); e.preventDefault(); }, { passive: false });
  }
  snapTo(boat) { this.lastDrag = -10; this.yaw = boat.heading + Math.PI; this.target.set(boat.x, boat.y + 2, boat.z); }
  update(dt, boat, water) {
    this.time += dt;
    const k = damp(6, dt);
    this.target.x += (boat.x - this.target.x) * k;
    this.target.z += (boat.z - this.target.z) * k;
    this.target.y += (boat.y + 1.5 + boat.L * 0.08 - this.target.y) * damp(3, dt);
    if (!this.dragging && this.time - this.lastDrag > 2.5 && boat.speed > 0.8) {
      this.yaw += angleDiff(this.yaw, boat.heading + Math.PI) * damp(0.9, dt);
    }
    const d = this.dist * (0.8 + boat.L * 0.02);
    const cp = Math.cos(this.pitch);
    const pos = new THREE.Vector3(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp).multiplyScalar(d).add(this.target);
    const minY = water.heightAt(pos.x, pos.z) + 1.2;
    if (pos.y < minY) pos.y = minY;
    this.shake = Math.max(0, this.shake - dt * 2);
    if (this.shake > 0) pos.add(new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)).multiplyScalar(this.shake * 0.6));
    if (this.city) {
      let fraction = 1;
      const length = pos.distanceTo(this.target);
      const radius = Math.hypot(pos.x - this.target.x, pos.z - this.target.z) / 2 + 1;
      this.city.forEachNear((pos.x + this.target.x) / 2, (pos.z + this.target.z) / 2, radius, (building) => {
        const entry = segmentBoxEntry(this.target, pos, {
          min: { x: building.minx - 0.4, y: -1000, z: building.minz - 0.4 },
          max: { x: building.maxx + 0.4, y: building.top + 0.4, z: building.maxz + 0.4 },
        });
        // If the focus itself is inside a collider, allow the camera to escape it.
        if (entry !== null && entry > 0.001) fraction = Math.min(fraction, Math.max(0, entry - 0.7 / Math.max(length, 1)));
      });
      if (fraction < 1) pos.lerp(this.target, 1 - fraction);
    }
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }
}
