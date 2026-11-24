// ======================================================================
// Auto DJ: elige la siguiente canción (BPM, tonalidad, energía, tus gustos)
// y mezcla como un DJ real: tempo igualado, tiempos y compases alineados,
// corrección fina continua (como "empujar el plato"), bass swap y salida suave.
// ======================================================================
import * as Brain from './brain.js';
import { norm } from './util.js';

const MIN_CONF = 0.35;      // por debajo, no se intenta sincronizar
const MAX_STRETCH = 0.085;  // máximo cambio de tempo para igualar (±8.5 %)

// ---------------------------------------------------------------------
// Pedido en texto: "DJ reggaetón", "fiesta 100 bpm", "algo tranqui de rock"
// ---------------------------------------------------------------------
const STOP = new Set('dj mix mezcla mezclame mezcla modo de del la el los las lo un una unos pon ponme pone quiero musica canciones cancion y con para algo me mas que sesion set puro pura solo'.split(' '));
const HIGH = ['fiesta', 'party', 'prender', 'prendido', 'duro', 'hype', 'bailar', 'antro', 'energia', 'energetico', 'perreo', 'jangueo'];
const LOW = ['chill', 'tranqui', 'tranquilo', 'tranquila', 'relajado', 'relax', 'suave', 'lento', 'calma', 'estudiar', 'dormir'];
const SYN = {
  reggaeton: ['reggaeton', 'dembow', 'perreo', 'urbano latino', 'latin urban'], regueton: ['reggaeton', 'dembow'], perreo: ['reggaeton', 'dembow', 'perreo'],
  urbano: ['urbano', 'reggaeton', 'trap latino', 'latin trap'], trap: ['trap'], rap: ['rap', 'hip-hop', 'hip hop'], hiphop: ['hip-hop', 'hip hop', 'rap'],
  electronica: ['electronica', 'electronic', 'house', 'techno', 'edm', 'trance', 'dance'], edm: ['edm', 'electronic', 'house', 'dance'],
  rock: ['rock'], indie: ['indie', 'alternative'], pop: ['pop'], latina: ['latin', 'salsa', 'cumbia', 'bachata', 'merengue'], latino: ['latin', 'salsa', 'cumbia', 'bachata'],
  salsa: ['salsa'], cumbia: ['cumbia'], bachata: ['bachata'], rnb: ['r&b', 'rnb', 'soul'], soul: ['soul', 'r&b'], jazz: ['jazz'], house: ['house'],
};

export function parseRequest(q, tracks) {
  const words = norm(q).replace(/[^\w\s&-]/g, ' ').split(/\s+/).filter(Boolean);
  let energy = 'auto', bpm = null;
  const terms = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === 'hip' && words[i + 1] === 'hop') { terms.push('hiphop'); i++; continue; }
    if (STOP.has(w)) continue;
    if (HIGH.includes(w)) { energy = 'high'; if (!SYN[w]) continue; }
    if (LOW.includes(w)) { energy = 'low'; continue; }
    if (/^\d{2,3}$/.test(w) && +w >= 60 && +w <= 200) { bpm = +w; continue; }
    if (w === 'bpm') continue;
    terms.push(w);
  }
  let pool = tracks.filter((t) => t.playable);
  if (terms.length) {
    const want = terms.flatMap((w) => SYN[w] || [w]);
    pool = pool.filter((t) => {
      const hay = norm([t.mainGenre, t.subGenre, t.genre, (t.genreTags || []).join(' '), t.artist, t.albumArtist].join(' | '));
      return want.some((x) => hay.includes(x));
    });
  }
  const label = terms.length ? terms.map((w) => w[0].toUpperCase() + w.slice(1)).join(' + ') : 'Tu música';
  return { pool, energy, bpm, terms, label };
}

