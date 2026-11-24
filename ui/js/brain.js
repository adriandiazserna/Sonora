// Algoritmo de gustos: aprende de lo que escuchas (completas, saltas, repites) por género, subgénero y artista,
// con decaimiento temporal, y genera mixes, radio inteligente y transiciones DJ.

import { call } from './bridge.js';
import { debounce, shuffleArr, norm } from './util.js';

export const GENRE_STYLE = {
  'Rock': { hue: 8, eq: 'Rock' },
  'Metal': { hue: 352, eq: 'Metal' },
  'Pop': { hue: 320, eq: 'Pop' },
  'Hip-Hop / Rap': { hue: 40, eq: 'Hip-Hop' },
  'R&B / Soul': { hue: 285, eq: 'R&B' },
  'Electrónica': { hue: 190, eq: 'Electrónica' },
  'Ambient / Chill': { hue: 170, eq: 'Suave' },
  'Jazz': { hue: 30, eq: 'Jazz' },
  'Clásica': { hue: 48, eq: 'Clásica' },
  'Bandas sonoras': { hue: 220, eq: 'Cine' },
  'Latina': { hue: 18, eq: 'Latina' },
  'Urbano latino': { hue: 300, eq: 'Hip-Hop' },
  'Reggae / Ska': { hue: 110, eq: 'Reggae' },
  'Blues': { hue: 210, eq: 'Acústico' },
  'Country': { hue: 35, eq: 'Acústico' },
  'Folk / Acústico': { hue: 80, eq: 'Acústico' },
  'Funk / Disco': { hue: 270, eq: 'Electrónica' },
  'Gospel': { hue: 55, eq: 'Vocal' },
  'Indie / Alternativo': { hue: 240, eq: 'Rock' },
  'Punk / Emo': { hue: 0, eq: 'Rock' },
  'Pop asiático': { hue: 335, eq: 'Pop' },
};

export function genreColor(g, l = 52, s = 70) {
  const st = GENRE_STYLE[g];
  let hue = st ? st.hue : [...(g || 'x')].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  return `hsl(${hue} ${s}% ${l}%)`;
}
export const genreGradient = (g) => `linear-gradient(160deg, ${genreColor(g, 40, 34)}, ${genreColor(g, 20, 24)})`;

