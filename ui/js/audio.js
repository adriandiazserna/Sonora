// Motor de audio: dos decks (A/B) con crossfader de potencia constante, EQ paramétrico de 10 bandas,
// ReplayGain, limitador opcional y analizador para el visualizador.
// Cadena: <audio> → fuente → RG → EQ deck (3 bandas DJ) → vol deck → crossfader → preamp → EQ 10 bandas → limitador → volumen → salida

export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

class Deck {
  constructor(eng, idx) {
    this.idx = idx;
    const c = eng.ctx;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.preservesPitch = true;
    this.src = c.createMediaElementSource(this.el);
    this.rg = c.createGain();
    this.low = c.createBiquadFilter(); this.low.type = 'lowshelf'; this.low.frequency.value = 220;
    this.mid = c.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = 0.7;
    this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 4200;
    this.vol = c.createGain();
    this.x = c.createGain();
    this.src.connect(this.rg).connect(this.low).connect(this.mid).connect(this.high).connect(this.vol).connect(this.x).connect(eng.preamp);
    this.track = null; this.url = null;
  }
  load(track, url) {
    this.track = track; this.url = url;
    this.el.src = url;
    this.el.load();
  }
  unload() { this.el.pause(); this.el.removeAttribute('src'); this.el.load(); this.track = null; this.url = null; }
  setRG(db) { this.rg.gain.value = Math.pow(10, (db || 0) / 20); }
  get playing() { return !this.el.paused && !this.el.ended; }
}

export class Engine extends EventTarget {
  constructor({ sampleRate = 0 } = {}) {
    super();
    const opts = { latencyHint: 'playback' };
    if (sampleRate) opts.sampleRate = sampleRate;
    try { this.ctx = new AudioContext(opts); } catch { this.ctx = new AudioContext({ latencyHint: 'playback' }); }
    const c = this.ctx;
    this.preamp = c.createGain();
    this.eq = BANDS.map((f, i) => {
      const b = c.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f; b.Q.value = 1.05; b.gain.value = 0;
      return b;
    });
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -1; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.2;
    this.master = c.createGain();
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 4096; this.analyser.smoothingTimeConstant = 0.78;
    this.eqOn = true; this.limOn = true;
    this.decks = [new Deck(this, 0), new Deck(this, 1)];
    this.active = 0;
    this.x = 0; // crossfader: 0 = deck A, 1 = deck B
    this.applyX(0, 0);
    this.route();
    this.decks.forEach((d) => this.bind(d));
    this.fading = false;
  }

  route() {
    const c = this.ctx;
    [this.preamp, ...this.eq, this.limiter, this.master].forEach((n) => { try { n.disconnect(); } catch { } });
    let n = this.preamp;
    if (this.eqOn) for (const b of this.eq) { n.connect(b); n = b; }
    if (this.limOn) { n.connect(this.limiter); n = this.limiter; }
    n.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(c.destination);
  }