// ---------------------------------------------------------------------
// Compatibilidad
// ---------------------------------------------------------------------
export function keyCompat(a, b) {
  if (!a || !b) return 0.5;
  const n1 = parseInt(a), n2 = parseInt(b), l1 = a.slice(-1), l2 = b.slice(-1);
  const d = Math.min((n1 - n2 + 12) % 12, (n2 - n1 + 12) % 12);
  if (d === 0 && l1 === l2) return 1;      // misma tonalidad
  if (d === 0) return 0.85;                // relativa mayor/menor
  if (d === 1 && l1 === l2) return 0.9;    // vecina en la rueda Camelot
  if (d === 2 && l1 === l2) return 0.4;    // salto de energía
  return 0;
}

/** Relación de tempo para que B suene al BPM de A (considera medio/doble tiempo). */
export function tempoMatch(bpmA, bpmB) {
  if (!bpmA || !bpmB) return null;
  const m = 2 ** Math.round(Math.log2(bpmB / bpmA)); // 0.5, 1, 2…
  const rate = (bpmA * m) / bpmB;                    // velocidad a aplicar en B
  return { m, rate, dev: Math.abs(1 - rate) };
}

const ok = (t) => t?.dj && t.dj.conf >= MIN_CONF && t.dj.period > 0;

/** Curva de energía de la sesión: arranca medio, sube, respira y vuelve a subir. */
function energyTarget(step, mode) {
  const base = mode === 'high' ? 0.72 : mode === 'low' ? 0.28 : 0.5;
  const ramp = Math.min(1, step / 8) * (mode === 'low' ? 0.05 : 0.2);
  const wave = Math.sin(step / 2.6) * 0.08;
  return Math.max(0, Math.min(1, base + ramp + wave));
}

/** Puntuación de una candidata como siguiente canción. */
export function scoreNext(cur, t, ctx) {
  let s = 0;
  const why = [];
  if (ok(cur) && ok(t)) {
    const bA = 60 / cur.dj.period;
    const tm = tempoMatch(bA, t.dj.bpm);
    if (tm.dev <= 0.06) { s += 3.2 * (1 - tm.dev / 0.06); why.push('tempo'); }
    else if (tm.dev <= MAX_STRETCH) s += 0.4;
    else s -= 2.5 + tm.dev * 10;
  } else if (!t.dj) s -= 1.2; // aún sin analizar
  const kc = keyCompat(cur?.dj?.camelot, t.dj?.camelot);
  s += 1.6 * kc;
  if (kc >= 0.85) why.push('tono');
  if (t.djE != null) s += 1.3 * (1 - Math.min(1, Math.abs(t.djE - energyTarget(ctx.step, ctx.energy)) * 3));
  if (ctx.bpm && t.dj?.bpm) { const tm = tempoMatch(ctx.bpm, t.dj.bpm); s -= tm.dev * 18; }
  s += Brain.taste(t) * 0.9;
  if (cur) s += Brain.similarity(cur, t) * 0.3;
  const art = t.albumArtist || t.artist;
  if (ctx.recentArtists.slice(-3).includes(art)) s -= 2.5;
  s += Math.random() * 0.6;
  return { s, why };
}

export function pickNext(cur, ctx) {
  let cands = ctx.pool.filter((t) => !ctx.played.has(t.id) && t.id !== cur?.id);
  if (cands.length === 0) { // ya sonó todo: se permiten repeticiones antiguas
    const keep = new Set([...ctx.played].slice(-Math.min(10, Math.floor(ctx.pool.length / 2))));
    ctx.played = keep;
    cands = ctx.pool.filter((t) => !keep.has(t.id) && t.id !== cur?.id);
  }
  let best = null, bs = -Infinity;
  for (const t of cands) { const { s } = scoreNext(cur, t, ctx); if (s > bs) { bs = s; best = t; } }
  return best;
}