export const EQ_PRESETS = {
  'Plano': [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  'Graves+': [6, 5, 4, 2, 0, 0, 0, 0, 0, 0],
  'Agudos+': [0, 0, 0, 0, 0, 1, 2, 4, 5, 6],
  'Loudness': [5, 4, 2, 0, -1, 0, 0, 2, 3, 4],
  'Vocal': [-2, -2, -1, 1, 3, 4, 3, 1, 0, -1],
  'Audífonos': [4, 3, 1, 0, -1, 0, 1, 2, 1, -1],
  'Gaming': [2, 1, 0, -1, -1, 1, 3, 4, 3, 1],
  'Suave': [1, 1, 0, 0, 0, -1, -1, -2, -2, -3],
  'Rock': [4, 3, 2, 0, -1, -1, 1, 2, 3, 3],
  'Metal': [4, 3, 1, 0, -2, -1, 1, 3, 4, 3],
  'Pop': [-1, 0, 2, 3, 3, 1, 0, 1, 2, 2],
  'Hip-Hop': [6, 5, 3, 1, -1, -1, 1, 0, 1, 2],
  'R&B': [4, 5, 3, 0, -1, 1, 2, 1, 2, 2],
  'Electrónica': [5, 4, 1, 0, -2, 1, 0, 2, 4, 4],
  'Jazz': [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  'Clásica': [3, 2, 1, 0, 0, 0, -1, 1, 2, 3],
  'Cine': [4, 3, 1, 0, 0, 0, 1, 2, 2, 2],
  'Latina': [3, 2, 0, -1, 0, 1, 2, 3, 3, 2],
  'Reggae': [3, 3, 1, 0, -1, -1, 0, 1, 2, 2],
  'Acústico': [2, 2, 1, 1, 1, 1, 2, 2, 2, 1],
};

const TAU = 45 * 86400; // vida media de los gustos (~1 mes y medio)
let S = { tracks: {}, genres: {}, subs: {}, artists: {}, history: [], loved: {}, version: 1 };
const save = debounce(() => call('state.save', { key: 'stats', value: S }).catch(() => { }), 3000);

export async function load() {
  try { const v = await call('state.load', { key: 'stats' }); if (v && v.tracks) S = Object.assign(S, v); } catch { }
}
export const stats = () => S;

const now = () => Date.now() / 1000;
function eff(e) { return e ? e.v * Math.exp(-(now() - e.t) / TAU) : 0; }
function bump(map, key, delta) {
  if (!key) return;
  const e = map[key];
  map[key] = { v: eff(e) + delta, t: now(), n: (e?.n || 0) + 1 };
}
export const affinity = (kind, key) => eff(S[kind][key]);

/**
 * Registra una escucha. fraction = parte escuchada (0..1). skipped = el usuario la cambió.
 * Completa (+1), escucha parcial (proporcional), salto temprano (−0.7). Repetir refuerza.
 */
export function record(track, fraction, skipped) {
  if (!track) return;
  const t = (S.tracks[track.id] ||= { p: 0, s: 0, c: 0, l: 0 });
  let delta;
  if (fraction >= 0.8) { delta = 1; t.c++; }
  else if (skipped && fraction < 0.25) { delta = -0.7; t.s++; }
  else delta = fraction * 0.6 - (skipped ? 0.15 : 0);
  if (fraction > 0.15) t.p++;
  t.l = now();
  t.sc = (t.sc || 0) * 0.85 + delta; // puntuación individual de la pista
  bump(S.genres, track.mainGenre, delta);
  bump(S.subs, track.subGenre, delta * 0.9);
  bump(S.artists, track.albumArtist || track.artist, delta * 0.8);
  if (fraction > 0.15) { S.history.push({ id: track.id, t: Math.round(now()) }); if (S.history.length > 800) S.history.splice(0, S.history.length - 800); }
  save();
}

export function setLoved(id, on) { if (on) S.loved[id] = 1; else delete S.loved[id]; save(); }
export const isLoved = (id) => !!S.loved[id];

export function topGenres(n = 6) {
  return Object.entries(S.genres).map(([k, e]) => [k, eff(e)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
}
export function topArtists(n = 10) {
  return Object.entries(S.artists).map(([k, e]) => [k, eff(e)]).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
}

/** Similitud entre dos pistas para radio y automix */
export function similarity(a, b) {
  if (!a || !b) return 0;
  let s = 0;
  if (a.mainGenre && a.mainGenre === b.mainGenre) s += 1.5;
  if (a.subGenre && a.subGenre === b.subGenre) s += 1.1;
  if (a.genreTags && b.genreTags) { const set = new Set(a.genreTags); s += b.genreTags.filter((x) => set.has(x)).length * 0.35; }
  if ((a.albumArtist || a.artist) === (b.albumArtist || b.artist)) s += 0.5;
  if (a.year && b.year) s += Math.max(0, 0.4 - Math.abs(a.year - b.year) / 25);
  if (a.bpm && b.bpm) { const r = bpmRatio(a.bpm, b.bpm); s += Math.max(0, 0.8 - Math.abs(1 - r) * 10); }
  return s;
}
// Compara BPM teniendo en cuenta tempo doble/mitad
export function bpmRatio(a, b) { let r = b / a; while (r > 1.45) r /= 2; while (r < 0.69) r *= 2; return r; }

/** Qué tanto te gusta una pista (para el DJ), aprox. -3..3 */
export function taste(t) {
  const st = S.tracks[t.id];
  let s = Math.tanh((affinity('genres', t.mainGenre) + affinity('subs', t.subGenre) * 0.8 + affinity('artists', t.albumArtist || t.artist) * 0.6) / 4) * 2;
  if (st) {
    s += Math.tanh(st.sc || 0);
    if ((now() - st.l) / 3600 < 3) s -= 2; // la acabas de oír
    if (st.s > st.c + 2) s -= 1;
  }
  if (S.loved[t.id]) s += 0.8;
  return s;
}

/** Puntuación de interés de una pista según tus gustos */
function score(t, { seed, explore = 0.5, recentIds }) {
  const st = S.tracks[t.id];
  let s = affinity('genres', t.mainGenre) * 1.0 + affinity('subs', t.subGenre) * 0.8 + affinity('artists', t.albumArtist || t.artist) * 0.6;
  s = Math.tanh(s / 4) * 3; // satura para que un género no lo acapare todo
  if (st) {
    s += Math.tanh(st.sc || 0) * 1.2;
    const hrs = (now() - st.l) / 3600;
    s -= hrs < 6 ? 2.5 : hrs < 48 ? 1 : 0; // evita repetir lo que acabas de oír
    if (st.s > st.c + 2) s -= 1.2;          // la saltas a menudo
  } else s += explore * 0.6;                // descubrimiento
  if (S.loved[t.id]) s += 1;
  if (seed) s += similarity(seed, t) * 1.4;
  if (recentIds && recentIds.has(t.id)) s -= 5;
  return s + Math.random() * (0.6 + explore);
}

/** Genera una lista: n pistas, con diversidad de artistas */
export function recommend(tracks, n = 25, opts = {}) {
  const recentIds = new Set(S.history.slice(-60).map((h) => h.id));
  const pool = tracks.filter((t) => t.playable && (!opts.filter || opts.filter(t)));
  const scored = pool.map((t) => [t, score(t, { ...opts, recentIds })]).sort((a, b) => b[1] - a[1]);
  const out = [], perArtist = {};
  const maxPer = opts.maxPerArtist ?? 2;
  for (const [t] of scored) {
    const a = t.albumArtist || t.artist;
    if ((perArtist[a] || 0) >= maxPer) continue;
    perArtist[a] = (perArtist[a] || 0) + 1;
    out.push(t);
    if (out.length >= n) break;
  }
  return opts.keepOrder ? out : smoothOrder(out);
}

// Ordena para que las transiciones sean suaves (vecino más parecido)
function smoothOrder(list) {
  if (list.length < 3) return list;
  const rest = list.slice(1), out = [list[0]];
  while (rest.length) {
    const last = out[out.length - 1];
    let bi = 0, bs = -1;
    for (let i = 0; i < Math.min(rest.length, 12); i++) { const s = similarity(last, rest[i]); if (s > bs) { bs = s; bi = i; } }
    out.push(rest.splice(bi, 1)[0]);
  }
  return out;
}

/** Mixes de la página de inicio */
export function homeMixes(tracks) {
  const mixes = [];
  const tops = topGenres(4);
  const byGenre = (g) => tracks.filter((t) => t.mainGenre === g);
  if (tops.length === 0) {
    // Aún no hay historial: mixes por los géneros con más música
    const counts = {};
    tracks.forEach((t) => { if (t.mainGenre && t.mainGenre !== 'Sin clasificar') counts[t.mainGenre] = (counts[t.mainGenre] || 0) + 1; });
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).forEach(([g]) => tops.push([g, 0]));
  }
  for (const [g] of tops) {
    const list = recommend(byGenre(g), 30, { explore: 0.4 });
    if (list.length >= 5) mixes.push({ id: 'mix:' + g, name: 'Mix ' + g, desc: 'Basado en lo que más escuchas', genre: g, tracks: list });
  }
  const unplayed = tracks.filter((t) => !S.tracks[t.id]);
  if (unplayed.length > 10) mixes.push({ id: 'discover', name: 'Descubrimiento', desc: 'Joyas de tu biblioteca que aún no escuchas', genre: tops[0]?.[0], tracks: recommend(unplayed, 30, { explore: 1.2 }) });
  const fav = tracks.filter((t) => (S.tracks[t.id]?.c || 0) >= 2 || S.loved[t.id]).sort((a, b) => (S.tracks[b.id]?.c || 0) - (S.tracks[a.id]?.c || 0));
  if (fav.length >= 5) mixes.push({ id: 'favs', name: 'Tus favoritas', desc: 'Las que siempre terminas', genre: 'Pop', tracks: fav.slice(0, 50) });
  const old = tracks.filter((t) => { const s = S.tracks[t.id]; return s && s.c >= 1 && now() - s.l > 30 * 86400; });
  if (old.length >= 5) mixes.push({ id: 'rediscover', name: 'Redescubre', desc: 'Te gustaban y hace mucho no suenan', genre: 'Jazz', tracks: recommend(old, 30, { explore: 0.2 }) });
  return mixes;
}

/** Siguiente pista para radio/automix a partir de la actual */
export function radioNext(tracks, seed, n = 10, excludeIds = new Set()) {
  return recommend(tracks.filter((t) => !excludeIds.has(t.id)), n, { seed, explore: 0.35, maxPerArtist: 2 });
}

export function searchScore(t, q) {
  const s = norm(`${t.title} ${t.artist} ${t.album} ${t.mainGenre || ''} ${t.subGenre || ''}`);
  return q.every((w) => s.includes(w));
}
