// Frame statistics use wall time, never the capped simulation step.
export class FrameStats {
  constructor(capacity = 180) {
    this.samples = new Float32Array(capacity);
    this.count = 0; this.cursor = 0;
  }
  add(seconds) {
    // Ignore tab suspension, but retain genuinely slow frames (including >50 ms).
    if (!(seconds > 0) || seconds >= 1) return;
    this.samples[this.cursor] = seconds * 1000;
    this.cursor = (this.cursor + 1) % this.samples.length;
    this.count = Math.min(this.count + 1, this.samples.length);
  }
  summary() {
    if (!this.count) return { fps: 0, mean: 0, p95: 0 };
    const sorted = Array.from(this.samples.subarray(0, this.count)).sort((a, b) => a - b);
    const mean = sorted.reduce((a, b) => a + b, 0) / this.count;
    return { fps: 1000 / mean, mean, p95: sorted[Math.ceil(this.count * 0.95) - 1] };
  }
}
