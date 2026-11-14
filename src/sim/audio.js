// Minimal procedural sound: drivetrain rumble transmitted through the seat,
// plus UI chimes. Mars' thin air carries little sound — what the crew hears is
// mostly structure-borne vibration and the suit's own systems.

export class RoverAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx = ctx;
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02; // brown noise
        d[i] = last * 3.5;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      this.filter = ctx.createBiquadFilter();
      this.filter.type = 'lowpass';
      this.filter.frequency.value = 120;
      this.gain = ctx.createGain();
      this.gain.gain.value = 0;
      // suit fan hum
      const fan = ctx.createOscillator();
      fan.type = 'sine';
      fan.frequency.value = 96;
      const fanGain = ctx.createGain();
      fanGain.gain.value = 0.012;
      this.master = ctx.createGain();
      this.master.gain.value = 0.9;
      src.connect(this.filter).connect(this.gain).connect(this.master);
      fan.connect(fanGain).connect(this.master);
      this.master.connect(ctx.destination);
      src.start();
      fan.start();
    } catch (e) {
      console.warn('Audio unavailable', e);
      this.ctx = null;
    }
  }

  update(speed, roughness) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.min(1, speed / 4.5);
    this.gain.gain.setTargetAtTime(this.muted ? 0 : 0.05 + v * (0.35 + roughness * 0.6), t, 0.15);
    this.filter.frequency.setTargetAtTime(90 + v * 260 + roughness * 200, t, 0.2);
  }

  beep(kind = 'info') {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const notes = { info: [880], ok: [660, 990], warn: [520, 520], danger: [440, 330, 440] }[kind] || [880];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = kind === 'danger' ? 'square' : 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.13);
      g.gain.linearRampToValueAtTime(kind === 'danger' ? 0.05 : 0.08, t + i * 0.13 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.13 + 0.12);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.13);
      o.stop(t + i * 0.13 + 0.14);
    });
  }

  // Short single tone for instrument cues (pings, shutter, drill grind).
  tone(freq, duration = 0.05, level = 0.04, type = 'sine') {
    if (!this.ctx || this.muted) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + duration + 0.02);
  }

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  }
}
