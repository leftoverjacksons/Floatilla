import * as THREE from 'three';
import { clamp, angleDiff, damp } from './util.js';

/** Third-person orbit camera that trails the lead boat. Drag to orbit, wheel to zoom. */
export class CameraController {
  constructor(camera, dom) {
    this.camera = camera;
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
    this.camera.position.copy(pos);
    this.camera.lookAt(this.target);
  }
}