export function pickFirst(ctx) {
  const target = energyTarget(0, ctx.energy);
  let best = null, bs = -Infinity;
  for (const t of ctx.pool) {
    let s = Brain.taste(t) + Math.random() * 0.8 + (ok(t) ? 1 : 0);
    if (t.djE != null) s += 1 - Math.abs(t.djE - target) * 3;
    if (ctx.bpm && t.dj?.bpm) s -= tempoMatch(ctx.bpm, t.dj.bpm).dev * 18;
    if (s > bs) { bs = s; best = t; }
  }
  return best;
}

/** Energía 0..1 por rango dentro de la biblioteca (sonoridad + densidad de ataques). */
export function rankEnergy(tracks) {
  const a = tracks.filter((t) => t.dj && t.dj.period > 0);
  if (a.length < 3) return;
  const rank = (key) => { const s = a.slice().sort((x, y) => x.dj[key] - y.dj[key]); const r = new Map(); s.forEach((t, i) => r.set(t.id, i / (s.length - 1))); return r; };
  const re = rank('energy'), rl = rank('loud');
  for (const t of a) t.djE = 0.6 * re.get(t.id) + 0.4 * rl.get(t.id);
}

// ---------------------------------------------------------------------
// Motor de mezcla
// ---------------------------------------------------------------------
export class AutoDJ {
  constructor(engine, hooks) {
    this.e = engine;
    this.h = hooks; // { url(t), rg(t), adopt(track), status() }
    this.on = false;
    this.state = 'idle'; // idle | preroll | mixing
    this.p = null; this.next = null; this.fast = null; this.glide = null;
  }

  get busy() { return this.state !== 'idle'; }

  start(session) {
    this.ctx = session;
    this.on = true;
    this.state = 'idle';
    this.p = null;
  }

  stop() { this.abort(); this.on = false; this.next = null; }

  /** La canción actual cambió (nueva o adoptada tras una mezcla). */
  trackStarted(t) {
    if (!this.on) return;
    const c = this.ctx;
    c.played.add(t.id); c.step++;
    c.recentArtists.push(t.albumArtist || t.artist);
    this.p = null; this.force = false;
    this.next = pickNext(t, c);
  }

  /** Llegaron nuevos análisis: re-planifica y, si conviene, elige mejor siguiente. */
  refresh() {
    if (!this.on || this.busy) return;
    const cur = this.e.cur.track;
    const a = this.e.cur.el.currentTime, d = this.e.cur.el.duration || cur?.duration || 0;
    if (cur && d - a > 25) {
      const cand = pickNext(cur, this.ctx);
      if (cand && cand !== this.next && (!ok(this.next) || scoreNext(cur, cand, this.ctx).s > scoreNext(cur, this.next, this.ctx).s + 1)) this.next = cand;
    }
    this.p = null;
  }

  reroll() { if (this.busy || !this.on) return; const cur = this.e.cur.track; if (this.next) this.ctx.played.add(this.next.id); this.next = pickNext(cur, this.ctx); this.p = null; }

  /** Mezclar ya: transición corta de 8 tiempos en el siguiente compás. */
  mixNow() { if (!this.on || this.busy) return false; this.force = true; this.p = null; this.tick(); this.startFast(); return true; }

