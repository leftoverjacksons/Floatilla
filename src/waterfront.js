import { smoothstep } from './util.js';

/**
 * Waves breaking over quays and pier decks. Edges (city.waterfront: point, outward normal, length,
 * deck height) near the camera are sampled each frame; where the actual wave surface climbs within
 * ~0.5 m of the deck, a sheet of spray is thrown up the face and water sluices across the deck as foam.
 * Once a deck is well under water the waves roll over it without breaking.
 */
export class Overtopping {
  constructor(city) { this.city = city; this.near = []; this.t = 0; this.soundT = 0; }

  update(dt, ctx, cam, audio) {
    if (dt <= 0 || !ctx.fx) return;
    this.t -= dt; this.soundT -= dt;
    if (this.t <= 0) { this.t = 1; this.near = this.city.waterfront.filter((e) => Math.hypot(e.x - cam.x, e.z - cam.z) < 240); }
    if (!this.near.length) return;
    const { water, fx } = ctx, level = water.level;
    const samples = Math.min(32, this.near.length * 2);
    for (let i = 0; i < samples; i++) {
      const e = this.near[(Math.random() * this.near.length) | 0];
      const u = (Math.random() - 0.5) * e.len;
      const x = e.x - e.nz * u + e.nx * 0.5, z = e.z + e.nx * u + e.nz * 0.5; // just off the face
      const h = water.heightFast(x, z);
      const reach = h - (e.top - 0.55);
      if (reach <= 0) continue;
      const k = Math.min(1, reach / 0.7) * smoothstep(e.top + 0.9, e.top + 0.25, level);
      if (k <= 0.01 || Math.random() > dt * 10 * k) continue;
      const m = 2 + Math.round(k * 9);
      for (let j = 0; j < m; j++) {
        const jx = (Math.random() - 0.5) * 1.6, jz = (Math.random() - 0.5) * 1.6, out = 0.4 + Math.random() * 2.2 * k;
        fx.emit(x + jx * Math.abs(e.nz) + e.nx * 0.2, e.top + Math.random() * 0.2, z + jz * Math.abs(e.nx) + e.nz * 0.2,
          -e.nx * out + jx * 0.4, 1.6 + Math.random() * 4 * k, -e.nz * out + jz * 0.4, 0.7 + Math.random() * 0.7, 0.22 + Math.random() * 0.35, 1);
      }
      if (h > e.top - 0.2) { // green water over the deck
        const d = 0.6 + Math.random() * 2.4;
        fx.emitFoam(x - e.nx * d, e.top + 0.05, z - e.nz * d, -e.nx * 0.7, -e.nz * 0.7, 2 + Math.random() * 2, 1 + Math.random() * 1.6, true);
      }
      if (ctx.wake) ctx.wake.splash(x, z, 1.1, 0.04 * k);
      if (audio && this.soundT <= 0 && Math.hypot(x - cam.x, z - cam.z) < 70) { this.soundT = 0.6 + Math.random(); audio.splash(k * 0.35); }
    }
  }
}
