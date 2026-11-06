// Procedural ambience: wind, rain, waves, engine, thunder, UI blips. No asset files.
export class Audio {
  constructor() { this.ctx = null; }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let b = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b = (b + 0.02 * w) / 1.02; d[i] = b * 3.5 + w * 0.15; }
    this.noiseBuf = buf;
    this.master = ctx.createGain(); this.master.gain.value = 0.6; this.master.connect(ctx.destination);
    const noise = (type, freq, q) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
      src.playbackRate.value = 0.7 + Math.random() * 0.6;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain(); g.gain.value = 0;
      src.connect(f).connect(g).connect(this.master); src.start();
      return { f, g };
    };
    this.wind = noise('bandpass', 500, 0.6);
    this.rain = noise('highpass', 2500, 0.3);
    this.waves = noise('lowpass', 400, 0.5);
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 50;
    const of = ctx.createBiquadFilter(); of.type = 'lowpass'; of.frequency.value = 300;
    this.engGain = ctx.createGain(); this.engGain.gain.value = 0;
    osc.connect(of).connect(this.engGain).connect(this.master); osc.start();
    this.osc = osc;
  }
  update(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.wind.g.gain.setTargetAtTime(Math.min(0.5, 0.03 + s.wind * 0.02), t, 0.5);
    this.wind.f.frequency.setTargetAtTime(300 + s.wind * 40, t, 0.5);
    this.rain.g.gain.setTargetAtTime(s.rain * 0.18, t, 0.5);
    this.waves.g.gain.setTargetAtTime(0.12 + s.sea * 0.12 + s.speed * 0.02, t, 0.3);
    this.waves.f.frequency.setTargetAtTime(250 + s.speed * 60 + Math.sin(t * 0.4) * 80, t, 0.3);
    this.engGain.gain.setTargetAtTime(s.engine ? 0.035 + Math.abs(s.throttle) * 0.05 : 0, t, 0.15);
    this.osc.frequency.setTargetAtTime(38 + Math.abs(s.throttle) * 70 + s.power * 0.02, t, 0.2);
  }
  thunder() {
    if (!this.ctx) return;
    const ctx = this.ctx, src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.playbackRate.value = 0.25;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 180;
    const g = ctx.createGain(); const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1.2, t + 0.05); g.gain.exponentialRampToValueAtTime(0.001, t + 3.5);
    src.connect(f).connect(g).connect(this.master); src.start(); src.stop(t + 4);
  }
  tone(freq, dur, type = 'sine', vol = 0.12, when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + when;
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur);
  }
  blip(f = 600) { this.tone(f, 0.12, 'triangle', 0.08); }
  chime() { this.tone(523, 0.4, 'sine', 0.1); this.tone(659, 0.4, 'sine', 0.1, 0.12); this.tone(784, 0.6, 'sine', 0.1, 0.24); }
  /** Bow slam: a short broadband crash of water over a low hull thump. */
  splash(e) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.playbackRate.value = 0.9 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 900 + Math.random() * 500; f.Q.value = 0.5;
    const g = ctx.createGain(), v = Math.min(0.5, 0.08 + e * 0.35);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5 + e * 0.6);
    src.connect(f).connect(g).connect(this.master); src.start(t, Math.random()); src.stop(t + 1.3);
    this.tone(55 + Math.random() * 15, 0.25, 'sine', Math.min(0.3, e * 0.25));
  }
  thud(v) { this.tone(70 + Math.random() * 30, 0.35, 'sine', Math.min(0.4, v * 0.06)); }
}