  plan() {
    const A = this.e.cur, ta = A.track, tb = this.next;
    if (!ta || !tb) return null;
    const da = ta.dj, db = tb.dj;
    const durA = A.el.duration || ta.duration;
    const a = A.el.currentTime;
    const rA = A.el.playbackRate || 1;
    if (ok(ta) && ok(tb)) {
      const pA = da.period;
      const tm = tempoMatch(60 / pA * rA, 60 / db.period);
      if (tm.dev <= MAX_STRETCH) {
        let L = this.ctx.beats;
        const bar = 4 * pA;
        const endA = Math.min(da.end || durA, durA) - 0.25;
        let mixA = da.grid + Math.floor((endA - L * pA - da.grid) / bar) * bar;
        // No cortar demasiado pronto: al menos el 55 % de la canción
        while (mixA < durA * 0.55 && L > 8) { L /= 2; mixA = da.grid + Math.floor((endA - L * pA - da.grid) / bar) * bar; }
        if (this.force || mixA < a + 2.5 * rA) {
          L = Math.min(L, 8);
          mixA = da.grid + Math.ceil((a + 2.5 * rA - da.grid) / bar) * bar;
          if (mixA + L * pA > durA) return this.fadePlan(A, ta, tb, true);
        }
        // Entrada de B: primer tiempo 1 donde empieza su música
        const pB = db.period * tm.m;           // tiempo "plegado" de B (medio/doble tiempo)
        const barB = 4 * pB;
        let inB = db.grid + Math.ceil(((db.start || 0) - 0.05 - db.grid) / barB) * barB;
        if (inB < 0) inB += barB;
        const rB = tm.rate;
        const startB = Math.max(a + 0.05, mixA - 4 * pA, mixA - (inB * rA) / rB);
        return { type: 'sync', mixA, L, pA, rA, rB, inB, startB, endMix: mixA + L * pA, dev: tm.dev };
      }
    }
    return this.fadePlan(A, ta, tb, this.force);
  }

  fadePlan(A, ta, tb, now) {
    const durA = A.el.duration || ta.duration;
    const rA = A.el.playbackRate || 1;
    const F = Math.min(8, durA / 6);
    const endA = Math.min(ta.dj?.end || durA, durA) - 0.2;
    const a = A.el.currentTime;
    const mixA = now ? a + 0.4 : Math.max(a + 0.4, endA - F * rA);
    return { type: 'fade', mixA, startB: mixA, inB: Math.max(0, (tb.dj?.start || 0) - 0.2), F, rA, endMix: mixA + F * rA };
  }

  /** Llamado ~4 veces por segundo con la reproducción normal. */
  tick() {
    if (!this.on || !this.next || this.e.fading) return;
    const A = this.e.cur;
    if (!A.track || A.el.paused) return;
    const a = A.el.currentTime;
    if (this.state === 'idle') {
      if (!this.p) this.p = this.plan();
      const p = this.p;
      if (!p) return;
      // Precarga de B ~12 s antes
      const B = this.e.other, url = this.h.url(this.next);
      if (a >= p.startB - 12 && B.url !== url && !B.playing) { B.load(this.next, url); B.track = this.next; }
      if (a >= p.startB - 3) { this.p = this.plan(); this.startFast(); }
    }
  }

  startFast() {
    if (this.fast) return;
    this.fast = setInterval(() => this.step(), 30);
  }
  stopFast() { clearInterval(this.fast); this.fast = null; }

  /** Bucle fino (30 ms) solo durante la preparación y la mezcla. */
  step() {
    const A = this.e.cur, B = this.e.other;
    if (!this.on || A.el.paused) { if (this.busy) this.abort(); else this.stopFast(); return; }
    const a = A.el.currentTime;
    if (this.state === 'idle') {
      if (!this.p) this.p = this.plan();
      const p = this.p;
      if (!p) { this.stopFast(); return; }
      if (a >= p.startB - 0.02) this.preroll();
      return;
    }
    const p = this.p;
    if (p.type === 'sync') this.pll(a);
    if (this.state === 'preroll' && a >= p.mixA - 0.012) this.beginMix(a);
    if (this.state === 'mixing' && a >= p.endMix) this.finish();
  }