  bind(d) {
    const el = d.el;
    const isActive = () => this.decks[this.active] === d;
    el.addEventListener('timeupdate', () => { if (isActive()) this.emit('time', { t: el.currentTime, d: el.duration || d.track?.duration || 0 }); });
    el.addEventListener('progress', () => { if (isActive() && el.buffered.length && el.duration) this.emit('buffer', el.buffered.end(el.buffered.length - 1) / el.duration); });
    el.addEventListener('ended', () => { if (isActive()) this.emit('ended', d); else if (d.track) this.emit('deckended', d); });
    el.addEventListener('play', () => this.emit('state'));
    el.addEventListener('pause', () => this.emit('state'));
    el.addEventListener('error', () => { if (d.url) this.emit('error', { deck: d, code: el.error?.code }); });
    el.addEventListener('loadedmetadata', () => { if (isActive()) this.emit('time', { t: el.currentTime, d: el.duration }); });
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  get cur() { return this.decks[this.active]; }
  get other() { return this.decks[1 - this.active]; }
  get playing() { return this.cur.playing; }
  get time() { return this.cur.el.currentTime || 0; }
  get duration() { return this.cur.el.duration || this.cur.track?.duration || 0; }

  /** Aplica la posición del crossfader con curva de potencia constante (sin bajón de volumen a mitad) */
  applyX(target, secs, curve = 'smooth') {
    const now = this.ctx.currentTime;
    const from = this.x;
    const g = (x, deck) => {
      if (curve === 'cut') { // curva DJ "scratch": corte rápido
        const v = deck === 0 ? Math.min(1, (1 - x) * 4) : Math.min(1, x * 4);
        return v;
      }
      return deck === 0 ? Math.cos(x * Math.PI / 2) : Math.sin(x * Math.PI / 2);
    };
    for (const d of this.decks) {
      const p = d.x.gain;
      p.cancelScheduledValues(now);
      if (secs > 0.02) {
        const n = 48, arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = g(from + (target - from) * (i / (n - 1)), d.idx);
        try { p.setValueCurveAtTime(arr, now, secs); } catch { p.value = g(target, d.idx); }
      } else p.value = g(target, d.idx);
    }
    this.x = target;
    this.curve = curve;
  }

  async resume() { if (this.ctx.state !== 'running') await this.ctx.resume(); }

  /** Reproduce una pista. Con fade > 0 mezcla desde el deck actual; si la pista ya está precargada en el otro deck, cambia sin hueco. */
  async play(track, url, { fade = 0, rg = 0, at = 0 } = {}) {
    await this.resume();
    clearTimeout(this.stopT);
    const cur = this.cur, oth = this.other;
    const preloaded = oth.url === url;
    if (fade > 0 && cur.playing) {
      if (!preloaded) oth.load(track, url);
      oth.track = track; oth.setRG(rg);
      if (at) oth.el.currentTime = at;
      await oth.el.play().catch(() => { });
      this.active = oth.idx;
      this.fading = true;
      this.applyX(oth.idx, fade);
      this.stopT = setTimeout(() => { this.fading = false; if (this.cur !== cur) { cur.el.pause(); } this.emit('fadedone'); }, fade * 1000 + 120);
      return;
    }
    // Sin mezcla
    let d = cur;
    if (preloaded) { d = oth; cur.el.pause(); }
    else { oth.el.pause(); if (d.url !== url) d.load(track, url); else if (d.el.ended) d.el.currentTime = 0; }
    d.track = track; d.setRG(rg);
    this.active = d.idx;
    this.fading = false;
    this.applyX(d.idx, 0);
    if (at) d.el.currentTime = at;
    await d.el.play().catch((e) => this.emit('error', { deck: d, msg: e.message }));
  }

  /** Precarga la siguiente pista en el deck libre (reproducción casi sin pausas) */
  preload(track, url) {
    const o = this.other;
    if (o.url === url || o.playing) return;
    o.load(track, url); o.track = track;
  }

  toggle() { this.cur.playing ? this.pause() : this.resumePlay(); }
  pause() { this.decks.forEach((d) => d.el.pause()); this.fading = false; clearTimeout(this.stopT); this.applyX(this.active, 0); }
  async resumePlay() { await this.resume(); if (this.cur.url) await this.cur.el.play().catch(() => { }); }
  seek(t) { const el = this.cur.el; if (isFinite(t)) el.currentTime = Math.max(0, Math.min(t, (el.duration || t) - 0.25)); }
  stop() { this.decks.forEach((d) => d.unload()); this.emit('state'); }

  setVolume(v) { this.master.gain.setTargetAtTime(v * v, this.ctx.currentTime, 0.03); } // curva perceptual
  setPreamp(db) { this.preamp.gain.setTargetAtTime(Math.pow(10, db / 20), this.ctx.currentTime, 0.03); }
  setBand(i, db) { this.eq[i].gain.setTargetAtTime(db, this.ctx.currentTime, 0.02); }
  setEQ(gains) { gains.forEach((g, i) => this.setBand(i, g)); }
  setEqEnabled(on) { if (on !== this.eqOn) { this.eqOn = on; this.route(); } }
  setLimiter(on) { if (on !== this.limOn) { this.limOn = on; this.route(); } }

  /** Respuesta en frecuencia combinada del EQ (para dibujar la curva) */
  response(freqs) {
    const mag = new Float32Array(freqs.length).fill(1), m = new Float32Array(freqs.length), ph = new Float32Array(freqs.length);
    for (const b of this.eq) { b.getFrequencyResponse(freqs, m, ph); for (let i = 0; i < m.length; i++) mag[i] *= m[i]; }
    return mag;
  }

  // ---- Controles DJ por deck ----
  setDeckEQ(idx, band, db) { const d = this.decks[idx]; d[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.015); }
  setDeckVol(idx, v) { this.decks[idx].vol.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
  setTempo(idx, rate, keylock = true) { const el = this.decks[idx].el; el.preservesPitch = keylock; el.playbackRate = rate; }

  /** Datos de espectro para el visualizador */
  spectrum(arr) { this.analyser.getByteFrequencyData(arr); return arr; }
}
