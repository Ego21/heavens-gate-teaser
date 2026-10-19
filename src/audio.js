// Procedural score + sound design. Nothing is sampled; every sound is synthesised
// and scheduled against the trailer clock so audio and picture stay locked.

import { glitchAt, VANISH_T } from './shots.js';

const LULLABY = [ // original melody, A minor, [midi, beats]
  [76, 1], [69, 1], [72, 1], [71, 2], [69, 1], [64, 2],
  [65, 1], [64, 1], [68, 1], [71, 2], [69, 3],
  [76, 1], [74, 1], [72, 1], [71, 1], [69, 1], [68, 1], [64, 3],
  [65, 1], [64, 1], [63, 1], [64, 4],
];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

export class Score {
  constructor(ctx = new AudioContext()) {
    this.ctx = ctx;
    this.sources = new Set();
    this.master = ctx.createGain();
    this.master.gain.value = 0.75;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    // a fast limiter after the compressor catches the loud hits (reveal, scare, name boom) so the
    // exported file never hits digital full scale
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -2;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.08;
    this.master.connect(comp);
    comp.connect(limiter);
    limiter.connect(ctx.destination);
    if (ctx.createMediaStreamDestination) { // live playback only (used by the recorder)
      this.stream = ctx.createMediaStreamDestination();
      limiter.connect(this.stream);
    }

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(5.5, 2.4);
    const rvGain = ctx.createGain();
    rvGain.gain.value = 0.55;
    this.reverb.connect(rvGain).connect(this.master);

    this.noiseBuf = this.makeNoise('white', 4);
    this.brownBuf = this.makeNoise('brown', 6);
    this.pinkBuf = this.makeNoise('pink', 5);
    this.t0 = 0;
  }

  get time() {
    return this.ctx.currentTime - this.t0;
  }