  async preroll() {
    const A = this.e.cur, B = this.e.other, p = this.p, t = this.next;
    const url = this.h.url(t);
    if (B.url !== url) { B.load(t, url); }
    B.track = t;
    B.setRG(this.h.rg(t));
    const now = this.e.ctx.currentTime;
    for (const prm of [B.x.gain, B.low.gain, B.mid.gain, B.high.gain, B.vol.gain]) prm.cancelScheduledValues(now);
    B.x.gain.value = 0; B.vol.gain.value = 1; B.mid.gain.value = 0; B.high.gain.value = 0;
    B.low.gain.value = p.type === 'sync' ? -26 : 0;
    B.el.preservesPitch = true;
    B.el.playbackRate = p.type === 'sync' ? p.rB : 1;
    const a = A.el.currentTime;
    B.el.currentTime = p.type === 'sync' ? Math.max(0, p.inB + (a - p.mixA) * (p.rB / p.rA)) : p.inB;
    this.state = 'preroll';
    this.errF = null;
    this.lastSeek = performance.now();
    try { await B.el.play(); } catch { this.abort(); }
  }

  /** Lazo de fase: mantiene a B pegado a la rejilla de A ajustando su velocidad (inaudible). */
  pll(a) {
    const p = this.p, B = this.e.other;
    if (B.el.paused || B.el.readyState < 3) return;
    const want = p.inB + (a - p.mixA) * (p.rB / p.rA);
    const err = B.el.currentTime - want; // + = B adelantado
    if (this.state === 'preroll' && Math.abs(err) > 0.07 && performance.now() - this.lastSeek > 350) {
      B.el.currentTime = want + 0.02; // aún en silencio: corrección directa
      this.lastSeek = performance.now();
      return;
    }
    // Filtro suave del error (la lectura de currentTime tiene unos ms de ruido)
    this.errF = this.errF == null ? err : this.errF * 0.6 + err * 0.4;
    const e = this.errF;
    const adj = Math.max(-0.03, Math.min(0.03, -e * 1.1));
    const rate = Math.abs(e) < 0.006 ? p.rB : p.rB * (1 + adj); // zona muerta: ±6 ms es imperceptible
    if (Math.abs(B.el.playbackRate - rate) > 0.002) B.el.playbackRate = rate;
    this.err = e;
  }

  beginMix(a) {
    const A = this.e.cur, B = this.e.other, p = this.p;
    const ctx = this.e.ctx, now = ctx.currentTime;
    const T = Math.max(0.5, (p.endMix - a) / p.rA); // segundos reales
    const curve = (fn) => { const n = 64, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = fn(i / (n - 1)); return c; };
    const all = [A.x.gain, B.x.gain, A.low.gain, B.low.gain, A.high.gain, B.high.gain, A.mid.gain];
    all.forEach((prm) => { prm.cancelScheduledValues(now); prm.setValueAtTime(prm.value, now); });
    if (p.type === 'sync') {
      const half = T / 2, beat = p.pA / p.rA;
      // 1ª mitad: entra B (sin graves). 2ª mitad: sale A. En la mitad: bass swap en un tiempo.
      B.x.gain.setValueCurveAtTime(curve((x) => Math.sin(x * Math.PI / 2)), now + 0.001, half);
      A.x.gain.setValueCurveAtTime(curve((x) => Math.cos(x * Math.PI / 2)), now + half, T - half);
      if (this.ctx.bassSwap) {
        A.low.gain.setValueAtTime(0, now + half - beat * 0.5);
        A.low.gain.linearRampToValueAtTime(-26, now + half + beat * 0.5);
        B.low.gain.setValueAtTime(-26, now + half - beat * 0.5);
        B.low.gain.linearRampToValueAtTime(0, now + half + beat * 0.5);
      } else {
        B.low.gain.linearRampToValueAtTime(0, now + half);
        A.low.gain.linearRampToValueAtTime(-26, now + T);
      }
      A.high.gain.setValueAtTime(0, now + half);
      A.high.gain.linearRampToValueAtTime(-9, now + T);
    } else {
      // Fundido: potencia constante + A pierde graves y brillo como un filtro
      B.x.gain.setValueCurveAtTime(curve((x) => Math.sin(x * Math.PI / 2)), now + 0.001, T);
      A.x.gain.setValueCurveAtTime(curve((x) => Math.cos(x * Math.PI / 2)), now + 0.001, T);
      A.low.gain.linearRampToValueAtTime(-20, now + T);
      A.high.gain.linearRampToValueAtTime(-12, now + T);
    }
    this.state = 'mixing';
    this.mixStartedAt = now; this.mixLen = T;
    this.safety = setTimeout(() => { if (this.state === 'mixing') this.finish(); }, T * 1000 + 1500);
  }

  finish() {
    clearTimeout(this.safety);
    const A = this.e.cur, B = this.e.other, p = this.p;
    const now = this.e.ctx.currentTime;
    this.stopFast();
    A.el.pause();
    for (const prm of [A.low.gain, A.mid.gain, A.high.gain, B.low.gain, B.high.gain, B.mid.gain]) { prm.cancelScheduledValues(now); prm.value = 0; }
    A.x.gain.cancelScheduledValues(now); A.x.gain.value = 0;
    B.x.gain.cancelScheduledValues(now); B.x.gain.value = 1;
    A.el.playbackRate = 1;
    this.e.active = B.idx; this.e.x = B.idx;
    this.state = 'idle'; this.p = null;
    if (p?.type === 'sync') this.glideToNative(B, p.pA, p.rA);
    this.h.adopt(B.track);
  }

  /** Tras la mezcla, B vuelve poco a poco a su tempo original (16 compases): calidad intacta. */
  glideToNative(D, pA, rA) {
    clearInterval(this.glide);
    const start = D.el.playbackRate, steps = Math.max(8, Math.round((64 * pA / rA) / 0.25));
    let k = 0;
    this.glide = setInterval(() => {
      if (D.el.paused || this.busy) { clearInterval(this.glide); return; }
      k++;
      D.el.playbackRate = start + (1 - start) * (k / steps);
      if (k >= steps) { D.el.playbackRate = 1; clearInterval(this.glide); }
    }, 250);
  }

  /** Cancela una preparación/mezcla en curso (pausa, cambio manual, búsqueda). */
  abort() {
    clearTimeout(this.safety);
    this.stopFast();
    if (!this.busy) { this.p = null; return; }
    const A = this.e.cur, B = this.e.other, now = this.e.ctx.currentTime;
    B.el.pause();
    for (const d of [A, B]) for (const prm of [d.x.gain, d.low.gain, d.mid.gain, d.high.gain]) prm.cancelScheduledValues(now);
    for (const d of [A, B]) { d.low.gain.value = 0; d.mid.gain.value = 0; d.high.gain.value = 0; }
    B.el.playbackRate = 1;
    this.e.applyX(this.e.active, 0);
    this.state = 'idle'; this.p = null;
  }

  /** Datos para la interfaz */
  info() {
    const A = this.e.cur, B = this.e.other;
    const a = A.el.currentTime, t = A.track;
    const beatOf = (tr, pos, rateFold = 1) => (tr?.dj?.period ? Math.floor((pos - tr.dj.grid) / (tr.dj.period * rateFold) + 1e-6) : null);
    const p = this.p || (this.on && !this.busy ? (this.p = this.plan()) : null);
    let mixIn = null, progress = 0;
    if (p) {
      mixIn = (p.mixA - a) / (p.rA || 1);
      if (this.state === 'mixing') progress = Math.min(1, (this.e.ctx.currentTime - this.mixStartedAt) / this.mixLen);
    }
    const tm = ok(t) && ok(this.next) ? tempoMatch(60 / t.dj.period, this.next.dj.bpm) : null;
    return {
      on: this.on, state: this.state, cur: t, next: this.next, plan: p, mixIn, progress, err: this.err,
      beatA: beatOf(t, a), beatB: this.busy && B.track ? beatOf(B.track, B.el.currentTime, tm?.m || 1) : null,
      tempo: tm, key: keyCompat(t?.dj?.camelot, this.next?.dj?.camelot),
    };
  }
}