  // --------------------------------------------------------------- buffers
  makeNoise(kind, seconds) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let last = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const w = Math.random() * 2 - 1;
        if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else if (kind === 'pink') { b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2 + w * 0.02) * 2.5; }
        else d[i] = w;
      }
    }
    return buf;
  }

  impulse(seconds, decay) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(2, n, this.ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, decay);
    }
    return buf;
  }

  // --------------------------------------------------------------- helpers
  track(src) {
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    return src;
  }

  noise(buf = this.noiseBuf, loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = loop;
    return this.track(s);
  }

  osc(type, freq) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    return this.track(o);
  }

  filter(type, freq, q = 0.7) {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  gain(v = 0) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  // keyframed gain [[t, v], ...] applied from trailer-time `from`
  automate(param, keys, from) {
    const now = this.ctx.currentTime;
    const at = (t) => this.t0 + t;
    let v0 = keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [ta, va] = keys[i], [tb, vb] = keys[i + 1];
      if (from >= ta && from < tb) v0 = va + (vb - va) * ((from - ta) / (tb - ta));
    }
    if (from >= keys[keys.length - 1][0]) v0 = keys[keys.length - 1][1];
    param.cancelScheduledValues(now);
    param.setValueAtTime(v0, now);
    for (const [t, v] of keys) if (t > from) param.linearRampToValueAtTime(v, at(t));
  }

  env(g, start, attack, peak, release, curve = 'exp') {
    const p = g.gain;
    p.setValueAtTime(0.0001, start);
    p.linearRampToValueAtTime(peak, start + attack);
    if (curve === 'exp') p.exponentialRampToValueAtTime(0.0001, start + attack + release);
    else p.linearRampToValueAtTime(0, start + attack + release);
  }

  // --------------------------------------------------------------- transport
  stopAll() {
    for (const s of this.sources) { try { s.stop(); } catch { /* not started */ } }
    this.sources.clear();
  }

  async start(from = 0) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    this.stopAll();
    this.t0 = this.ctx.currentTime - from;
    this.scheduleBeds(from);
    this.scheduleEvents(from);
  }

  // Render the whole score faster than real time into an AudioBuffer.
  static async renderOffline(duration, sampleRate = 48000) {
    const ctx = new OfflineAudioContext(2, Math.ceil(duration * sampleRate), sampleRate);
    const score = new Score(ctx);
    score.t0 = 0;
    score.scheduleBeds(0);
    score.scheduleEvents(0);
    return ctx.startRendering();
  }

  pause() { return this.ctx.suspend(); }
  resume() { return this.ctx.resume(); }

  // --------------------------------------------------------------- beds
  scheduleBeds(from) {
    const ctx = this.ctx;
    const off = (buf) => (from % buf.duration);

    // the sea: brown noise, slow swell
    const sea = this.noise(this.brownBuf);
    const seaLp = this.filter('lowpass', 520);
    const seaG = this.gain();
    const swell = this.osc('sine', 0.11);
    const swellG = this.gain(180);
    swell.connect(swellG).connect(seaLp.frequency);
    sea.connect(seaLp).connect(seaG).connect(this.master);
    this.automate(seaG.gain, [[0, 0], [2.5, 0.55], [40, 0.6], [42.6, 0.3], [45.6, 0.55], [47.19, 0.55], [47.2, 0], [55.8, 0], [57, 0.35], [61.9, 0.35], [62, 0], [65, 0]], from);
    sea.start(ctx.currentTime, off(this.brownBuf));
    swell.start();

    // wind
    const wind = this.noise(this.pinkBuf);
    const wBp = this.filter('bandpass', 500, 1.4);
    const wLfo = this.osc('sine', 0.07);
    const wLfoG = this.gain(260);
    wLfo.connect(wLfoG).connect(wBp.frequency);
    const wG = this.gain();
    wind.connect(wBp).connect(wG).connect(this.master);
    this.automate(wG.gain, [[0, 0], [5, 0.14], [32, 0.2], [40, 0.1], [47.19, 0.12], [47.2, 0], [48.5, 0.07], [55, 0], [57, 0.1], [61.9, 0.12], [62, 0], [65, 0]], from);
    wind.start(ctx.currentTime, off(this.pinkBuf));
    wLfo.start();

    // drone: detuned low saws through a dark filter
    const dG = this.gain();
    const dLp = this.filter('lowpass', 160, 2);
    dLp.connect(dG).connect(this.master);
    dG.connect(this.reverb);
    for (const [f, det] of [[41.2, -7], [41.2, 6], [61.7, 3], [49, -4]]) {
      const o = this.osc('sawtooth', f);
      o.detune.value = det;
      o.connect(dLp);
      o.start();
    }
    this.automate(dG.gain, [[0, 0], [8, 0.0], [20, 0.06], [32, 0.1], [34.8, 0.2], [40, 0.12], [42.6, 0.05], [45.2, 0.16], [47.19, 0.22], [47.2, 0], [48.3, 0.0], [49, 0.14], [54.6, 0.0], [57, 0.04], [61.6, 0.07], [62.4, 0.05], [67.59, 0.12], [67.6, 0], [69, 0], [69.4, 0.14], [73.5, 0.08], [74.5, 0]], from);
    this.automate(dLp.frequency, [[0, 120], [34.8, 160], [35.6, 700], [38, 220], [45.2, 300], [47.2, 900], [49, 200], [65, 200]], from);
  }

  // --------------------------------------------------------------- events
  scheduleEvents(from) {
    const ev = [];
    const at = (t, fn) => ev.push([t, fn]);

    // music box lullaby, slowing and sinking as she turns
    let bt = 12.4;
    for (const [m, beats] of LULLABY) {
      const t = bt;
      at(t, (w) => this.musicBox(w, mtof(m) * this.tapeFactor(t), beats * 0.58));
      bt += beats * 0.58 * (t > 29 ? 1 + (t - 29) * 0.35 : 1);
      if (bt > 32.2) break;
    }

    // oar strokes + water slaps around the boat
    for (let t = 12.3; t < 27; t += 2.6) at(t, (w) => this.oarStroke(w));
    for (let t = 12; t < 45; t += 1.37) at(t + Math.sin(t * 7) * 0.3, (w) => this.slap(w, t > 40 ? 0.12 : 0.07));

    // bell buoy
    for (const t of [8.6, 22.4, 55.6]) at(t, (w) => this.bell(w, t > 50 ? 0.3 : 0.18));

    // the reveal
    at(34.75, (w) => this.reveal(w));
    // the creature stutters, vanishes, and the screen breaks up with a buzzer
    for (let t = 36.62; t < VANISH_T; t += 0.004) if (glitchAt(t) > 0 && glitchAt(t - 0.004) === 0) at(t, (w) => this.crackle(w));
    at(VANISH_T, (w) => this.glitchBuzzer(w));
    // lantern sputters and dies
    for (let i = 0; i < 9; i++) at(40.1 + i * 0.27 + Math.sin(i * 5) * 0.06, (w) => this.crackle(w));
    at(42.6, (w) => this.fizzOut(w));
    // heartbeat in the dark
    let hb = 42.95;
    for (let i = 0; i < 4; i++) { const t = hb; at(t, (w) => this.heartbeat(w)); hb += 0.78 - i * 0.07; }
    // match strike, then it is right there
    at(45.62, (w) => this.strike(w));
    at(46.05, (w) => this.scare(w));
    // title
    at(48.3, (w) => this.boom(w, 0.9));
    // sting
    at(56.6, (w) => this.creak(w, 3.4));
    at(60.0, (w) => this.clank(w));
    // the smile: a slow, sinking reprise of the lullaby, a breath, then the name
    [[76, 63.6], [72, 64.6], [69, 65.7]].forEach(([m, t]) => at(t, (w) => this.musicBox(w, mtof(m) * Math.pow(2, -(t - 63.6) * 0.12), 1.6)));
    at(66.2, (w) => this.breath(w));
    at(69.0, (w) => this.boom(w, 1.0));

    const now = this.ctx.currentTime;
    for (const [t, fn] of ev) if (t >= from - 0.01) fn(now + (t - from));
  }

  tapeFactor(t) {
    return t < 29 ? 1 : Math.pow(2, -(t - 29) * 0.18);
  }

  // --------------------------------------------------------------- instruments
  musicBox(when, f, dur) {
    const out = this.gain();
    const lp = this.filter('lowpass', 3200);
    out.connect(lp);
    lp.connect(this.master);
    lp.connect(this.reverb);
    const parts = [[1, 0.16, 2.2], [2.76, 0.05, 0.9], [5.4, 0.025, 0.4], [8.93, 0.012, 0.2]];
    for (const [r, a, dec] of parts) {
      const o = this.osc('sine', f * r);
      const g = this.gain();
      o.detune.setValueAtTime(-6, when);
      o.detune.linearRampToValueAtTime(6, when + dur);
      this.env(g, when, 0.004, a, dec);
      o.connect(g).connect(out);
      o.start(when);
      o.stop(when + dec + 0.1);
    }
    out.gain.value = 1;
  }

  oarStroke(when) {
    // rowlock creak: resonant saw glide
    const o = this.osc('sawtooth', 190);
    o.frequency.setValueAtTime(190, when);
    o.frequency.linearRampToValueAtTime(260, when + 0.35);
    const bp = this.filter('bandpass', 900, 9);
    const g = this.gain();
    this.env(g, when, 0.05, 0.035, 0.45, 'lin');
    o.connect(bp).connect(g).connect(this.master);
    o.start(when);
    o.stop(when + 0.6);
    // the blade entering water
    const n = this.noise(this.noiseBuf, false);
    const hp = this.filter('bandpass', 1400, 0.8);
    const ng = this.gain();
    this.env(ng, when + 0.55, 0.03, 0.09, 0.7);
    n.connect(hp).connect(ng).connect(this.master);
    n.start(when + 0.55, Math.random() * 3);
    n.stop(when + 1.4);
  }

  slap(when, amp) {
    const n = this.noise(this.noiseBuf, false);
    const lp = this.filter('lowpass', 700 + Math.random() * 400, 1.5);
    const g = this.gain();
    this.env(g, when, 0.02, amp, 0.35);
    n.connect(lp).connect(g).connect(this.master);
    n.start(when, Math.random() * 3);
    n.stop(when + 0.5);
  }

  bell(when, amp) {
    const f = 410;
    const out = this.gain(1);
    const lp = this.filter('lowpass', 2400);
    out.connect(lp);
    lp.connect(this.master);
    lp.connect(this.reverb);
    for (const [r, a, d] of [[1, 1, 6], [2.76, 0.5, 3.5], [5.4, 0.25, 2], [8.93, 0.12, 1], [0.5, 0.3, 7]]) {
      const o = this.osc('sine', f * r);
      const g = this.gain();
      this.env(g, when, 0.005, amp * a, d);
      o.connect(g).connect(out);
      o.start(when);
      o.stop(when + d + 0.2);
    }
  }

  reveal(when) {
    // brass-like cluster swelling open, plus sub pressure
    const lp = this.filter('lowpass', 150, 1.2);
    lp.frequency.setValueAtTime(150, when);
    lp.frequency.exponentialRampToValueAtTime(1400, when + 1.2);
    lp.frequency.exponentialRampToValueAtTime(200, when + 5);
    const g = this.gain();
    this.env(g, when, 0.6, 0.3, 4.5);
    lp.connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    for (const f of [55, 58.3, 82.4, 87.3, 110]) {
      const o = this.osc('sawtooth', f);
      o.connect(lp);
      o.start(when);
      o.stop(when + 5.5);
    }
    this.sub(when, 38, 0.6, 3.5);
  }

  sub(when, f, amp, dur) {
    const o = this.osc('sine', f * 1.6);
    o.frequency.setValueAtTime(f * 1.6, when);
    o.frequency.exponentialRampToValueAtTime(f, when + 0.4);
    const g = this.gain();
    this.env(g, when, 0.01, amp, dur);
    o.connect(g).connect(this.master);
    o.start(when);
    o.stop(when + dur + 0.1);
  }

  // Buzzer + static that follow glitchAt() step for step, so the sound cuts in and out exactly
  // when the picture tears. A square-wave stack through hard clipping, a burst of noise, a
  // power-down thump and a falling whine.
  glitchBuzzer(when) {
    const DUR = 0.85, STEP = 0.01;
    const clip = this.ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 7); }
    clip.curve = curve;
    const tone = this.gain();
    const hiss = this.gain();
    for (let k = 0; k <= DUR / STEP; k++) {
      const g = glitchAt(VANISH_T + k * STEP);
      tone.gain.setValueAtTime(0.0001 + 0.2 * g, when + k * STEP);
      hiss.gain.setValueAtTime(0.0001 + 0.13 * g, when + k * STEP);
    }
    for (const [f, d] of [[100, 0], [107, 9], [200, -6], [333, 4]]) {
      const o = this.osc('square', f);
      o.detune.value = d;
      o.frequency.setValueAtTime(f, when);
      o.frequency.exponentialRampToValueAtTime(f * 0.6, when + DUR);
      o.connect(clip);
      o.start(when);
      o.stop(when + DUR + 0.05);
    }
    const band = this.filter('bandpass', 900, 0.8);
    clip.connect(band).connect(tone);
    tone.connect(this.master);
    tone.connect(this.reverb);
    // static
    const n = this.noise(this.noiseBuf, true);
    const hp = this.filter('highpass', 1800);
    n.connect(hp).connect(hiss).connect(this.master);
    n.start(when, Math.random() * 2);
    n.stop(when + DUR + 0.05);
    // power-down thump and a falling whine
    this.sub(when, 48, 0.5, 1.1);
    const w = this.osc('sawtooth', 1400);
    w.frequency.setValueAtTime(1400, when);
    w.frequency.exponentialRampToValueAtTime(70, when + 0.6);
    const wg = this.gain();
    this.env(wg, when, 0.005, 0.07, 0.6);
    const wl = this.filter('lowpass', 2600);
    w.connect(wl).connect(wg).connect(this.master);
    w.start(when);
    w.stop(when + 0.7);
  }

  crackle(when) {
    const n = this.noise(this.noiseBuf, false);
    const bp = this.filter('bandpass', 2500 + Math.random() * 2500, 2);
    const g = this.gain();
    this.env(g, when, 0.002, 0.12, 0.05);
    n.connect(bp).connect(g).connect(this.master);
    n.start(when, Math.random() * 3);
    n.stop(when + 0.1);
  }

  fizzOut(when) {
    const n = this.noise(this.noiseBuf, false);
    const lp = this.filter('lowpass', 3000, 1);
    lp.frequency.setValueAtTime(3000, when);
    lp.frequency.exponentialRampToValueAtTime(200, when + 0.6);
    const g = this.gain();
    this.env(g, when, 0.01, 0.1, 0.6);
    n.connect(lp).connect(g).connect(this.master);
    n.start(when, Math.random() * 3);
    n.stop(when + 0.8);
  }

  heartbeat(when) {
    for (const [dt, a] of [[0, 0.7], [0.17, 0.45]]) {
      const o = this.osc('sine', 70);
      o.frequency.setValueAtTime(70, when + dt);
      o.frequency.exponentialRampToValueAtTime(38, when + dt + 0.12);
      const g = this.gain();
      this.env(g, when + dt, 0.008, a, 0.22);
      o.connect(g).connect(this.master);
      o.start(when + dt);
      o.stop(when + dt + 0.35);
    }
  }

  strike(when) {
    const n = this.noise(this.noiseBuf, false);
    const bp = this.filter('bandpass', 3200, 1.5);
    const g = this.gain();
    this.env(g, when, 0.005, 0.25, 0.18);
    n.connect(bp).connect(g).connect(this.master);
    n.start(when, Math.random() * 3);
    n.stop(when + 0.3);
    const roar = this.noise(this.noiseBuf, false);
    const lp = this.filter('lowpass', 900);
    const rg = this.gain();
    this.env(rg, when + 0.04, 0.05, 0.08, 0.5);
    roar.connect(lp).connect(rg).connect(this.master);
    roar.start(when + 0.04, Math.random() * 3);
    roar.stop(when + 0.7);
  }

  scare(when) {
    // impact
    const n = this.noise(this.noiseBuf, false);
    const lp = this.filter('lowpass', 5000);
    lp.frequency.setValueAtTime(6000, when);
    lp.frequency.exponentialRampToValueAtTime(300, when + 1.0);
    const g = this.gain();
    this.env(g, when, 0.004, 0.75, 1.1);
    n.connect(lp).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    n.start(when, Math.random() * 2);
    n.stop(when + 1.3);
    this.sub(when, 32, 1.0, 1.8);
    // shriek: detuned saws through a sweeping, distorted band
    const shaper = this.ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 6); }
    shaper.curve = curve;
    const bp = this.filter('bandpass', 1800, 6);
    bp.frequency.setValueAtTime(1500, when);
    bp.frequency.exponentialRampToValueAtTime(4200, when + 0.9);
    const sg = this.gain();
    this.env(sg, when, 0.03, 0.22, 1.05, 'lin');
    for (const f of [620, 655, 931]) {
      const o = this.osc('sawtooth', f);
      o.frequency.setValueAtTime(f, when);
      o.frequency.exponentialRampToValueAtTime(f * 1.5, when + 1.1);
      o.connect(shaper);
      o.start(when);
      o.stop(when + 1.15);
    }
    shaper.connect(bp).connect(sg);
    sg.connect(this.master);
    sg.connect(this.reverb);
  }

  boom(when, amp) {
    this.sub(when, 30, amp, 4);
    const n = this.noise(this.brownBuf, false);
    const lp = this.filter('lowpass', 400);
    const g = this.gain();
    this.env(g, when, 0.01, amp * 0.8, 3.5);
    n.connect(lp).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    n.start(when);
    n.stop(when + 4);
  }

  creak(when, dur) {
    const o = this.osc('sawtooth', 70);
    const vib = this.osc('sine', 7);
    const vibG = this.gain(18);
    vib.connect(vibG).connect(o.frequency);
    o.frequency.setValueAtTime(65, when);
    o.frequency.linearRampToValueAtTime(110, when + dur * 0.5);
    o.frequency.linearRampToValueAtTime(80, when + dur);
    const bp = this.filter('bandpass', 700, 12);
    bp.frequency.setValueAtTime(500, when);
    bp.frequency.linearRampToValueAtTime(1100, when + dur);
    const g = this.gain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.16, when + 0.4);
    g.gain.linearRampToValueAtTime(0.1, when + dur * 0.7);
    g.gain.linearRampToValueAtTime(0.0, when + dur);
    o.connect(bp).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    o.start(when); vib.start(when);
    o.stop(when + dur + 0.1); vib.stop(when + dur + 0.1);
  }

  clank(when) {
    const out = this.gain(1);
    out.connect(this.master);
    out.connect(this.reverb);
    for (const [f, a, d] of [[180, 0.4, 1.4], [497, 0.25, 0.9], [1130, 0.12, 0.5], [2311, 0.06, 0.3], [63, 0.5, 1.0]]) {
      const o = this.osc('triangle', f);
      const g = this.gain();
      this.env(g, when, 0.002, a, d);
      o.connect(g).connect(out);
      o.start(when);
      o.stop(when + d + 0.1);
    }
    this.slap(when, 0.3);
  }

  breath(when) {
    // a long, wet exhale very close
    const n = this.noise(this.pinkBuf, false);
    const bp = this.filter('bandpass', 600, 1.2);
    bp.frequency.setValueAtTime(900, when);
    bp.frequency.linearRampToValueAtTime(350, when + 1.1);
    const g = this.gain();
    g.gain.setValueAtTime(0.0001, when);
    g.gain.linearRampToValueAtTime(0.35, when + 0.25);
    g.gain.linearRampToValueAtTime(0.0, when + 1.1);
    n.connect(bp).connect(g).connect(this.master);
    n.start(when);
    n.stop(when + 1.3);
  }
}
