import { call, on, hasHost } from './bridge.js';
import { Engine, BANDS } from './audio.js';
import * as Brain from './brain.js';
import { GENRE_STYLE, EQ_PRESETS, genreColor, genreGradient } from './brain.js';
import {
  $, $$, h, icon, setIcon, fmtTime, fmtLong, fmtNum, debounce, norm, shuffleArr, accentFrom, hex, hexToRgb,
  rgbToHsl, hslToRgb, softBlur, VirtualList, slider, toast, contextMenu, closeMenus, lazyImg, spatialMove,
} from './util.js';
import { AutoDJ, parseRequest, pickFirst, rankEnergy, keyCompat } from './dj.js';

// ======================================================================
// Estado
// ======================================================================
const DEFAULTS = {
  v: 3, theme: 'dark', accent: 'fixed', accentColor: '#0a84ff', bg: 'cover', blur: true, blurAmount: 60, radius: 14, scale: 1,
  animations: true, sideCollapsed: false, tvMode: false, gameMode: false, visualizer: true, closeToTray: false,
  albumView: 'grid', albumSort: 'artist', artistSort: 'name', songSort: 'artist', songDir: 1, npMode: 'cover',
  volume: 0.8, muted: false, crossfade: 4, smartCrossfade: true, gapless: true, rg: 'track', limiter: true, sampleRate: 0,
  eqOn: true, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreset: 'Plano', preamp: 0, autoEq: false, customPresets: {},
  autoRadio: true, scrobble: true, gpuAccel: false, windowFx: 'glass', lfBrowser: '', djFade: 8, djCurve: 'smooth', automix: false, keylock: true,
  djTab: 'auto', djBeats: 16, djEnergy: 'auto', djBassSwap: true, djLast: '',
};
let settings = { ...DEFAULTS };
const S = {
  tracks: [], byId: new Map(), albums: [], albumByKey: new Map(), artists: [], artistByName: new Map(), genres: [],
  folders: [], lastfm: {}, view: 'home', arg: null, hist: [], cleanup: [],
};
let engine, dj;
const rgOf = (t) => (settings.rg === 'off' ? 0 : settings.rg === 'album' ? (t.rgAlbum ?? t.rgTrack ?? 0) : (t.rgTrack ?? t.rgAlbum ?? 0));

const saveSettings = debounce(() => call('state.save', { key: 'settings', value: settings }).catch(() => { }), 800);
function set(k, v) { settings[k] = v; saveSettings(); }

// ======================================================================
// Biblioteca
// ======================================================================
// Claves sin distinguir mayúsculas («Alice in Chains» = «Alice In Chains»)
const akey = (s) => (s || '').trim().toLowerCase();
const albumKey = (t) => akey(t.albumArtist || t.artist || 'Desconocido') + '\u0001' + akey(t.album);
const artistOf = (name) => S.artistByName.get(akey(name));
const coverUrl = (id, size = 's') => (id ? `/cover/${id}/${size}` : null);
const imgUrl = (u, w = 0) => (u ? `/img?u=${encodeURIComponent(u)}&w=${w}` : null);
const mediaUrl = (t) => `/media/${t.id}`;
const topKey = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0];

function setTracks(tracks) {
  S.tracks = tracks;
  rankEnergy(tracks);
  S.byId = new Map(tracks.map((t) => [t.id, t]));
  const albums = new Map(), artists = new Map(), genres = new Map();
  for (const t of tracks) {
    const aa = t.albumArtist || t.artist || 'Desconocido';
    const k = albumKey(t);
    let a = albums.get(k);
    if (!a) albums.set(k, (a = { key: k, name: t.album || 'Sin álbum', artist: aa, year: 0, coverId: null, tracks: [], added: 0, g: {} }));
    a.tracks.push(t);
    a.coverId ||= t.coverId;
    if (t.year && (!a.year || t.year < a.year)) a.year = t.year;
    a.added = Math.max(a.added, t.added || 0);
    a.g[t.mainGenre] = (a.g[t.mainGenre] || 0) + 1;
    let ar = artists.get(akey(aa));
    if (!ar) artists.set(akey(aa), (ar = { name: aa, albums: [], tracks: [], g: {} }));
    ar.tracks.push(t);
    ar.g[t.mainGenre] = (ar.g[t.mainGenre] || 0) + 1;
    const gn = t.mainGenre || 'Sin clasificar';
    let ge = genres.get(gn);
    if (!ge) genres.set(gn, (ge = { name: gn, tracks: [], subs: {}, covers: [] }));
    ge.tracks.push(t);
    if (t.subGenre) ge.subs[t.subGenre] = (ge.subs[t.subGenre] || 0) + 1;
    if (t.coverId && ge.covers.length < 3 && !ge.covers.includes(t.coverId)) ge.covers.push(t.coverId);
  }
  for (const a of albums.values()) {
    a.tracks.sort((x, y) => (x.discNo || 0) - (y.discNo || 0) || (x.trackNo || 0) - (y.trackNo || 0) || x.title.localeCompare(y.title));
    a.genre = topKey(a.g);
    a.duration = a.tracks.reduce((s, t) => s + (t.duration || 0), 0);
    a.best = a.tracks.reduce((b, t) => (score(t) > score(b) ? t : b), a.tracks[0]);
    artists.get(akey(a.artist)).albums.push(a);
  }
  for (const ar of artists.values()) {
    ar.genre = topKey(ar.g);
    ar.albums.sort((x, y) => (x.year || 9999) - (y.year || 9999));
    ar.coverId = ar.albums.find((x) => x.coverId)?.coverId;
  }
  S.albums = [...albums.values()];
  S.albumByKey = albums;
  S.artists = [...artists.values()];
  S.artistByName = artists;
  S.genres = [...genres.values()].sort((a, b) => b.tracks.length - a.tracks.length);
  function score(t) { return (t.bitDepth || 0) * 1e6 + (t.sampleRate || 0); }
}

function quality(t) {
  if (!t) return null;
  const dsd = t.ext === 'dsf' || t.ext === 'dff';
  const lossless = dsd || ['flac', 'wav', 'aiff', 'aif', 'ape', 'wv'].includes(t.ext) || /alac|lossless/i.test(t.codec || '');
  const hires = dsd || (lossless && ((t.bitDepth || 16) > 16 || (t.sampleRate || 0) > 48000));
  const khz = t.sampleRate ? (t.sampleRate / 1000).toFixed(t.sampleRate % 1000 ? 1 : 0) + ' kHz' : '';
  const label = dsd ? 'DSD' : lossless ? `${t.bitDepth || 16}-bit / ${khz}` : t.bitrate ? `${t.bitrate} kbps` : '';
  return { lossless, hires, label, fmt: (t.ext || '').toUpperCase() };
}
function qBadges(t, short = false) {
  const q = quality(t);
  if (!q) return [];
  const out = [h('span', { class: 'badge' + (q.lossless ? ' lossless' : '') }, q.fmt)];
  if (q.hires) out.push(h('span', { class: 'badge hires' }, short ? 'Hi-Res' : 'Hi-Res ' + q.label));
  else if (!short && q.label) out.push(h('span', { class: 'badge' }, q.label));
  if (!t.playable) out.push(h('span', { class: 'badge', title: 'Este formato aún no se puede reproducir' }, 'No compatible'));
  return out;
}

// Metadatos de artista (caché en memoria de promesas)
const artistMeta = new Map();
function getArtist(name) {
  if (!artistMeta.has(name)) artistMeta.set(name, call('meta.artist', { name }).catch(() => null));
  return artistMeta.get(name);
}

// Carga diferida de imágenes al entrar en pantalla
const io = new IntersectionObserver((ents) => {
  for (const e of ents) if (e.isIntersecting) { io.unobserve(e.target); const f = e.target._onSee; e.target._onSee = null; f && f(); }
}, { rootMargin: '400px' });
function whenSeen(el, fn) { el._onSee = fn; io.observe(el); }

// ======================================================================
// Reproductor
// ======================================================================
const P = {
  queue: [], i: -1, orig: null, shuffle: false, repeat: 'off', listen: null, mixing: false, preloaded: null,
  get track() { return this.queue[this.i] || null; },

  async playList(list, start = 0, { shuffle = false, fromDJ = false } = {}) {
    list = list.filter(Boolean);
    if (dj?.on && !fromDJ) stopDJ(true); // elegiste otra cosa: el DJ se retira
    if (!list.length) return;
    if (shuffle) { list = shuffleArr(list.slice()); start = 0; }
    this.queue = list.slice(); this.orig = null;
    this.shuffle = shuffle;
    await this.go(start);
    renderQueue(); updateBar();
  },

  async go(i, { fade = 0, auto = false } = {}) {
    this.finish(!auto);
    let tries = 0;
    while (this.queue[i] && !this.queue[i].playable && tries++ < 50) i++;
    const t = this.queue[i];
    if (!t) { engine.pause(); return; }
    this.i = i; this.mixing = false; this.preloaded = null;
    if (dj?.busy) dj.abort();
    await engine.play(t, mediaUrl(t), { fade, rg: rgOf(t) });
    this.start(t);
  },

  start(t) {
    this.listen = { track: t, started: Math.round(Date.now() / 1000), listened: 0, lastT: 0, scrobbled: false };
    if (settings.autoEq && t.mainGenre) {
      const p = GENRE_STYLE[t.mainGenre]?.eq;
      if (p && EQ_PRESETS[p]) { engine.setEQ(EQ_PRESETS[p]); settings.eqPreset = p + ' (auto)'; }
    }
    if (settings.scrobble && S.lastfm.connected) call('lastfm.nowPlaying', { artist: t.artist, track: t.title, album: t.album, duration: Math.round(t.duration) }).catch(() => { });
    call('app.nowPlaying', { text: `${t.title} — ${t.artist}` }).catch(() => { });
    mediaSession(t);
    if (dj?.on) { dj.trackStarted(t); this.queue = this.queue.slice(0, this.i + 1).concat(dj.next ? [dj.next] : []); }
    onTrackChange(t);
    saveQueue();
  },

  /** El DJ terminó una mezcla: la canción del otro deck pasa a ser la actual. */
  adopt(t) {
    this.finish(false);
    if (this.queue[this.i + 1] !== t) this.queue.splice(this.i + 1, 0, t);
    this.i++;
    this.preloaded = null; this.mixing = false;
    this.start(t);
    renderQueue();
  },

  finish(skipped) {
    const L = this.listen;
    if (!L) return;
    const d = L.track.duration || engine.duration || 1;
    Brain.record(L.track, Math.min(1, L.listened / d), skipped);
    this.listen = null;
  },

  peekNext() {
    if (this.repeat === 'one') return this.track;
    if (this.i + 1 < this.queue.length) return this.queue[this.i + 1];
    if (this.repeat === 'all') return this.queue[0];
    if (settings.autoRadio && this.track) {
      const ex = new Set(this.queue.slice(-200).map((t) => t.id));
      const more = Brain.radioNext(S.tracks, this.track, 10, ex);
      if (more.length) { this.queue.push(...more); renderQueue(); return this.queue[this.i + 1]; }
    }
    return null;
  },

  async next({ fade = 0, auto = false } = {}) {
    if (dj?.on && !auto) { if (dj.mixNow()) { toast('Mezclando en el siguiente compás…', 1500); return; } if (dj.busy) return; }
    if (auto && this.repeat === 'one') return this.go(this.i, { fade, auto });
    let n = this.i + 1;
    if (n >= this.queue.length) {
      if (this.repeat === 'all') n = 0;
      else if (settings.autoRadio && this.track) {
        const ex = new Set(this.queue.slice(-200).map((t) => t.id));
        this.queue.push(...Brain.radioNext(S.tracks, this.track, 10, ex));
      }
      if (n >= this.queue.length) { this.finish(!auto); engine.pause(); updateBar(); return; }
    }
    await this.go(n, { fade, auto });
    renderQueue();
  },

  async prev() {
    if (engine.time > 4 || this.i <= 0) { engine.seek(0); return; }
    await this.go(this.i - 1);
    renderQueue();
  },

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    const cur = this.track;
    if (this.shuffle) {
      this.orig = this.queue.slice();
      const rest = shuffleArr(this.queue.filter((_, k) => k !== this.i));
      this.queue = cur ? [cur, ...rest] : rest; this.i = cur ? 0 : -1;
    } else if (this.orig) {
      this.queue = this.orig; this.i = Math.max(0, this.queue.indexOf(cur)); this.orig = null;
    }
    this.preloaded = null;
    renderQueue(); updateBar(); saveQueue();
  },

  addNext(tracks) { this.queue.splice(this.i + 1, 0, ...tracks); this.preloaded = null; renderQueue(); saveQueue(); toast(tracks.length > 1 ? `${tracks.length} canciones sonarán a continuación` : 'Sonará a continuación'); },
  addEnd(tracks) { this.queue.push(...tracks); renderQueue(); saveQueue(); toast(tracks.length > 1 ? `${tracks.length} canciones agregadas a la cola` : 'Agregada a la cola'); },
  playNow(t) { if (this.i < 0) return this.playList([t]); this.queue.splice(this.i + 1, 0, t); return this.next().then(updateBar); },
  radio(seed) {
    const list = [seed, ...Brain.radioNext(S.tracks, seed, 24, new Set([seed.id]))];
    this.playList(list, 0);
    toast('Radio basada en «' + seed.title + '»');
  },

  onTime(t, d) {
    const L = this.listen;
    if (L) {
      const dt = t - L.lastT;
      if (dt > 0 && dt < 2.5) L.listened += dt;
      L.lastT = t;
      if (!L.scrobbled && settings.scrobble && S.lastfm.connected && d > 30 && L.listened >= Math.min(d / 2, 240)) {
        L.scrobbled = true;
        const tr = L.track;
        call('lastfm.scrobble', { artist: tr.artist, track: tr.title, album: tr.album, duration: Math.round(d), timestamp: L.started }).catch(() => { });
      }
    }
    if (dj?.on) { dj.tick(); return; } // el DJ decide cuándo y cómo mezclar
    if (!d || engine.fading || this.mixing) return;
    const rem = d - t;
    const automix = settings.automix;
    const cf = Math.min(automix ? settings.djFade : settings.crossfade, d / 4);
    // Precarga para cambio sin pausas
    if ((settings.gapless || cf > 0) && rem < 15 && !this.preloaded) {
      const n = this.peekNext();
      if (n && n.playable && n !== this.track) { engine.preload(n, mediaUrl(n)); this.preloaded = n.id; }
    }
    if (cf > 0.3 && rem <= cf && rem > 0.2) {
      const n = this.peekNext();
      if (!n || n === this.track) return;
      const cur = this.track;
      if (!automix && settings.smartCrossfade && cur && n.album && n.album === cur.album && (n.albumArtist || n.artist) === (cur.albumArtist || cur.artist) && (n.trackNo || 0) === (cur.trackNo || 0) + 1) return; // álbum continuo: sin mezcla
      this.mixing = true;
      if (automix) beatMatch(cur, n);
      this.next({ fade: cf, auto: true });
    }
  },
};

// Ajuste de tempo DJ: iguala el BPM de la entrante y vuelve a 1.0 poco a poco
function beatMatch(a, b) {
  if (!a?.bpm || !b?.bpm) return;
  const r = Brain.bpmRatio(b.bpm, a.bpm);
  if (Math.abs(1 - r) > 0.08) return;
  const idx = 1 - engine.active;
  engine.setTempo(idx, r, settings.keylock);
  let k = 0;
  const iv = setInterval(() => {
    k++;
    const rate = r + (1 - r) * (k / 20);
    engine.setTempo(idx, rate, settings.keylock);
    if (k >= 20) clearInterval(iv);
  }, 1500);
}

function mediaSession(t) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: t.title, artist: t.artist, album: t.album,
      artwork: t.coverId ? [{ src: location.origin + coverUrl(t.coverId, 'l'), sizes: '1400x1400', type: 'image/jpeg' }] : [],
    });
  } catch { }
}

const saveQueue = debounce(() => {
  call('state.save', { key: 'queue', value: { ids: P.queue.slice(0, 1000).map((t) => t.id), i: P.i, t: engine?.time || 0, shuffle: P.shuffle, repeat: P.repeat } }).catch(() => { });
}, 1500);

// ======================================================================
// Apariencia
// ======================================================================
function setAccent(rgb) {
  const [hh, s, l] = rgbToHsl(...rgb);
  const second = hslToRgb(hh, s, Math.min(0.8, l + 0.1));
  const r = document.documentElement.style;
  r.setProperty('--accent', hex(rgb));
  r.setProperty('--accent-rgb', rgb.map(Math.round).join(', '));
  r.setProperty('--accent2', hex(second));
}

function applySettings() {
  const d = document.documentElement, b = document.body;
  d.dataset.theme = settings.theme;
  d.style.setProperty('--radius', settings.radius + 'px');
  d.style.setProperty('--blur', settings.blurAmount + 'px');
  d.style.setProperty('--scale', settings.tvMode ? Math.max(1.35, settings.scale) : settings.scale);
  b.classList.toggle('no-blur', !settings.blur);
  b.classList.toggle('bg-solid', settings.bg === 'solid');
  b.classList.toggle('no-anim', !settings.animations || settings.gameMode);
  b.classList.toggle('side-collapsed', settings.sideCollapsed);
  b.classList.toggle('tv', settings.tvMode);
  b.classList.toggle('game', settings.gameMode);
  if (settings.accent !== 'auto') setAccent(hexToRgb(settings.accentColor));
  else if (P.track?.coverId) accentFrom(coverUrl(P.track.coverId)).then((c) => c && setAccent(c));
  const caption = { dark: '#141416', amoled: '#000000', light: '#f2f2f7' }[settings.theme] || '#141416';
  // El núcleo decide si el cristal es posible (Windows 11 22H2+); la página usa lo que de verdad se aplicó
  const fxClasses = (fx) => { b.classList.toggle('fx', fx !== 'none'); b.classList.toggle('fx-clear', fx === 'glass'); };
  fxClasses(S.fxSupported === false ? 'none' : settings.windowFx);
  call('app.windowFx', { fx: settings.windowFx }).then((fx) => fxClasses(fx || 'none')).catch(() => fxClasses('none'));
  call('app.caption', { color: caption }).catch(() => { });
  call('app.gameMode', { on: settings.gameMode }).catch(() => { });
  call('app.closeToTray', { on: settings.closeToTray }).catch(() => { });
  if (engine) {
    engine.setVolume(settings.muted ? 0 : settings.volume);
    engine.setEqEnabled(settings.eqOn);
    engine.setEQ(settings.eq);
    engine.setPreamp(settings.preamp);
    engine.setLimiter(settings.limiter);
  }
  updateBackground();
}

let bgFlip = 0, bgCur = null;
async function updateBackground() {
  const t = P.track;
  let url = null;
  if (settings.bg === 'cover' && t?.coverId) url = coverUrl(t.coverId, 's');
  else if (settings.bg === 'artist' && t) {
    const m = await getArtist(t.albumArtist || t.artist);
    url = m?.fanarts?.[0] ? imgUrl(m.fanarts[0], 600) : m?.image ? imgUrl(m.image, 400) : t.coverId ? coverUrl(t.coverId, 's') : null;
  }
  const key = url ? url + '|' + settings.blurAmount : null;
  if (key === bgCur) return;
  bgCur = key;
  const blurred = url ? await softBlur(url, settings.blurAmount) : null;
  if (bgCur !== key) return; // llegó otra canción mientras tanto
  const layers = $$('#bg .bg-layer');
  const next = layers[bgFlip ^= 1], prev = layers[bgFlip ^ 1];
  if (blurred) { next.style.backgroundImage = `url("${blurred}")`; next.classList.add('on'); prev.classList.remove('on'); }
  else { prev.classList.remove('on'); next.classList.remove('on'); }
}

function albumBg(a) {
  const el = h('div', { class: 'hbg', style: { background: genreGradient(a.genre) } });
  if (a.coverId) softBlur(coverUrl(a.coverId, 's'), 70).then((u) => u && (el.style.background = `center/cover url(${u})`));
  return el;
}

function onTrackChange(t) {
  if (t.coverId) accentFrom(coverUrl(t.coverId)).then((c) => {
    if (!c) return;
    if (settings.accent === 'auto') setAccent(c);
    document.documentElement.style.setProperty('--wash-rgb', c.map(Math.round).join(', ')); // resplandor con el color de la portada
  });
  updateBackground();
  updateBar();
  renderQueue();
  $$('.trow.cur').forEach((r) => r.classList.remove('cur'));
  $$(`.trow[data-id="${t.id}"]`).forEach((r) => r.classList.add('cur'));
  if (S.view === 'now') render(true);
  document.dispatchEvent(new CustomEvent('trackchange', { detail: t }));
}

// ======================================================================
// Estructura: navegación, barra, cola
// ======================================================================
const NAV = [
  ['home', 'Inicio', 'home'], ['albums', 'Álbumes', 'disc'], ['artists', 'Artistas', 'mic'], ['songs', 'Canciones', 'music'], ['genres', 'Géneros', 'tag'],
  '-', ['dj', 'DJ', 'dj'], ['eq', 'Ecualizador', 'sliders'],
  '-', ['profile', 'Perfil', 'user'], ['settings', 'Ajustes', 'settings'],
];
function buildNav() {
  $('#nav').replaceChildren(...NAV.map((n) => typeof n === 'string'
    ? h('div', { class: 'nav-sep' })
    : h('button', { class: 'nav-item', 'data-view': n[0], title: n[1], onClick: () => go(n[0]) }, icon(n[2]), h('span', null, n[1]))));
  $('[data-act="collapse"]').onclick = () => { set('sideCollapsed', !settings.sideCollapsed); applySettings(); };
  $('#backBtn').onclick = back;
  updateSideFoot();
  const tools = $('#topTools');
  tools.replaceChildren(
    h('button', { class: 'icon-btn' + (settings.gameMode ? ' on' : ''), id: 'gameBtn', title: 'Modo juego: mínimo consumo de RAM/GPU', onClick: () => toggleGame() }, icon('game')),
    h('button', { class: 'icon-btn' + (settings.tvMode ? ' on' : ''), id: 'tvBtn', title: 'Modo TV (pantalla completa, control con flechas o mando)', onClick: () => toggleTV() }, icon('tv')),
  );
}
function markNav() { $$('.nav-item').forEach((b) => b.classList.toggle('on', b.dataset.view === S.view || (S.view === 'album' && b.dataset.view === 'albums') || (S.view === 'artist' && b.dataset.view === 'artists') || (S.view === 'genre' && b.dataset.view === 'genres'))); }

function updateSideFoot() {
  const lf = S.lastfm || {};
  $('#sideFoot').replaceChildren(
    h('div', { class: 'row', title: lf.connected ? 'Scrobbleando a Last.fm como ' + lf.user : 'Last.fm sin conectar' },
      h('span', { class: 'dot' + (lf.connected ? ' ok' : '') }), h('span', { class: 'txt' }, lf.connected ? 'Last.fm · ' + lf.user : 'Last.fm desconectado')),
    h('div', { class: 'row txt' }, `${fmtNum(S.tracks.length)} canciones`),
  );
}

function toggleGame(on = !settings.gameMode) {
  set('gameMode', on); applySettings();
  $('#gameBtn')?.classList.toggle('on', on);
  toast(on ? 'Modo juego activado: sin desenfoques ni animaciones, memoria reducida' : 'Modo juego desactivado');
  if (S.view === 'now') render(true);
}
function toggleTV(on = !settings.tvMode) {
  set('tvMode', on); applySettings();
  $('#tvBtn')?.classList.toggle('on', on);
  call('app.fullscreen', { on }).catch(() => { });
  if (on) { toast('Modo TV: usa las flechas o un mando · Enter para elegir · Retroceso para volver'); startGamepad(); setTimeout(() => spatialMove('down'), 300); }
}

// ---------- Forma de onda para adelantar/retroceder ----------
function waveScrubber({ onChange, onInput, cls = '', bars = 120 } = {}) {
  const base = h('div', { class: 'wv-bars' }), played = h('div', { class: 'wv-bars played' });
  const el = h('div', { class: 'wave ' + cls, tabindex: 0, title: 'Arrastra para moverte en la canción' }, base, played);
  let p = 0;
  const paint = () => { played.style.clipPath = `inset(0 ${(1 - p) * 100}% 0 0)`; };
  el.setWave = (str) => {
    let vals = str ? str.split('').map(Number) : null;
    if (vals && vals.length > bars) { // reduce a «bars» columnas tomando el máximo de cada tramo
      const out = [];
      for (let i = 0; i < bars; i++) { const a = Math.floor(i * vals.length / bars), b = Math.floor((i + 1) * vals.length / bars); out.push(Math.max(...vals.slice(a, Math.max(b, a + 1)))); }
      vals = out;
    }
    el.classList.toggle('pending', !vals);
    const mk = () => (vals || Array.from({ length: Math.min(90, bars) }, (_, i) => 2 + Math.round(Math.abs(Math.sin(i * 0.37)) * 2))).map((v) => h('i', { style: { height: 10 + v * 10 + '%' } }));
    base.replaceChildren(...mk()); played.replaceChildren(...mk());
  };
  el.set = (v) => { if (!el.classList.contains('drag')) { p = v || 0; paint(); } };
  el.setBuf = () => { };
  const at = (e) => { const r = el.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); el.classList.add('drag');
    p = at(e); paint(); onInput && onInput(p);
    const mv = (ev) => { p = at(ev); paint(); onInput && onInput(p); };
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); onChange && onChange(p); };
    el.addEventListener('pointermove', mv); el.addEventListener('pointerup', up);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopPropagation();
    p = Math.min(1, Math.max(0, p + (e.key === 'ArrowRight' ? 0.02 : -0.02))); paint(); onChange && onChange(p);
  });
  el.setWave(null);
  return el;
}

// ---------- Barra del reproductor ----------
let bar = {};
function buildBar() {
  const seek = waveScrubber({ onChange: (v) => { if (dj?.busy) dj.abort(); if (dj) dj.p = null; engine.seek(v * engine.duration); }, onInput: (v) => (bar.tCur.textContent = fmtTime(v * engine.duration)) });
  const vol = slider({ min: 0, max: 1, value: settings.volume, cls: 'vol', onInput: (v) => { settings.muted = false; set('volume', v); engine.setVolume(v); setIcon(bar.volI, v ? 'volume' : 'mute'); } });
  bar = {
    cov: h('div', { class: 'cov', title: 'Abrir vista inmersiva', onClick: () => go('now') }),
    t: h('div', { class: 't', onClick: () => P.track && go('album', albumKey(P.track)) }, 'Sonora'),
    a: h('div', { class: 'a', onClick: () => P.track && go('artist', P.track.albumArtist || P.track.artist) }, 'Elige algo para escuchar'),
    q: h('div', { class: 'q' }),
    play: h('button', { class: 'playbtn', title: 'Reproducir / Pausa (Espacio)', onClick: () => togglePlay() }, icon('play')),
    shuf: h('button', { class: 'icon-btn', title: 'Aleatorio (S)', onClick: () => P.toggleShuffle() }, icon('shuffle', 'sm')),
    rep: h('button', { class: 'icon-btn', title: 'Repetir (R)', onClick: () => cycleRepeat() }, icon('repeat', 'sm')),
    tCur: h('span', null, '0:00'), tDur: h('span', null, '0:00'),
    seek, vol,
    volI: icon(settings.volume ? 'volume' : 'mute'),
    love: h('button', { class: 'icon-btn', title: 'Me gusta (L)', onClick: () => toggleLove() }, icon('heart', 'sm')),
  };
  $('#bar').replaceChildren(
    h('div', { class: 'np' }, bar.cov, h('div', { class: 'txt' }, bar.t, bar.a, bar.q), bar.love),
    h('div', { class: 'center' },
      h('div', { class: 'ctrls' }, bar.shuf,
        h('button', { class: 'icon-btn', title: 'Anterior (Ctrl+←)', onClick: () => P.prev() }, icon('prev')),
        bar.play,
        h('button', { class: 'icon-btn', title: 'Siguiente (Ctrl+→)', onClick: () => P.next() }, icon('next')),
        bar.rep),
      h('div', { class: 'seekrow' }, bar.tCur, seek, bar.tDur)),
    h('div', { class: 'right' },
      h('button', { class: 'icon-btn', title: 'Letras', onClick: () => { set('npMode', 'lyrics'); go('now'); } }, icon('lyrics', 'sm')),
      h('button', { class: 'icon-btn', title: 'Ecualizador', onClick: () => go('eq') }, icon('sliders', 'sm')),
      h('button', { class: 'icon-btn', title: 'Cola (Q)', onClick: () => toggleQueue() }, icon('queue', 'sm')),
      h('button', { class: 'icon-btn', title: 'Silenciar (M)', onClick: () => toggleMute() }, bar.volI),
      vol,
      h('button', { class: 'icon-btn', title: 'Vista inmersiva (N)', onClick: () => go('now') }, icon('expand', 'sm'))),
  );
}

function updateBar() {
  const t = P.track;
  const playing = engine?.playing;
  setIcon(bar.play.firstChild, playing ? 'pause' : 'play');
  document.body.classList.toggle('playing', !!playing);
  bar.shuf.classList.toggle('on', P.shuffle);
  bar.rep.classList.toggle('on', P.repeat !== 'off');
  setIcon(bar.rep.firstChild, P.repeat === 'one' ? 'repeat1' : 'repeat');
  if (!t) return;
  if (bar.cur !== t.id) {
    bar.cur = t.id;
    bar.t.textContent = t.title; bar.a.textContent = t.artist + (t.album ? ' · ' + t.album : '');
    bar.cov.replaceChildren(t.coverId ? lazyImg(coverUrl(t.coverId, 's')) : h('div', { class: 'ph', style: { background: genreGradient(t.mainGenre) } }, icon('music')));
    bar.q.replaceChildren(...qBadges(t, true), dj?.on ? h('span', { class: 'djtag' }, 'DJ') : null);
    bar.seek.setWave(t.dj?.wave);
    if (!t.dj?.wave && t.playable) call('dj.analyze', { ids: [t.id], priority: true }).catch(() => { });
    document.title = `${t.title} · ${t.artist} — Sonora`;
  }
  bar.love.classList.toggle('on', Brain.isLoved(t.id));
}

function onTime({ t, d }) {
  if (d) { bar.seek.set(t / d); bar.tCur.textContent = fmtTime(t); bar.tDur.textContent = fmtTime(d); }
  P.onTime(t, d);
  if (Math.floor(t) % 15 === 0) saveQueue();
}

function togglePlay() {
  if (!P.track) { const list = Brain.recommend(S.tracks, 30); if (list.length) P.playList(list); return; }
  if (!engine.cur.url) { P.go(P.i); return; }
  engine.toggle();
  if (!P.listen) P.start(P.track); // cola restaurada al abrir la app
}
function cycleRepeat() { P.repeat = { off: 'all', all: 'one', one: 'off' }[P.repeat]; updateBar(); toast({ off: 'Repetir desactivado', all: 'Repetir cola', one: 'Repetir canción' }[P.repeat]); }
function toggleMute() { settings.muted = !settings.muted; engine.setVolume(settings.muted ? 0 : settings.volume); setIcon(bar.volI, settings.muted ? 'mute' : 'volume'); }
async function toggleLove(t = P.track) {
  if (!t) return;
  const onNow = !Brain.isLoved(t.id);
  Brain.setLoved(t.id, onNow);
  updateBar();
  toast(onNow ? '♥ Agregada a tus favoritas' : 'Quitada de favoritas');
  if (S.lastfm.connected) call('lastfm.love', { artist: t.artist, track: t.title, love: onNow }).catch(() => { });
}

// ---------- Cola ----------
function toggleQueue() { document.body.classList.toggle('queue-open'); renderQueue(); }
function renderQueue() {
  if (!document.body.classList.contains('queue-open')) return;
  const q = $('#queue');
  const item = (t, k) => {
    const el = h('div', { class: 'qitem' + (k === P.i ? ' cur' : k < P.i ? ' past' : ''), draggable: 'true', onDblclick: () => P.go(k).then(renderQueue) },
      h('div', { class: 'mini', style: { backgroundImage: t.coverId ? `url(${coverUrl(t.coverId)})` : genreGradient(t.mainGenre) } }),
      h('div', { class: 'txt' }, h('div', { class: 't' }, t.title), h('div', { class: 'a' }, t.artist)),
      h('button', { class: 'icon-btn x', title: 'Quitar', onClick: (e) => { e.stopPropagation(); P.queue.splice(k, 1); if (k < P.i) P.i--; P.preloaded = null; renderQueue(); saveQueue(); } }, icon('x', 'sm')));
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/q', String(k)));
    el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = +e.dataTransfer.getData('text/q');
      const cur = P.track; const [m] = P.queue.splice(from, 1); P.queue.splice(k, 0, m); P.i = P.queue.indexOf(cur); P.preloaded = null;
      renderQueue(); saveQueue();
    });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(e, t); });
    return el;
  };
  const start = Math.max(0, P.i - 3);
  const list = P.queue.slice(start, start + 150);
  q.replaceChildren(
    h('div', { class: 'qhead' }, h('b', null, 'Cola'),
      h('button', { class: 'btn sm ghost', title: 'Llenar con recomendaciones según la canción actual', onClick: () => { if (P.track) { P.queue.splice(P.i + 1, 0, ...Brain.radioNext(S.tracks, P.track, 15, new Set(P.queue.map((x) => x.id)))); P.preloaded = null; renderQueue(); } } }, icon('spark', 'sm'), 'Sugerir'),
      h('button', { class: 'btn sm ghost', onClick: () => { P.queue = P.track ? [P.track] : []; P.i = P.track ? 0 : -1; renderQueue(); saveQueue(); } }, 'Limpiar'),
      h('button', { class: 'icon-btn', onClick: toggleQueue }, icon('x', 'sm'))),
    h('div', { class: 'qlist' },
      P.queue.length ? null : h('div', { class: 'empty' }, 'La cola está vacía'),
      list.map((t, k) => [start + k === P.i + 1 ? h('div', { class: 'qlabel' }, 'A continuación') : null, item(t, start + k)]),
      settings.autoRadio ? h('div', { class: 'qlabel' }, '∞ Radio inteligente continuará al terminar') : null),
  );
}

// ======================================================================
// Router
// ======================================================================
const VIEWS = {};
function go(view, arg = null, { replace = false } = {}) {
  closeMenus();
  if (S.view === view && S.arg === arg && !replace) return render(true);
  if (!replace) S.hist.push({ view: S.view, arg: S.arg, scroll: $('#view').scrollTop });
  if (S.hist.length > 60) S.hist.shift();
  S.view = view; S.arg = arg;
  render();
}
function back() {
  const p = S.hist.pop();
  if (!p) return;
  if (p.view !== 'search') $('#search').value = '';
  S.view = p.view; S.arg = p.arg;
  render(false, p.scroll);
}
function render(keepScroll = false, scroll = 0) {
  S.cleanup.splice(0).forEach((f) => { try { f(); } catch { } });
  const v = $('#view');
  const st = v.scrollTop;
  v.replaceChildren();
  v.classList.remove('enter'); void v.offsetWidth; v.classList.add('enter');
  (VIEWS[S.view] || VIEWS.home)(v, S.arg);
  markNav();
  $('#backBtn').style.visibility = S.hist.length ? 'visible' : 'hidden';
  v.scrollTop = keepScroll ? st : scroll;
}

// ======================================================================
// Componentes
// ======================================================================
function placeholder(name, genre, ic = 'disc') {
  return h('div', { class: 'ph', style: { background: genreGradient(genre) } }, ic ? icon(ic) : (name || '?').trim().slice(0, 1).toUpperCase());
}

function albumCard(a) {
  const art = h('div', { class: 'art' });
  const ph = placeholder(a.name, a.genre);
  art.append(ph);
  if (a.coverId) { const img = lazyImg(coverUrl(a.coverId), a.name); img.addEventListener('load', () => ph.remove()); art.prepend(img); }
  art.append(h('button', { class: 'play-fab', title: 'Reproducir', onClick: (e) => { e.stopPropagation(); P.playList(a.tracks); } }, icon('play')));
  const c = h('div', { class: 'card', tabindex: 0, onClick: () => go('album', a.key), onKeydown: (e) => e.key === 'Enter' && go('album', a.key) },
    art, h('div', { class: 'meta' }, h('div', { class: 't' }, a.name), h('div', { class: 's' }, a.artist + (a.year ? ' · ' + a.year : ''))));
  c.addEventListener('contextmenu', (e) => { e.preventDefault(); listMenu(e, a.tracks, { artist: a.artist }); });
  return c;
}

function artistImage(name, art, ph, w = 400, coverId) {
  whenSeen(art, async () => {
    const m = await getArtist(name);
    const u = m && (w > 500 ? m.image : (m.thumb || m.image));
    const src = u ? imgUrl(u, w) : coverId ? coverUrl(coverId) : null;
    if (!src) return;
    const img = lazyImg(src, name);
    img.addEventListener('load', () => ph.remove());
    art.prepend(img);
  });
}

function artistCard(ar) {
  const art = h('div', { class: 'art' });
  const ph = placeholder(ar.name, ar.genre, null);
  art.append(ph);
  artistImage(ar.name, art, ph, 400, ar.coverId);
  art.append(h('button', { class: 'play-fab', title: 'Reproducir', onClick: (e) => { e.stopPropagation(); P.playList(ar.tracks, 0, { shuffle: true }); } }, icon('play')));
  return h('div', { class: 'card round', tabindex: 0, onClick: () => go('artist', ar.name), onKeydown: (e) => e.key === 'Enter' && go('artist', ar.name) },
    art, h('div', { class: 'meta' }, h('div', { class: 't' }, ar.name), h('div', { class: 's' }, `${ar.albums.length} álbum${ar.albums.length === 1 ? '' : 'es'} · ${ar.genre || ''}`)));
}

function genreCard(g) {
  const sub = Object.entries(g.subs).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]).join(' · ');
  return h('div', { class: 'gcard', tabindex: 0, style: { background: genreGradient(g.name) }, onClick: () => go('genre', g.name), onKeydown: (e) => e.key === 'Enter' && go('genre', g.name) },
    h('div', { class: 'stack' }, g.covers.slice(0, 1).map((c) => h('img', { src: coverUrl(c), loading: 'lazy', alt: '' }))),
    h('div', { class: 'gt' }, g.name), h('div', { class: 'gs' }, `${g.tracks.length} canciones${sub ? ' · ' + sub : ''}`));
}

function mixCard(m) {
  const covers = [...new Set(m.tracks.map((t) => t.coverId).filter(Boolean))].slice(0, 4);
  return h('div', { class: 'gcard mix', tabindex: 0, style: { background: genreGradient(m.genre), '--gc': genreColor(m.genre, 22, 60) }, onClick: () => P.playList(m.tracks), onKeydown: (e) => e.key === 'Enter' && P.playList(m.tracks) },
    h('div', { class: 'collage' }, covers.map((c) => h('div', { style: { backgroundImage: `url(${coverUrl(c)})` } }))),
    h('div', { class: 'gt' }, m.name), h('div', { class: 'gs' }, `${m.desc} · ${m.tracks.length} canciones`));
}

// Fila de canción
const COLS = ['#', 'Título', 'Artista', 'Álbum', 'Género', 'Calidad', ''];
function trackRow(t, i, list, opts = {}) {
  const cur = P.track?.id === t.id;
  const r = h('div', { class: 'trow' + (cur ? ' cur' : '') + (t.playable ? '' : ' unplayable'), tabindex: 0, 'data-id': t.id,
    onDblclick: () => P.playList(list, i), onKeydown: (e) => e.key === 'Enter' && P.playList(list, i) },
    h('div', { class: 'n' }, h('span', { class: 'num' }, opts.num ? (t.trackNo || i + 1) : i + 1),
      h('button', { onClick: () => P.playList(list, i), title: 'Reproducir' }, icon('play', 'sm play')), icon('wave', 'sm eq')),
    h('div', { class: 'ttwrap' }, opts.noCover ? null : h('div', { class: 'mini', style: { backgroundImage: t.coverId ? `url(${coverUrl(t.coverId)})` : genreGradient(t.mainGenre) } }),
      h('div', { class: 'cell tt' }, t.title)),
    opts.compact ? null : h('div', { class: 'cell' }, t.artist),
    opts.compact ? null : h('div', { class: 'cell' }, t.album || ''),
    h('div', { class: 'cell c-genre', title: (t.genreTags || []).join(', ') }, t.subGenre || t.mainGenre || ''),
    opts.compact ? null : h('div', { class: 'cell c-q' }, qBadges(t, true)[0] || ''),
    h('div', { class: 'dur' }, fmtTime(t.duration)));
  r.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(e, t); });
  return r;
}

function trackMenu(e, t) {
  contextMenu(e.clientX, e.clientY, [
    { label: 'Reproducir', icon: 'play', run: () => P.playNow(t) },
    { label: 'Reproducir a continuación', icon: 'queue', run: () => P.addNext([t]) },
    { label: 'Agregar a la cola', icon: 'plus', run: () => P.addEnd([t]) },
    { label: 'Iniciar radio inteligente', icon: 'radio', run: () => P.radio(t) },
    '-',
    { label: 'Ir al artista', icon: 'mic', run: () => go('artist', t.albumArtist || t.artist) },
    { label: 'Ir al álbum', icon: 'disc', run: () => go('album', albumKey(t)) },
    { label: Brain.isLoved(t.id) ? 'Quitar de favoritas' : 'Me gusta', icon: 'heart', run: () => toggleLove(t) },
    '-',
    { label: 'Cargar en Deck A', icon: 'dj', run: () => loadDeck(0, t) },
    { label: 'Cargar en Deck B', icon: 'dj', run: () => loadDeck(1, t) },
    { label: 'Mostrar en el explorador', icon: 'folder', run: () => call('app.reveal', { id: t.id }) },
  ]);
}
function listMenu(e, tracks, { artist } = {}) {
  contextMenu(e.clientX, e.clientY, [
    { label: 'Reproducir', icon: 'play', run: () => P.playList(tracks) },
    { label: 'Aleatorio', icon: 'shuffle', run: () => P.playList(tracks, 0, { shuffle: true }) },
    { label: 'Reproducir a continuación', icon: 'queue', run: () => P.addNext(tracks) },
    { label: 'Agregar a la cola', icon: 'plus', run: () => P.addEnd(tracks) },
    artist ? '-' : null, artist ? { label: 'Ir al artista', icon: 'mic', run: () => go('artist', artist) } : null,
  ].filter(Boolean));
}

function trackTable(host, list, opts = {}) {
  const wrap = h('div', { class: 'tracks' + (opts.compact ? ' compact' : '') });
  if (!opts.noHead) wrap.append(h('div', { class: 'trow head' }, (opts.compact ? ['#', 'Título', 'Género', ''] : COLS).map((c) => h('div', { class: c === 'Género' ? 'c-genre' : c === 'Calidad' ? 'c-q' : '' }, c))));
  host.append(wrap);
  if (list.length > 120) {
    const body = h('div'); wrap.append(body);
    const vl = new VirtualList($('#view'), body, 50, (t, i) => trackRow(t, i, list, opts));
    vl.set(list);
    S.cleanup.push(() => vl.destroy());
  } else list.forEach((t, i) => wrap.append(trackRow(t, i, list, opts)));
  return wrap;
}

function segL(options, value, onPick) { // con etiqueta visible
  const el = h('div', { class: 'seg' }, options.map(([v, label, ic]) =>
    h('button', { class: v === value ? 'on' : '', onClick: (e) => { $$('button', el).forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); onPick(v); } }, ic ? icon(ic, 'sm') : null, label)));
  return el;
}
function segI(options, value, onPick) { // solo iconos
  const el = h('div', { class: 'seg' }, options.map(([v, label, ic]) =>
    h('button', { class: v === value ? 'on' : '', title: label, onClick: (e) => { $$('button', el).forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); onPick(v); } }, icon(ic, 'sm'))));
  return el;
}
function sw(on, onToggle) {
  const el = h('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', onClick: () => { el.classList.toggle('on'); onToggle(el.classList.contains('on')); } });
  return el;
}

function emptyLibrary(v) {
  v.append(h('div', { class: 'empty' }, icon('folder'),
    h('h2', null, S.scanning ? 'Escaneando tu música…' : 'Tu biblioteca está vacía'),
    h('p', null, 'Agrega la carpeta donde guardas tu música (FLAC, MP3, M4A, WAV, OGG, OPUS…).'),
    h('button', { class: 'btn primary', onClick: addFolder }, icon('plus', 'sm'), 'Agregar carpeta')));
}
async function addFolder() { try { S.folders = await call('library.addFolder'); toast('Escaneando…'); if (S.view === 'settings') render(true); } catch (e) { toast(e.message); } }

// ======================================================================
// Vistas
// ======================================================================
VIEWS.home = (v) => {
  if (!S.tracks.length) return emptyLibrary(v);
  const hr = new Date().getHours();
  const greet = hr < 6 ? 'Buenas noches' : hr < 12 ? 'Buenos días' : hr < 19 ? 'Buenas tardes' : 'Buenas noches';

  // ---- Sala de escucha (estilo editorial) ----
  const hist0 = Brain.stats().history;
  const lastT = P.track || S.byId.get(hist0[hist0.length - 1]?.id) || S.albums.slice().sort((a, b) => b.added - a.added)[0]?.tracks[0];
  const al = lastT ? S.albumByKey.get(albumKey(lastT)) : null;
  const mixes = Brain.homeMixes(S.tracks);
  const line = hr < 6 ? 'Para la madrugada.' : hr < 12 ? 'Una mañana tranquila.' : hr < 19 ? 'Tu sala de escucha.' : 'Un rincón para la noche.';
  const turntable = al ? h('div', { class: 'room-card lg turntable', tabindex: 0, onClick: () => go('album', al.key), onKeydown: (e) => e.key === 'Enter' && go('album', al.key) },
    h('div', { class: 'tt-art' }, al.coverId ? h('img', { src: coverUrl(al.coverId, 'l'), alt: '' }) : placeholder(al.name, al.genre),
      quality(al.best)?.hires ? h('span', { class: 'tag-new' }, 'Hi-Res') : null),
    h('div', { class: 'tt-body' },
      h('div', { class: 'kicker' }, P.track ? 'En tu tocadiscos' : 'Retoma donde te quedaste'),
      h('div', { class: 'tt-title' }, al.name),
      h('div', { class: 'sub' }, [al.artist, al.year].filter(Boolean).join(' · ')),
      h('button', { class: 'round-btn lg', title: 'Reproducir', onClick: (e) => { e.stopPropagation(); P.playList(al.tracks); } }, icon('play', 'sm')))) : null;
  const coll = h('div', { class: 'room-card lg collection' },
    h('div', { class: 'coll-head' }, h('b', null, 'Tu colección'), h('span', { class: 'sub' }, `${fmtNum(S.albums.length)} discos`)),
    mixes.slice(0, 5).map((m) => h('div', { class: 'coll-row', tabindex: 0, onClick: () => P.playList(m.tracks), onKeydown: (e) => e.key === 'Enter' && P.playList(m.tracks) },
      h('span', { class: 'coll-ic' }, icon(m.id === 'discover' ? 'spark' : m.id === 'favs' ? 'heart' : 'disc', 'sm')),
      h('div', { class: 'coll-txt' }, h('div', { class: 't' }, m.name), h('div', { class: 'sub' }, `${m.tracks.length} canciones · ${m.desc}`)),
      icon('back', 'sm chev'))),
    h('button', { class: 'coll-row dj-row', onClick: () => go('dj') },
      h('span', { class: 'coll-ic' }, icon('dj', 'sm')),
      h('div', { class: 'coll-txt' }, h('div', { class: 't' }, 'Sesión de DJ'), h('div', { class: 'sub' }, 'Mezclas automáticas por BPM y tonalidad')),
      icon('back', 'sm chev')));
  v.append(h('section', { class: 'room' },
    h('div', { class: 'kicker' }, 'sonora. · ' + greet.toLowerCase()),
    h('h1', { class: 'display' }, line),
    h('div', { class: 'room-grid' }, turntable, coll)));
  // Recientes desde el historial
  const hist = Brain.stats().history.slice(-200).reverse();
  const seen = new Set(), recent = [];
  for (const x of hist) { const t = S.byId.get(x.id); if (!t) continue; const k = albumKey(t); if (seen.has(k)) continue; seen.add(k); recent.push(S.albumByKey.get(k)); if (recent.length >= 12) break; }
  if (recent.length) v.append(h('h2', { class: 'sec' }, 'Escuchado recientemente'), h('div', { class: 'shelf' }, recent.map(albumCard)));

  const added = S.albums.slice().sort((a, b) => b.added - a.added).slice(0, 14);
  v.append(h('h2', { class: 'sec' }, 'Agregado recientemente', h('button', { class: 'more', onClick: () => { set('albumSort', 'added'); go('albums'); } }, 'Ver todo')), h('div', { class: 'shelf' }, added.map(albumCard)));

  v.append(h('h2', { class: 'sec' }, 'Explora por género', h('button', { class: 'more', onClick: () => go('genres') }, 'Todos')),
    h('div', { class: 'grid big', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '14px' } }, S.genres.slice(0, 8).map(genreCard)));
};

VIEWS.albums = (v) => {
  if (!S.tracks.length) return emptyLibrary(v);
  const sorts = { artist: (a, b) => a.artist.localeCompare(b.artist) || (a.year - b.year), name: (a, b) => a.name.localeCompare(b.name), year: (a, b) => (b.year || 0) - (a.year || 0), added: (a, b) => b.added - a.added, genre: (a, b) => (a.genre || '').localeCompare(b.genre || '') };
  const list = S.albums.slice().sort(sorts[settings.albumSort] || sorts.artist);
  const sel = h('select', { onChange: (e) => { set('albumSort', e.target.value); render(); } },
    [['artist', 'Artista'], ['name', 'Título'], ['year', 'Año'], ['added', 'Recientes'], ['genre', 'Género']].map(([k, l]) => h('option', { value: k, selected: settings.albumSort === k }, l)));
  v.append(h('div', { class: 'head-row' }, h('div', null, h('h1', { class: 'title' }, 'Álbumes'), h('div', { class: 'sub' }, `${list.length} álbumes`)), h('div', { class: 'spacer' }), sel,
    segI([['grid', 'Cuadrícula', 'grid'], ['list', 'Lista', 'rows'], ['wall', 'Muro de portadas', 'wall'], ['flow', 'Carrusel 3D', 'flow']], settings.albumView, (m) => { set('albumView', m); render(); })));
  const mode = settings.albumView;
  if (mode === 'list') {
    v.append(h('div', { class: 'alist' }, list.map((a) => h('div', { class: 'arow', tabindex: 0, onClick: () => go('album', a.key), onKeydown: (e) => e.key === 'Enter' && go('album', a.key) },
      h('div', { class: 'art' }, a.coverId ? lazyImg(coverUrl(a.coverId)) : placeholder(a.name, a.genre)),
      h('div', { style: { minWidth: 0 } }, h('div', { style: { fontWeight: 600 } }, a.name), h('div', { class: 'sub', style: { fontSize: '13px' } }, a.artist)),
      h('div', { class: 'sub' }, a.genre || ''), h('div', { class: 'sub' }, a.year || ''), h('div', { class: 'sub', style: { textAlign: 'right' } }, `${a.tracks.length} · ${fmtLong(a.duration)}`)))));
  } else if (mode === 'flow') {
    coverflow(v, list);
  } else {
    v.append(h('div', { class: 'grid' + (mode === 'wall' ? ' wall' : '') }, list.map(albumCard)));
  }
};

function coverflow(v, list) {
  let idx = Math.max(0, list.findIndex((a) => P.track && a.key === albumKey(P.track)));
  const stage = h('div', { class: 'flow', tabindex: 0 });
  const cap = h('div', { class: 'flow-cap' });
  const items = new Map();
  const draw = () => {
    const lo = Math.max(0, idx - 7), hi = Math.min(list.length, idx + 8);
    for (const [k, el] of items) if (k < lo || k >= hi) { el.remove(); items.delete(k); }
    for (let k = lo; k < hi; k++) {
      let el = items.get(k);
      if (!el) {
        const a = list[k];
        el = h('div', { class: 'fi', onClick: () => (k === idx ? go('album', a.key) : ((idx = k), draw())) }, a.coverId ? h('img', { src: coverUrl(a.coverId, 'l'), alt: '' }) : placeholder(a.name, a.genre));
        items.set(k, el); stage.append(el);
      }
      const d = k - idx, ad = Math.abs(d);
      el.style.transform = d === 0 ? 'translateZ(80px)' : `translateX(${Math.sign(d) * (180 + ad * 110)}px) translateZ(${-ad * 60}px) rotateY(${-Math.sign(d) * 55}deg)`;
      el.style.zIndex = 100 - ad; el.style.opacity = ad > 6 ? 0 : 1; el.style.filter = d ? `brightness(${1 - ad * 0.1})` : '';
    }
    const a = list[idx];
    cap.replaceChildren(h('div', { class: 't' }, a.name), h('div', { class: 'sub' }, `${a.artist}${a.year ? ' · ' + a.year : ''}`),
      h('div', { class: 'chips', style: { justifyContent: 'center', marginTop: '12px' } }, h('button', { class: 'btn primary sm', onClick: () => P.playList(a.tracks) }, icon('play', 'sm'), 'Reproducir')));
  };
  stage.addEventListener('wheel', (e) => { e.preventDefault(); idx = Math.max(0, Math.min(list.length - 1, idx + (e.deltaY > 0 || e.deltaX > 0 ? 1 : -1))); draw(); }, { passive: false });
  stage.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { idx = Math.min(list.length - 1, idx + 1); draw(); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowLeft') { idx = Math.max(0, idx - 1); draw(); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'Enter') go('album', list[idx].key);
  });
  v.append(stage, cap);
  draw();
  setTimeout(() => stage.focus({ preventScroll: true }), 50);
}

VIEWS.album = (v, key) => {
  const a = S.albumByKey.get(key);
  if (!a) return v.append(h('div', { class: 'empty' }, 'Álbum no encontrado'));
  const q = quality(a.best);
  const desc = h('div', { class: 'bio clamp' });
  const descSrc = h('div', { class: 'bio-src' });
  const tagsEl = h('div', { class: 'chips' });
  // Lista estilo editorial: 01 · título / artista · duración
  const list = h('div', { class: 'crate-list' });
  const discs = [...new Set(a.tracks.map((t) => t.discNo || 1))].sort((x, y) => x - y);
  for (const d of discs) {
    if (discs.length > 1) list.append(h('div', { class: 'crate-disc' }, 'Disco ' + d));
    a.tracks.filter((t) => (t.discNo || 1) === d).forEach((t) => {
      const i = a.tracks.indexOf(t);
      const row = h('div', { class: 'crate-row trow' + (P.track?.id === t.id ? ' cur' : '') + (t.playable ? '' : ' unplayable'), tabindex: 0, 'data-id': t.id,
        onClick: () => P.playList(a.tracks, i), onKeydown: (e) => e.key === 'Enter' && P.playList(a.tracks, i) },
        h('span', { class: 'cn' }, String(t.trackNo || i + 1).padStart(2, '0')),
        h('div', { class: 'ct' }, h('div', { class: 'tt' }, t.title), h('div', { class: 'sub' }, t.artist)),
        h('span', { class: 'cd' }, fmtTime(t.duration)));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); trackMenu(e, t); });
      list.append(row);
    });
  }
  const side = a.tracks.length > 6 ? 'Lado A + B' : 'Lado A';
  v.append(h('section', { class: 'record' },
    h('div', { class: 'record-art' },
      h('div', { class: 'cover' }, a.coverId ? h('img', { src: coverUrl(a.coverId, 'l'), alt: '', onClick: () => zoom(coverUrl(a.coverId, 'l')) }) : placeholder(a.name, a.genre)),
      q ? h('div', { class: 'sticker s1' }, h('b', null, q.hires ? 'Hi-Res' : q.fmt), h('small', null, q.label), h('i', { class: 'dotrec' })) : null,
      h('div', { class: 'sticker s2' }, a.coverId ? h('img', { src: coverUrl(a.coverId), alt: '' }) : null, h('small', null, `${side} / ${a.genre || 'tu colección'}`))),
    h('div', { class: 'record-info' },
      h('div', { class: 'kicker' }, 'De tu colección'),
      h('h1', { class: 'display fit', style: { '--lw': Math.max(6, ...a.name.split(/\s+/).map((w) => w.length)) } }, a.name),
      h('div', { class: 'meta' },
        h('a', { href: '#', onClick: (e) => { e.preventDefault(); go('artist', a.artist); } }, a.artist),
        h('span', null, ` · ${a.tracks.length} canciones · ${fmtLong(a.duration)}${a.year ? ' · ' + a.year : ''}`)),
      list,
      h('button', { class: 'pill-cta lg', onClick: () => P.playList(a.tracks) }, icon('play', 'sm'), 'Reproducir álbum'),
      h('div', { class: 'record-foot' },
        h('span', { class: 'sub' }, q ? `${q.lossless ? 'Audio sin pérdida' : 'Audio comprimido'} · ${q.fmt} ${q.label}` : ''),
        h('div', { class: 'chips' },
          h('button', { class: 'round-btn lg', title: 'Aleatorio', onClick: () => P.playList(a.tracks, 0, { shuffle: true }) }, icon('shuffle', 'sm')),
          h('button', { class: 'round-btn lg', title: 'Agregar a la cola', onClick: () => P.addEnd(a.tracks) }, icon('plus', 'sm')),
          h('button', { class: 'round-btn lg', title: 'Radio inteligente', onClick: () => P.radio(a.tracks[0]) }, icon('radio', 'sm')))))));
  v.append(h('div', { class: 'about' }, h('h2', { class: 'sec' }, 'Sobre el álbum'), tagsEl, h('div', { style: { height: '12px' } }), desc, descSrc));
  desc.textContent = 'Cargando…';
  call('meta.album', { artist: a.artist, album: a.name }).then((m) => {
    if (!desc.isConnected) return;
    desc.textContent = m?.description || 'Sin descripción disponible.';
    if (m?.source) descSrc.textContent = 'Fuente: ' + m.source;
    if ((m?.description || '').length > 400) desc.after(h('button', { class: 'btn sm ghost', style: { marginTop: '8px' }, onClick: (e) => { desc.classList.toggle('clamp'); e.currentTarget.textContent = desc.classList.contains('clamp') ? 'Leer más' : 'Leer menos'; } }, 'Leer más'));
    else desc.classList.remove('clamp');
    const tags = [...new Set([...(m?.tags || []), m?.style, m?.mood, m?.label, m?.released].filter(Boolean))];
    tagsEl.replaceChildren(...tags.map((x) => h('span', { class: 'chip' }, x)));
    if (m?.listeners) tagsEl.append(h('span', { class: 'chip' }, fmtNum(m.listeners) + ' oyentes en Last.fm'));
  }).catch(() => (desc.textContent = 'Sin descripción disponible.'));
};

VIEWS.artists = (v) => {
  if (!S.tracks.length) return emptyLibrary(v);
  const sorts = { name: (a, b) => a.name.localeCompare(b.name), tracks: (a, b) => b.tracks.length - a.tracks.length, plays: (a, b) => Brain.affinity('artists', b.name) - Brain.affinity('artists', a.name) };
  const list = S.artists.slice().sort(sorts[settings.artistSort] || sorts.name);
  v.append(h('div', { class: 'head-row' }, h('div', null, h('h1', { class: 'title' }, 'Artistas'), h('div', { class: 'sub' }, `${list.length} artistas`)), h('div', { class: 'spacer' }),
    segL([['name', 'A–Z'], ['tracks', 'Más música'], ['plays', 'Tus favoritos']], settings.artistSort, (m) => { set('artistSort', m); render(); })));
  v.append(h('div', { class: 'grid' }, list.map(artistCard)));
};

VIEWS.artist = (v, name) => {
  const ar = artistOf(name);
  if (!ar) return v.append(h('div', { class: 'empty' }, 'Artista no encontrado'));
  const bg = h('div', { class: 'hbg', style: { background: genreGradient(ar.genre) } });
  const portrait = h('div', { class: 'portrait' }, placeholder(name, ar.genre, null));
  const titleSlot = h('div', null, h('h1', null, name));
  const stats = h('div', { class: 'stats' }, h('span', null, `${ar.albums.length} álbumes · ${ar.tracks.length} canciones`), ar.genre ? h('span', null, ar.genre) : null);
  const bio = h('div', { class: 'bio clamp' }, 'Cargando biografía…');
  const bioSrc = h('div', { class: 'bio-src' });
  const tags = h('div', { class: 'chips' });
  const similar = h('div', { class: 'chips' });
  const gallery = h('div', { class: 'gallery' });
  const st = Brain.stats().tracks;
  const popular = ar.tracks.slice().sort((a, b) => ((st[b.id]?.c || 0) + (st[b.id]?.p || 0)) - ((st[a.id]?.c || 0) + (st[a.id]?.p || 0))).slice(0, 8);
  v.append(h('section', { class: 'hero' }, bg, portrait,
    h('div', { class: 'info' }, h('div', { class: 'kicker' }, 'Artista'), titleSlot, stats,
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onClick: () => P.playList(ar.tracks, 0, { shuffle: true }) }, icon('play', 'sm'), 'Reproducir'),
        h('button', { class: 'btn', onClick: () => P.radio(popular[0] || ar.tracks[0]) }, icon('radio', 'sm'), 'Radio del artista'),
        h('button', { class: 'btn ghost', title: 'Volver a descargar fotos y biografía', onClick: () => { artistMeta.delete(name); call('meta.artist', { name, force: true }).then(() => render(true)); } }, icon('refresh', 'sm'))))));
  const left = h('div', null, h('h2', { class: 'sec', style: { marginTop: '8px' } }, 'Populares en tu biblioteca'));
  trackTable(left, popular, { compact: true, noHead: true });
  left.append(h('h2', { class: 'sec' }, 'Discografía'), h('div', { class: 'grid' }, ar.albums.map(albumCard)));
  const right = h('div', null, h('h2', { class: 'sec', style: { marginTop: '8px' } }, 'Biografía'), bio, bioSrc,
    h('h2', { class: 'sec' }, 'Etiquetas'), tags, h('h2', { class: 'sec' }, 'Artistas similares'), similar);
  v.append(h('div', { class: 'two-col' }, left, right), h('h2', { class: 'sec' }, icon('image'), 'Galería'), gallery);

  getArtist(name).then((m) => {
    if (!bio.isConnected) return;
    if (!m) { bio.textContent = 'No se encontró información (¿sin conexión?).'; return; }
    const fan = m.fanarts?.[0];
    if (fan) { const img = new Image(); img.onload = () => (bg.style.background = `center 25% / cover no-repeat url("${img.src}")`); img.src = imgUrl(fan, 1920); }
    else if (m.image) softBlur(imgUrl(m.image, 400), 70).then((u) => u && (bg.style.background = `center / cover no-repeat url(${u})`));
    if (m.image) portrait.replaceChildren(h('img', { src: imgUrl(m.image, 600), alt: name, style: { cursor: 'zoom-in' }, onClick: () => zoom(imgUrl(m.image)) }));
    if (m.logo) titleSlot.replaceChildren(h('img', { class: 'logo-img', src: imgUrl(m.logo, 800), alt: name, onError: (e) => e.target.replaceWith(h('h1', null, name)) }));
    const extra = [m.country, m.formed ? 'Desde ' + m.formed : null, m.listeners ? fmtNum(m.listeners) + ' oyentes' : null, m.userPlaycount ? fmtNum(m.userPlaycount) + ' de tus scrobbles' : null, m.fans ? fmtNum(m.fans) + ' fans en Deezer' : null].filter(Boolean);
    stats.append(...extra.map((x) => h('span', null, x)));
    bio.textContent = m.bio || 'Sin biografía disponible.';
    if (m.bioSource) bioSrc.textContent = 'Fuente: ' + m.bioSource;
    if ((m.bio || '').length > 500) bio.after(h('button', { class: 'btn sm ghost', style: { marginTop: '8px' }, onClick: (e) => { bio.classList.toggle('clamp'); e.currentTarget.textContent = bio.classList.contains('clamp') ? 'Leer más' : 'Leer menos'; } }, 'Leer más'));
    else bio.classList.remove('clamp');
    const tg = [...new Set([m.genre, m.style, m.mood, ...(m.tags || [])].filter(Boolean))];
    tags.replaceChildren(...tg.map((x) => h('span', { class: 'chip' }, x)));
    similar.replaceChildren(...(m.similar || []).map((s) => {
      const inLib = artistOf(s);
      return inLib ? h('button', { class: 'chip on', onClick: () => go('artist', s) }, s) : h('span', { class: 'chip', title: 'No está en tu biblioteca' }, s);
    }));
    if (!m.similar?.length) similar.append(h('span', { class: 'sub' }, S.lastfm.hasKey ? 'Sin datos' : 'Conecta Last.fm en Ajustes para ver similares'));
    const pics = [...(m.fanarts || [])];
    if (!pics.length) gallery.previousSibling.remove(), gallery.remove();
    else gallery.replaceChildren(...pics.map((u) => h('div', { class: 'g', onClick: () => zoom(imgUrl(u)) }, lazyImg(imgUrl(u, 800)))));
  });
};

function zoom(src) {
  const m = h('div', { class: 'modal-bg', onClick: () => m.remove() }, h('img', { src, alt: '' }));
  document.body.append(m);
}

VIEWS.songs = (v) => {
  if (!S.tracks.length) return emptyLibrary(v);
  const keyF = {
    artist: (t) => [t.albumArtist || t.artist, t.year, t.album, t.discNo, t.trackNo], title: (t) => [t.title], album: (t) => [t.album, t.discNo, t.trackNo],
    genre: (t) => [t.mainGenre, t.subGenre, t.artist], dur: (t) => [t.duration], added: (t) => [-t.added], quality: (t) => [-(t.bitDepth || 0), -(t.sampleRate || 0)],
  };
  const f = keyF[settings.songSort] || keyF.artist, dir = settings.songDir;
  const cmp = (a, b) => { const x = f(a), y = f(b); for (let i = 0; i < x.length; i++) { const p = x[i] ?? '', q = y[i] ?? ''; const c = typeof p === 'number' && typeof q === 'number' ? p - q : String(p).localeCompare(String(q)); if (c) return c * dir; } return 0; };
  const list = S.tracks.slice().sort(cmp);
  const total = list.reduce((s, t) => s + (t.duration || 0), 0);
  v.append(h('div', { class: 'head-row' },
    h('div', null, h('h1', { class: 'title' }, 'Canciones'), h('div', { class: 'sub' }, `${fmtNum(list.length)} canciones · ${fmtLong(total)}`)), h('div', { class: 'spacer' }),
    h('select', { onChange: (e) => { set('songSort', e.target.value); render(); } },
      [['artist', 'Artista'], ['title', 'Título'], ['album', 'Álbum'], ['genre', 'Género'], ['added', 'Recientes'], ['quality', 'Calidad'], ['dur', 'Duración']].map(([k, l]) => h('option', { value: k, selected: settings.songSort === k }, l))),
    h('button', { class: 'icon-btn', title: 'Invertir orden', onClick: () => { set('songDir', -settings.songDir); render(); } }, icon('refresh', 'sm')),
    h('button', { class: 'btn primary', onClick: () => P.playList(list, 0, { shuffle: true }) }, icon('shuffle', 'sm'), 'Aleatorio')));
  trackTable(v, list);
};

VIEWS.genres = (v) => {
  if (!S.tracks.length) return emptyLibrary(v);
  const unc = S.genres.find((g) => g.name === 'Sin clasificar');
  v.append(h('div', { class: 'head-row' }, h('div', null, h('h1', { class: 'title' }, 'Géneros'),
    h('div', { class: 'sub' }, `${S.genres.length} géneros detectados automáticamente`)), h('div', { class: 'spacer' }),
    h('button', { class: 'btn', title: 'Consulta Last.fm y TheAudioDB para clasificar con precisión', onClick: () => analyzeGenres(false) }, icon('spark', 'sm'), 'Analizar géneros')));
  if (unc && unc.tracks.length > S.tracks.length * 0.2) v.append(h('div', { class: 'panel', style: { marginBottom: '18px' } },
    h('b', null, `${unc.tracks.length} canciones sin clasificar. `), h('span', { class: 'sub' }, 'Pulsa «Analizar géneros» para que Sonora las clasifique con las etiquetas de Last.fm y TheAudioDB (mejor si configuras tu API key de Last.fm).')));
  v.append(h('div', { class: 'grid big', style: { gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: '14px' } }, S.genres.map(genreCard)));
};
function analyzeGenres(deep) { call('genre.analyze', { deep }).then(() => toast('Analizando géneros en segundo plano…')).catch((e) => toast(e.message)); }

VIEWS.genre = (v, name) => {
  const g = S.genres.find((x) => x.name === name);
  if (!g) return v.append(h('div', { class: 'empty' }, 'Género no encontrado'));
  let subFilter = null;
  const subs = Object.entries(g.subs).sort((a, b) => b[1] - a[1]);
  const body = h('div');
  const draw = () => {
    const tracks = subFilter ? g.tracks.filter((t) => t.subGenre === subFilter) : g.tracks;
    const albums = [...new Set(tracks.map(albumKey))].map((k) => S.albumByKey.get(k));
    body.replaceChildren(h('h2', { class: 'sec' }, 'Álbumes'), h('div', { class: 'grid' }, albums.map(albumCard)), h('h2', { class: 'sec' }, 'Canciones'));
    trackTable(body, tracks);
  };
  const aff = Brain.affinity('genres', name);
  v.append(h('section', { class: 'hero', style: { minHeight: '280px' } },
    h('div', { class: 'hbg', style: { background: genreGradient(name), animation: 'none' } }),
    h('div', { class: 'info' }, h('div', { class: 'kicker' }, 'Género'), h('h1', null, name),
      h('div', { class: 'stats' }, h('span', null, `${g.tracks.length} canciones · ${new Set(g.tracks.map((t) => t.albumArtist)).size} artistas`), aff ? h('span', null, `Afinidad: ${aff > 0 ? '+' : ''}${aff.toFixed(1)}`) : null),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary', onClick: () => P.playList(Brain.recommend(g.tracks.filter((t) => !subFilter || t.subGenre === subFilter), 40)) }, icon('spark', 'sm'), 'Mix inteligente'),
        h('button', { class: 'btn', style: { background: 'rgba(255,255,255,.16)', color: '#fff' }, onClick: () => P.playList(g.tracks, 0, { shuffle: true }) }, icon('shuffle', 'sm'), 'Aleatorio')))));
  if (subs.length) {
    const chips = h('div', { class: 'chips', style: { margin: '6px 0 4px' } });
    const mk = (s, label, n) => h('button', { class: 'chip' + (subFilter === s ? ' on' : ''), onClick: (e) => { subFilter = s; $$('.chip', chips).forEach((c) => c.classList.remove('on')); e.currentTarget.classList.add('on'); draw(); } }, label, n != null ? h('span', { style: { opacity: .6 } }, ' ' + n) : null);
    chips.append(mk(null, 'Todo'), ...subs.slice(0, 30).map(([s, n]) => mk(s, s, n)));
    v.append(chips);
  }
  v.append(body);
  draw();
};

VIEWS.search = (v, q) => {
  const words = norm(q).split(/\s+/).filter(Boolean);
  if (!words.length) return;
  const tracks = S.tracks.filter((t) => Brain.searchScore(t, words));
  const artists = S.artists.filter((a) => words.every((w) => norm(a.name).includes(w))).slice(0, 12);
  const albums = S.albums.filter((a) => words.every((w) => norm(a.name + ' ' + a.artist).includes(w))).slice(0, 18);
  const genres = S.genres.filter((g) => words.every((w) => norm(g.name + ' ' + Object.keys(g.subs).join(' ')).includes(w)));
  v.append(h('h1', { class: 'title' }, `Resultados para «${q}»`));
  if (!tracks.length && !artists.length && !albums.length) v.append(h('div', { class: 'empty' }, icon('search'), h('h2', null, 'Sin resultados'), 'Prueba con otras palabras.'));
  if (artists.length) v.append(h('h2', { class: 'sec' }, 'Artistas'), h('div', { class: 'shelf' }, artists.map(artistCard)));
  if (albums.length) v.append(h('h2', { class: 'sec' }, 'Álbumes'), h('div', { class: 'shelf' }, albums.map(albumCard)));
  if (genres.length) v.append(h('h2', { class: 'sec' }, 'Géneros'), h('div', { class: 'shelf wide' }, genres.map(genreCard)));
  if (tracks.length) { v.append(h('h2', { class: 'sec' }, `Canciones (${tracks.length})`)); trackTable(v, tracks.slice(0, 500)); }
};

// ---------- Reproduciendo (inmersivo) ----------
VIEWS.now = (v) => {
  const t = P.track;
  if (!t) return v.append(h('div', { class: 'empty' }, icon('music'), h('h2', null, 'No hay nada sonando'),
    h('button', { class: 'btn primary', onClick: () => P.playList(Brain.recommend(S.tracks, 30)) }, icon('spark', 'sm'), 'Sorpréndeme')));
  const mode = settings.npMode;
  const wrap = h('div', { class: 'nowp' + (mode === 'viz' ? ' viz-full' : '') });
  const nbg = h('div', { class: 'nbg blurred', style: { background: genreGradient(t.mainGenre) } });
  if (t.coverId) softBlur(coverUrl(t.coverId, 's'), 70).then((u) => { if (u && nbg.classList.contains('blurred')) nbg.style.background = `center/cover url(${u})`; });
  wrap.append(nbg);
  wrap.append(h('div', { class: 'modes' }, segL([['cover', 'Portada', 'disc'], ['artist', 'Artista', 'mic'], ['viz', 'Visualizador', 'wave'], ['lyrics', 'Letras', 'lyrics']], mode, (m) => { set('npMode', m); render(true); })));
  const q = quality(t);
  const info = h('div', { class: 'ninfo' },
    h('div', { class: 'kicker' }, 'Sonando ahora'),
    h('h1', null, t.title),
    h('div', { class: 'ar', onClick: () => go('artist', t.albumArtist || t.artist) }, t.artist),
    h('div', { class: 'al', onClick: () => go('album', albumKey(t)) }, [t.album, t.year].filter(Boolean).join(' · ')),
    h('div', { class: 'chips', style: { marginTop: '16px' } },
      t.mainGenre ? h('button', { class: 'chip', onClick: () => go('genre', t.mainGenre) }, t.mainGenre) : null,
      t.subGenre ? h('span', { class: 'chip' }, t.subGenre) : null,
      q ? h('span', { class: 'chip' }, `${q.fmt} · ${q.label}`) : null,
      t.bpm ? h('span', { class: 'chip' }, `${Math.round(t.bpm)} BPM`) : null,
      engine ? h('span', { class: 'chip', title: 'Frecuencia de salida del motor de audio' }, `Salida ${engine.ctx.sampleRate / 1000} kHz`) : null));
  // Panel de reproducción con forma de onda (como la hoja del concepto)
  if (mode !== 'lyrics') {
    const nwave = waveScrubber({ cls: 'big', bars: 56, onChange: (x) => engine.seek(x * engine.duration) });
    nwave.setWave(t.dj?.wave);
    const t0 = h('span'), t1 = h('span');
    const nplay = h('button', { class: 'round-btn solid', title: 'Reproducir / Pausa', onClick: () => togglePlay() }, icon('play', 'sm'));
    const chip = h('span', { class: 'chip live-chip' }, h('i'), 'Sonando');
    info.append(h('div', { class: 'np-sheet lg' }, nwave, h('div', { class: 'np-times' }, t0, t1),
      h('div', { class: 'np-ctrls' }, h('button', { class: 'round-btn', onClick: () => P.prev() }, icon('prev', 'sm')), nplay, h('button', { class: 'round-btn', onClick: () => P.next() }, icon('next', 'sm'))), chip));
    const tick = () => { const d = engine.duration || t.duration; nwave.set(d ? engine.time / d : 0); t0.textContent = fmtTime(engine.time); t1.textContent = fmtTime(d); setIcon(nplay.firstChild, engine.playing ? 'pause' : 'play'); chip.classList.toggle('off', !engine.playing); chip.lastChild.textContent = engine.playing ? 'Sonando' : 'En pausa'; };
    tick();
    const iv = setInterval(tick, 250);
    const onWave = () => nwave.setWave(P.track?.dj?.wave);
    document.addEventListener('wave', onWave);
    S.cleanup.push(() => { clearInterval(iv); document.removeEventListener('wave', onWave); });
  }
  const stage = h('div', { class: 'stage' });
  wrap.append(stage);
  if (mode === 'cover' || mode === 'viz') {
    if (mode === 'cover') stage.append(h('div', { class: 'bigart' }, t.coverId ? h('img', { src: coverUrl(t.coverId, 'l'), alt: '' }) : placeholder(t.title, t.mainGenre, 'music')));
    stage.append(info);
  } else if (mode === 'artist') {
    nbg.classList.remove('blurred'); nbg.classList.add('fan');
    const snip = h('div', { class: 'bio-snip' });
    info.append(snip);
    stage.append(info);
    getArtist(t.albumArtist || t.artist).then((m) => {
      if (!m || !wrap.isConnected) return;
      const pics = (m.fanarts?.length ? m.fanarts : [m.image]).filter(Boolean);
      if (m.bio) snip.textContent = m.bio.slice(0, 600);
      if (!pics.length) { nbg.classList.add('blurred'); if (t.coverId) softBlur(coverUrl(t.coverId, 's'), 70).then((u) => u && (nbg.style.background = `center/cover url(${u})`)); return; }
      let k = 0;
      // Fundido entre fotos (sin animación continua: con dibujo por software el Ken Burns costaba ~115 % de CPU)
      const layerB = h('div', { class: 'nbg fan', style: { opacity: 0 } });
      nbg.after(layerB);
      let front = nbg, back = layerB;
      const show = () => {
        const img = new Image();
        img.onload = () => {
          if (front.style.backgroundImage) { back.style.backgroundImage = `url("${img.src}")`; back.style.opacity = 1; front.style.opacity = 0; [front, back] = [back, front]; }
          else front.style.backgroundImage = `url("${img.src}")`;
        };
        img.src = imgUrl(pics[k++ % pics.length], Math.min(1920, Math.round(innerWidth * devicePixelRatio)));
      };
      show();
      if (pics.length > 1) { const iv = setInterval(show, 14000); S.cleanup.push(() => clearInterval(iv)); }
    });
  } else if (mode === 'lyrics') {
    const box = h('div', { class: 'lyrics' }, h('p', { class: 'on' }, t.lrc ? 'Cargando letra…' : 'No hay letra para esta canción'));
    stage.append(box);
    call('lyrics', { id: t.id }).then((txt) => { if (txt) showLyrics(box, txt); else box.replaceChildren(h('p', { class: 'on' }, 'No hay letra para esta canción'), h('p', { style: { fontSize: '16px' } }, 'Coloca un archivo .lrc con el mismo nombre que el audio para ver letras sincronizadas.')); });
  }
  if (settings.visualizer && !settings.gameMode && mode !== 'lyrics') {
    const cv = h('canvas', { class: 'viz' });
    wrap.append(cv);
    startViz(cv, mode === 'viz');
  }
  v.append(wrap);
};

function showLyrics(box, txt) {
  const lines = [];
  for (const raw of txt.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:[.:]\d+)?)\]/g)];
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) lines.push({ t: +m[1] * 60 + parseFloat(m[2].replace(':', '.')), text });
  }
  if (!lines.length) { box.classList.add('plain'); box.replaceChildren(...txt.split(/\r?\n/).map((l) => h('p', null, l || ' '))); return; }
  lines.sort((a, b) => a.t - b.t);
  const ps = lines.map((l) => h('p', { onClick: () => engine.seek(l.t) }, l.text || '♪'));
  box.replaceChildren(...ps);
  let last = -1;
  const tick = () => {
    const t = engine.time + 0.25;
    let i = lines.findIndex((l) => l.t > t) - 1;
    if (i < -1) i = lines.length - 1;
    if (i === -2) i = lines.length - 1;
    if (i !== last) {
      ps[last]?.classList.remove('on'); last = i;
      if (ps[i]) { ps[i].classList.add('on'); box.scrollTo({ top: ps[i].offsetTop - box.clientHeight / 2 + ps[i].clientHeight / 2, behavior: 'smooth' }); }
    }
  };
  const iv = setInterval(tick, 200);
  S.cleanup.push(() => clearInterval(iv));
}

// Visualizador de espectro (solo corre cuando es visible)
function startViz(cv, full) {
  // Ligero: 30 fps, lienzo a media resolución (CSS lo escala) y sin trabajo cuando no suena nada
  const ctx = cv.getContext('2d', { alpha: true });
  const data = new Uint8Array(engine.analyser.frequencyBinCount);
  const N = full ? 96 : 72;
  const sr = engine.ctx.sampleRate, bins = data.length;
  const edges = Array.from({ length: N + 1 }, (_, i) => Math.min(bins - 1, Math.round((30 * Math.pow(16000 / 30, i / N)) / (sr / 2) * bins)));
  const peaks = new Float32Array(N);
  const SCALE = 0.5, FRAME = 1000 / 30;
  let raf, last = 0, grad = null, gradKey = '', idle = 0;
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    if (document.hidden || now - last < FRAME) return;
    last = now;
    const W = Math.max(1, Math.round(cv.clientWidth * SCALE)), H = Math.max(1, Math.round(cv.clientHeight * SCALE));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; gradKey = ''; }
    // Si está en pausa y las barras ya cayeron, no se redibuja (cero costo)
    if (!engine.playing) { if (++idle > 40) return; } else idle = 0;
    const key = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() + W + 'x' + H;
    if (key !== gradKey) {
      gradKey = key;
      const st = getComputedStyle(document.documentElement);
      grad = ctx.createLinearGradient(0, H, 0, H * (full ? 0.1 : 0.2));
      grad.addColorStop(0, st.getPropertyValue('--accent').trim() || '#0a84ff');
      grad.addColorStop(1, st.getPropertyValue('--accent2').trim() || '#409cff');
    }
    engine.spectrum(data);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = grad;
    const bw = W / N;
    for (let i = 0; i < N; i++) {
      let m = 0;
      for (let k = edges[i]; k <= Math.max(edges[i], edges[i + 1] - 1); k++) m = Math.max(m, data[k]);
      const v = Math.pow(m / 255, 1.6);
      peaks[i] = Math.max(v, peaks[i] - 0.02);
      const bh = v * H * (full ? 0.85 : 0.9);
      const x = i * bw + bw * 0.18, w = bw * 0.64;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, H - bh, w, bh);
      if (peaks[i] > 0.03) { ctx.globalAlpha = 0.5; ctx.fillRect(x, H - peaks[i] * H * 0.9 - 2, w, 1); }
    }
  };
  raf = requestAnimationFrame(draw);
  S.cleanup.push(() => cancelAnimationFrame(raf));
}
// ---------- Archivos por convertir (DSD / ALAC → FLAC) ----------
VIEWS.convert = (v) => {
  const list = S.tracks.filter((t) => !t.playable);
  const head = h('div', { class: 'head-row' },
    h('div', null, h('h1', { class: 'title' }, 'Por convertir'),
      h('div', { class: 'sub' }, list.length ? `${list.length} archivos que el motor de audio no reproduce` : 'Todo tu música ya se puede reproducir')),
    h('div', { class: 'spacer' }));
  v.append(head);
  if (!list.length) { v.append(h('div', { class: 'empty' }, icon('music'), h('h2', null, '¡Listo!'), 'No queda nada por convertir.')); return; }
  const prog = h('div', { class: 'sub conv-prog' });
  const btn = h('button', { class: 'btn primary', onClick: async () => {
    const ok = await call('convert.start', { ids: list.map((t) => t.id) }).catch((e) => { toast(e.message); return false; });
    if (ok) { btn.disabled = true; btn.textContent = 'Convirtiendo…'; } else toast('Ya hay una conversión en curso');
  } }, icon('refresh', 'sm'), 'Convertir todo a FLAC');
  head.append(btn);
  call('convert.status').then((st) => {
    if (!st?.ffmpeg) { btn.disabled = true; prog.textContent = 'No encontré ffmpeg. Instálalo con «winget install Gyan.FFmpeg» y vuelve a abrir Sonora.'; }
    else if (st.running) { btn.disabled = true; btn.textContent = 'Convirtiendo…'; }
  });
  v.append(h('div', { class: 'panel conv-info' },
    h('div', null, h('b', null, 'DSD (DSF/DFF) → FLAC 24-bit / 176.4 kHz'), h('div', { class: 'sub' }, 'Conserva todo lo audible del DSD y se reproduce en Sonora, el DJ y el ecualizador.')),
    h('div', null, h('b', null, 'ALAC (M4A) → FLAC'), h('div', { class: 'sub' }, 'Sin pérdida: el audio queda idéntico, bit a bit.')),
    h('div', null, h('b', null, 'Tus originales no se tocan'), h('div', { class: 'sub' }, 'El FLAC se crea al lado, con etiquetas y portada. Sonora oculta la copia que no puede reproducir.')),
    prog));
  // Agrupado por carpeta (álbum)
  const groups = new Map();
  for (const t of list) { const dir = t.path.replace(/[\\/][^\\/]+$/, ''); if (!groups.has(dir)) groups.set(dir, []); groups.get(dir).push(t); }
  for (const [dir, tracks] of groups) {
    const t0 = tracks[0], q = quality(t0);
    v.append(h('div', { class: 'conv-group lg' },
      h('div', { class: 'conv-head' },
        h('div', { class: 'art' }, t0.coverId ? h('img', { src: coverUrl(t0.coverId), alt: '' }) : placeholder(t0.album, t0.mainGenre)),
        h('div', { class: 'conv-txt' }, h('div', { class: 't' }, t0.album || dir.split(/[\\/]/).pop()), h('div', { class: 'sub' }, `${t0.albumArtist || t0.artist} · ${tracks.length} archivos · ${q?.fmt || ''}`), h('div', { class: 'sub path' }, dir)),
        h('button', { class: 'btn ghost', onClick: () => call('app.revealPath', { path: t0.path }) }, icon('folder', 'sm'), 'Abrir carpeta')),
      h('div', { class: 'conv-files' }, tracks.sort((a, b) => (a.trackNo || 0) - (b.trackNo || 0)).map((t) =>
        h('div', { class: 'conv-row', 'data-id': t.id },
          h('span', { class: 'cn' }, String(t.trackNo || '').padStart(2, '0')),
          h('span', { class: 'ct' }, t.title),
          h('span', { class: 'badge' }, t.ext),
          h('button', { class: 'icon-btn', title: 'Mostrar en el explorador', onClick: () => call('app.revealPath', { path: t.path }) }, icon('external', 'sm')))))));
  }
  const onProg = (e) => {
    const p = e.detail;
    if (p.error) { prog.textContent = p.error; btn.disabled = false; return; }
    prog.replaceChildren(h('b', null, p.finished ? `Listo: ${p.ok} convertidos${p.fail ? `, ${p.fail} con error` : ''}.` : `Convirtiendo ${p.done + 1} de ${p.total}…`), p.current ? ' ' + p.current : '',
      h('div', { class: 'range', style: { '--p': (p.total ? (p.done / p.total) * 100 : 0) + '%', marginTop: '10px', pointerEvents: 'none' } }, h('div', { class: 'track' }, h('div', { class: 'fill' }))));
    if (p.finished) { btn.textContent = 'Actualizando biblioteca…'; }
  };
  document.addEventListener('convert', onProg);
  S.cleanup.push(() => document.removeEventListener('convert', onProg));
};
// ---------- Ecualizador ----------
VIEWS.eq = (v) => {
  const vals = settings.eq.slice();
  const curve = h('canvas', { class: 'eq-curve' });
  const labels = [];
  const presetsEl = h('div', { class: 'eq-presets' });
  const all = () => ({ ...EQ_PRESETS, ...settings.customPresets });
  const drawPresets = () => presetsEl.replaceChildren(...Object.keys(all()).map((n) =>
    h('button', { class: 'chip' + (settings.eqPreset === n ? ' on' : ''), onClick: () => applyPreset(n), onContextmenu: (e) => { e.preventDefault(); if (settings.customPresets[n]) { delete settings.customPresets[n]; set('customPresets', settings.customPresets); drawPresets(); toast('Preset eliminado'); } } }, n)));
  const sliders = BANDS.map((f, i) => {
    const lab = h('b', null, fmtDb(vals[i]));
    labels.push(lab);
    const s = slider({ min: -12, max: 12, step: 0.5, value: vals[i], vertical: true, bipolar: true, onInput: (x) => { vals[i] = x; engine.setBand(i, x); lab.textContent = fmtDb(x); drawCurve(); }, onChange: () => { settings.eqPreset = 'Personalizado'; set('eq', vals.slice()); drawPresets(); } });
    s.addEventListener('dblclick', () => { vals[i] = 0; s.set(0); engine.setBand(i, 0); lab.textContent = fmtDb(0); set('eq', vals.slice()); drawCurve(); });
    return h('div', { class: 'eq-band' }, lab, s, h('span', null, f >= 1000 ? f / 1000 + 'k' : f));
  });
  function fmtDb(x) { return (x > 0 ? '+' : '') + (+x).toFixed(1); }
  function applyPreset(n) {
    const g = all()[n]; if (!g) return;
    g.forEach((x, i) => { vals[i] = x; engine.setBand(i, x); labels[i].textContent = fmtDb(x); sliders[i].querySelector('.range').set(x); });
    settings.eqPreset = n; set('eq', vals.slice()); drawPresets(); drawCurve();
  }
  function drawCurve() {
    const dpr = devicePixelRatio, W = curve.clientWidth * dpr, H = curve.clientHeight * dpr;
    if (!W) return;
    curve.width = W; curve.height = H;
    const c = curve.getContext('2d');
    const n = 200, fr = new Float32Array(n);
    for (let i = 0; i < n; i++) fr[i] = 20 * Math.pow(1000, i / (n - 1));
    const mag = engine.response(fr);
    c.strokeStyle = 'rgba(127,127,150,.25)'; c.lineWidth = 1;
    for (const db of [-12, -6, 0, 6, 12]) { const y = H / 2 - (db / 15) * (H / 2); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
    const acc = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    const grad = c.createLinearGradient(0, 0, 0, H); grad.addColorStop(0, acc + '66'); grad.addColorStop(1, acc + '00');
    c.beginPath();
    for (let i = 0; i < n; i++) { const db = 20 * Math.log10(mag[i] || 1e-6) + settings.preamp; const x = (i / (n - 1)) * W, y = H / 2 - (db / 15) * (H / 2); i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.strokeStyle = acc; c.lineWidth = 2.5 * dpr; c.stroke();
    c.lineTo(W, H); c.lineTo(0, H); c.closePath(); c.fillStyle = grad; c.fill();
  }
  const pre = slider({ min: -12, max: 6, step: 0.5, value: settings.preamp, onInput: (x) => { engine.setPreamp(x); preV.textContent = fmtDb(x) + ' dB'; drawCurve(); }, onChange: (x) => set('preamp', x) });
  const preV = h('span', { class: 'val' }, fmtDb(settings.preamp) + ' dB');
  v.append(h('div', { class: 'head-row' }, h('div', null, h('h1', { class: 'title' }, 'Ecualizador'), h('div', { class: 'sub' }, 'EQ paramétrico de 10 bandas en coma flotante de 32 bits')), h('div', { class: 'spacer' }),
    h('span', { class: 'sub' }, 'Activado'), sw(settings.eqOn, (x) => { set('eqOn', x); engine.setEqEnabled(x); })));
  v.append(h('div', { class: 'panel eq-wrap' }, curve, h('div', { class: 'eq-bands' }, sliders),
    h('div', { class: 'setrow', style: { background: 'transparent', padding: '4px 0' } }, h('div', { class: 'lbl' }, 'Preamplificador', h('small', null, 'Baja el preamp si subes mucho las bandas para evitar saturación')), pre, preV)));
  v.append(h('h2', { class: 'sec' }, 'Presets', h('button', { class: 'more', onClick: () => { const n = prompt('Nombre del preset:'); if (n) { settings.customPresets[n] = vals.slice(); settings.eqPreset = n; set('customPresets', settings.customPresets); drawPresets(); toast('Preset guardado (clic derecho para borrarlo)'); } } }, '+ Guardar actual')), presetsEl);
  v.append(h('div', { class: 'setgroup', style: { marginTop: '24px' } },
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, 'EQ automático por género', h('small', null, 'Aplica el preset ideal según el género detectado de cada canción')), sw(settings.autoEq, (x) => set('autoEq', x))),
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, 'Limitador anti-saturación', h('small', null, 'Evita distorsión cuando el EQ o el ReplayGain suben demasiado el nivel')), sw(settings.limiter, (x) => { set('limiter', x); engine.setLimiter(x); })),
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, '¿Usas Equalizer APO?', h('small', null, 'Este EQ es independiente. Si ya ecualizas tus audífonos con APO/Peace, deja aquí «Plano» para no duplicar la corrección.')))));
  drawPresets();
  requestAnimationFrame(drawCurve);
  const ro = new ResizeObserver(drawCurve); ro.observe(curve); S.cleanup.push(() => ro.disconnect());
};

// ---------- DJ ----------
function loadDeck(idx, t) {
  if (!t.playable) return toast('Formato no compatible');
  if (idx === engine.active) { P.playNow(t); toast(`Deck ${'AB'[idx]}: ${t.title}`); }
  else {
    const d = engine.decks[idx];
    d.load(t, mediaUrl(t));
    d.setRG(settings.rg === 'off' ? 0 : t.rgTrack ?? 0);
    // Será la siguiente en sonar y evita que la precarga automática la reemplace
    if (P.queue[P.i + 1] !== t) P.queue.splice(P.i + 1, 0, t);
    P.preloaded = t.id;
    renderQueue();
    toast(`Cargada en Deck ${'AB'[idx]}: ${t.title}`);
  }
  if (S.view === 'dj') render(true);
}

// ---------- Auto DJ ----------
async function startDJ(text) {
  const req = parseRequest(text || '', S.tracks);
  if (req.pool.length < 3) return toast(`No encontré suficientes canciones para «${text}»`);
  rankEnergy(S.tracks);
  const ctx = { ...req, played: new Set(), step: 0, recentArtists: [], beats: settings.djBeats, bassSwap: settings.djBassSwap };
  if (req.energy === 'auto' && settings.djEnergy !== 'auto') ctx.energy = settings.djEnergy;
  // Analiza primero lo que más te gusta del pedido (el resto sigue en cola prioritaria)
  const order = req.pool.slice().sort((a, b) => Brain.taste(b) - Brain.taste(a)).map((t) => t.id);
  call('dj.analyze', { ids: order, priority: true }).catch(() => { });
  if (P.track && dj.busy) dj.abort();
  dj.start(ctx);
  S.dj = { text, label: req.label, count: req.pool.length };
  set('djLast', text || '');
  const first = pickFirst(ctx);
  await P.playList([first], 0, { fromDJ: true });
  toast(`DJ · ${req.label} · ${req.pool.length} canciones`);
  if (S.view === 'dj') render(true);
}
function stopDJ(silent) {
  dj.stop(); S.dj = null;
  if (!silent) toast('DJ detenido: la música sigue con tu cola normal');
  if (S.view === 'dj') render(true);
}

VIEWS.dj = (v) => {
  v.append(h('div', { class: 'head-row' },
    h('div', null, h('h1', { class: 'title' }, 'DJ'), h('div', { class: 'sub' }, 'Mezcla tu música como un DJ: tempo, compás, tonalidad y energía')),
    h('div', { class: 'spacer' }),
    segL([['auto', 'Automático'], ['manual', 'Manual']], settings.djTab, (x) => { set('djTab', x); render(true); })));
  if (settings.djTab === 'manual') return manualDJ(v);

  // Pedido
  const input = h('input', { value: dj.on ? (S.dj?.text || '') : settings.djLast || '', placeholder: '¿Qué mezclo?  Ej. «DJ reggaetón», «fiesta 100 BPM», «rock tranqui»', spellcheck: false,
    onKeydown: (e) => { if (e.key === 'Enter') startDJ(input.value); } });
  const sugg = new Map();
  for (const g of S.genres.slice(0, 7)) if (g.name !== 'Sin clasificar') sugg.set(g.name, g.tracks.length);
  for (const g of S.genres) for (const [s, n] of Object.entries(g.subs)) if (n >= 12 && sugg.size < 12) sugg.set(s, n);
  v.append(h('div', { class: 'dj-ask' },
    h('div', { class: 'dj-field' }, icon('spark'), input,
      h('button', { class: 'btn primary', onClick: () => startDJ(input.value) }, dj.on ? 'Cambiar' : 'Mezclar')),
    h('div', { class: 'chips' }, h('button', { class: 'chip', onClick: () => startDJ('') }, 'Toda mi música'),
      [...sugg].map(([g, n]) => h('button', { class: 'chip', onClick: () => { input.value = 'DJ ' + g; startDJ(g); } }, g, h('span', { class: 'n' }, n))))));

  const progEl = h('div', { class: 'sub dj-prog' });
  const updProg = () => {
    const analyzed = S.tracks.filter((t) => t.playable && t.dj?.v >= 2).length, total = S.tracks.filter((t) => t.playable).length;
    const p = S.djProg;
    progEl.replaceChildren(`Canciones analizadas: ${fmtNum(analyzed)} de ${fmtNum(total)}`,
      p && p.total && p.done < p.total ? h('span', null, ` · analizando ${p.done}/${p.total}…`) : null);
  };
  updProg();

  if (!dj.on) {
    v.append(h('div', { class: 'panel dj-intro' },
      h('div', { class: 'dj-steps' },
        [['1', 'Analiza', 'Detecta BPM, compases, tonalidad y energía de cada canción.'],
          ['2', 'Elige', 'Busca la siguiente con tempo y tono compatibles, cuidando la energía de la sesión.'],
          ['3', 'Mezcla', 'Iguala el tempo, alinea los compases, cambia los graves y sale sin que lo notes.']]
          .map(([n, t, d]) => h('div', null, h('b', null, n), h('div', null, h('div', { class: 't' }, t), h('div', { class: 'sub' }, d))))),
      progEl,
      h('button', { class: 'btn sm ghost', onClick: () => call('dj.analyzeAll').then(() => toast('Analizando toda la biblioteca en segundo plano (se pausa al jugar)')) }, 'Analizar toda la biblioteca')));
    const iv = setInterval(updProg, 2000); S.cleanup.push(() => clearInterval(iv));
    return;
  }

  // Sesión en curso
  const dots = () => h('div', { class: 'beats' }, [0, 1, 2, 3].map(() => h('i')));
  const card = (kicker) => {
    const el = h('div', { class: 'dj-card' });
    el.art = h('div', { class: 'art' }); el.k = h('div', { class: 'kicker' }, kicker);
    el.t = h('div', { class: 't' }); el.a = h('div', { class: 'sub' }); el.m = h('div', { class: 'chips' }); el.d = dots();
    el.append(el.art, h('div', { class: 'body' }, el.k, el.t, el.a, el.m, el.d));
    el.fill = (t) => {
      if (el.id === t?.id) return; el.id = t?.id;
      el.art.replaceChildren(t?.coverId ? h('img', { src: coverUrl(t.coverId), alt: '' }) : placeholder(t?.title, t?.mainGenre, 'music'));
      el.t.textContent = t ? t.title : 'Eligiendo…'; el.a.textContent = t ? t.artist : '';
      const d = t?.dj;
      const lvl = t?.djE != null ? Math.round(t.djE * 4) : null;
      el.m.replaceChildren(
        d?.bpm ? h('span', { class: 'chip' }, `${Math.round(d.bpm)} BPM`) : h('span', { class: 'chip' }, t ? 'Analizando…' : ''),
        d?.camelot ? h('span', { class: 'chip', title: 'Tonalidad ' + d.key }, d.camelot) : null,
        lvl != null ? h('span', { class: 'chip energy', title: 'Energía' }, [0, 1, 2, 3, 4].map((k) => h('i', { class: k <= lvl ? 'on' : '' }))) : null);
    };
    return el;
  };
  const now = card('Sonando'), next = card('Sigue');
  const mid = h('div', { class: 'dj-mid' });
  const ring = h('div', { class: 'ring' }); const midT = h('div', { class: 't' }); const midS = h('div', { class: 'sub' });
  mid.append(ring, midT, midS);
  v.append(h('div', { class: 'dj-live' }, now, mid, next));
  v.append(h('div', { class: 'chips dj-actions' },
    h('button', { class: 'btn', onClick: () => { if (!dj.mixNow()) toast('Ya está mezclando'); } }, icon('next', 'sm'), 'Mezclar ahora'),
    h('button', { class: 'btn', onClick: () => { dj.reroll(); P.queue = P.queue.slice(0, P.i + 1).concat(dj.next ? [dj.next] : []); renderQueue(); } }, icon('refresh', 'sm'), 'Otra siguiente'),
    h('button', { class: 'btn ghost', onClick: () => stopDJ() }, icon('x', 'sm'), 'Detener DJ')));
  v.append(h('div', { class: 'setgroup dj-opts' },
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, 'Duración de la mezcla', h('small', null, 'En tiempos musicales. 16 es lo clásico; 32 para electrónica larga.')),
      segL([[8, '8'], [16, '16'], [32, '32']], settings.djBeats, (x) => { set('djBeats', x); dj.ctx.beats = x; dj.p = null; })),
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, 'Energía de la sesión'),
      segL([['low', 'Tranquila'], ['auto', 'Equilibrada'], ['high', 'Fiesta']], dj.ctx.energy, (x) => { set('djEnergy', x); dj.ctx.energy = x; dj.refresh(); })),
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, 'Bass swap', h('small', null, 'Cambia los graves de una canción a otra en un solo tiempo, como en cabina.')),
      sw(settings.djBassSwap, (x) => { set('djBassSwap', x); dj.ctx.bassSwap = x; })),
    h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, `Sesión: ${S.dj?.label || ''}`, progEl))));

  const upd = () => {
    const I = dj.info();
    if (!I.on) { render(true); return; }
    now.fill(I.cur); next.fill(I.next);
    const beat = (el, b) => { const k = b == null ? -1 : ((b % 4) + 4) % 4; [...el.d.children].forEach((d, i) => d.classList.toggle('on', i === k)); };
    beat(now, engine.cur.el.paused ? null : I.beatA); beat(next, I.beatB);
    const p = I.plan;
    if (I.state === 'mixing') { midT.textContent = 'Mezclando'; ring.style.setProperty('--p', I.progress * 100 + '%'); }
    else if (I.state === 'preroll') { midT.textContent = 'Sincronizando'; ring.style.setProperty('--p', '0%'); }
    else { midT.textContent = I.mixIn != null && I.mixIn > 0 ? 'Mezcla en ' + fmtTime(I.mixIn) : '—'; ring.style.setProperty('--p', '0%'); }
    const parts = [];
    if (p?.type === 'sync') { parts.push(`${p.L} tiempos`); if (I.tempo) parts.push(`tempo ${I.tempo.rate >= 1 ? '+' : ''}${((I.tempo.rate - 1) * 100).toFixed(1)} %`); if (settings.djBassSwap) parts.push('bass swap'); }
    else if (p) parts.push('fundido suave');
    if (I.key >= 0.85) parts.push('tono compatible');
    midS.textContent = parts.join(' · ');
    ring.classList.toggle('sync', p?.type === 'sync');
  };
  upd();
  const iv = setInterval(upd, 120);
  const iv2 = setInterval(updProg, 2000);
  S.cleanup.push(() => { clearInterval(iv); clearInterval(iv2); });
};

function manualDJ(v) {
  const deckEl = (idx) => {
    const d = engine.decks[idx];
    const t = d.track;
    const live = idx === engine.active;
    const res = h('div', { class: 'deck-results', hidden: true });
    const input = h('input', { placeholder: `Buscar para Deck ${'AB'[idx]}…`, onInput: debounce((e) => {
      const w = norm(e.target.value).split(/\s+/).filter(Boolean);
      if (!w.length) { res.hidden = true; return; }
      const found = S.tracks.filter((x) => x.playable && Brain.searchScore(x, w)).slice(0, 30);
      res.hidden = false;
      res.replaceChildren(...found.map((x) => h('div', { class: 'qitem', onClick: () => { res.hidden = true; input.value = ''; loadDeck(idx, x); } },
        h('div', { class: 'mini', style: { backgroundImage: x.coverId ? `url(${coverUrl(x.coverId)})` : genreGradient(x.mainGenre) } }),
        h('div', { class: 'txt' }, h('div', { class: 't' }, x.title), h('div', { class: 'a' }, `${x.artist}${x.bpm ? ' · ' + Math.round(x.bpm) + ' BPM' : ''}`)))));
    }, 150) });
    const rate = d.el.playbackRate || 1;
    const bpmEl = h('div', { class: 'bpm' }, t?.bpm ? (t.bpm * rate).toFixed(1) : '—', h('small', null, ' BPM'));
    const tempoV = h('span', { class: 'val' }, ((rate - 1) * 100).toFixed(1) + '%');
    const tempo = slider({ min: -8, max: 8, step: 0.1, value: (rate - 1) * 100, bipolar: true, onInput: (x) => { engine.setTempo(idx, 1 + x / 100, settings.keylock); tempoV.textContent = x.toFixed(1) + '%'; bpmEl.firstChild.textContent = t?.bpm ? (t.bpm * (1 + x / 100)).toFixed(1) : '—'; } });
    tempo.addEventListener('dblclick', () => { engine.setTempo(idx, 1, settings.keylock); tempo.set(0); tempoV.textContent = '0.0%'; });
    const prog = slider({ min: 0, max: 1, value: d.el.duration ? d.el.currentTime / d.el.duration : 0, onChange: (x) => { if (d.el.duration) d.el.currentTime = x * d.el.duration; } });
    const timeEl = h('span', { class: 'val', style: { width: '90px' } }, '');
    const iv = setInterval(() => { if (d.el.duration) { prog.set(d.el.currentTime / d.el.duration); timeEl.textContent = '-' + fmtTime(d.el.duration - d.el.currentTime); } el.classList.toggle('playing', d.playing); el.classList.toggle('live', idx === engine.active); playB.firstChild && setIcon(playB.firstChild, d.playing ? 'pause' : 'play'); }, 250);
    S.cleanup.push(() => clearInterval(iv));
    const playB = h('button', { class: 'playbtn', onClick: async () => { await engine.resume(); d.playing ? d.el.pause() : d.url && d.el.play(); } }, icon(d.playing ? 'pause' : 'play'));
    const knob = (band, label) => {
      let val = d[band].gain.value;
      const k = h('div', { class: 'knob' + (val <= -30 ? ' kill' : ''), title: 'Arrastra arriba/abajo · doble clic: kill', style: { '--a': ((val + 26) / 32) * 100 + '%' } });
      const paint = () => { k.style.setProperty('--a', ((Math.max(-26, val) + 26) / 32) * 100 + '%'); k.classList.toggle('kill', val <= -30); };
      k.addEventListener('pointerdown', (e) => {
        k.setPointerCapture(e.pointerId); let y = e.clientY;
        const mv = (ev) => { val = Math.max(-26, Math.min(6, val + (y - ev.clientY) * 0.25)); y = ev.clientY; engine.setDeckEQ(idx, band, val); paint(); };
        const up = () => { k.removeEventListener('pointermove', mv); k.removeEventListener('pointerup', up); };
        k.addEventListener('pointermove', mv); k.addEventListener('pointerup', up);
      });
      k.addEventListener('dblclick', () => { val = val <= -30 ? 0 : -40; engine.setDeckEQ(idx, band, val); paint(); });
      return h('div', { class: 'knob-wrap' }, k, label);
    };
    const el = h('div', { class: 'panel deck' + (live ? ' live' : '') + (d.playing ? ' playing' : '') },
      h('div', { class: 'deck-search' }, input, res),
      h('div', { class: 'sub', style: { fontWeight: 700, letterSpacing: '.2em' } }, 'DECK ' + 'AB'[idx] + (live ? ' · EN VIVO' : '')),
      h('div', { class: 'platter' }, h('div', { class: 'spin' }, h('div', { class: 'lbl', style: { backgroundImage: t?.coverId ? `url(${coverUrl(t.coverId)})` : '' } }))),
      h('div', { class: 'dt' }, t ? t.title : 'Vacío'), h('div', { class: 'ds' }, t ? t.artist : 'Busca una canción arriba'),
      bpmEl,
      h('div', { class: 'ctrlrow' }, prog, timeEl),
      h('div', { class: 'ctrlrow' },
        h('button', { class: 'btn sm ghost', title: 'Volver al inicio', onClick: () => { d.el.currentTime = 0; } }, 'CUE'), playB,
        h('button', { class: 'btn sm ghost', title: 'Sincronizar tempo con el otro deck', onClick: () => syncDeck(idx) }, 'SYNC')),
      h('div', { class: 'ctrlrow' }, h('span', { class: 'sub', style: { fontSize: '12px' } }, 'Tempo'), tempo, tempoV),
      h('div', { class: 'knobs' }, knob('high', 'AGUDOS'), knob('mid', 'MEDIOS'), knob('low', 'GRAVES')));
    return el;
  };
  const xf = slider({ min: 0, max: 1, step: 0.01, value: engine.x, cls: 'xf', onInput: (x) => {
    engine.applyX(x, 0, settings.djCurve);
    const want = x > 0.5 ? 1 : 0;
    if (want !== engine.active && engine.decks[want].track) adoptDeck(want);
  } });
  const fadeV = h('span', { class: 'val' }, settings.djFade + ' s');
  const mixer = h('div', { class: 'panel mixer' },
    h('div', { class: 'sub', style: { fontWeight: 700, letterSpacing: '.2em' } }, 'MEZCLADOR'),
    h('canvas', { class: 'wavebar' }),
    h('div', { style: { width: '100%' } }, h('div', { class: 'sub', style: { display: 'flex', justifyContent: 'space-between', fontSize: '12px' } }, h('span', null, 'A'), h('span', null, 'Crossfader'), h('span', null, 'B')), xf),
    segL([['smooth', 'Suave'], ['cut', 'Corte']], settings.djCurve, (c) => { set('djCurve', c); engine.applyX(engine.x, 0, c); }),
    h('button', { class: 'btn primary', onClick: () => mixNow() }, icon('spark', 'sm'), 'Mezclar ahora'),
    h('div', { class: 'setrow', style: { width: '100%' } }, h('div', { class: 'lbl' }, 'Transición'), slider({ min: 2, max: 20, step: 1, value: settings.djFade, onInput: (x) => (fadeV.textContent = x + ' s'), onChange: (x) => set('djFade', x) }), fadeV),
    h('div', { class: 'setrow', style: { width: '100%' } }, h('div', { class: 'lbl' }, 'Automix', h('small', null, 'Elige la siguiente por género y BPM, iguala tempo y mezcla solo')), sw(settings.automix, (x) => { set('automix', x); if (x) set('autoRadio', true); })),
    h('div', { class: 'setrow', style: { width: '100%' } }, h('div', { class: 'lbl' }, 'Key lock', h('small', null, 'Conserva el tono al cambiar tempo')), sw(settings.keylock, (x) => { set('keylock', x); engine.decks.forEach((d) => (d.el.preservesPitch = x)); })));
  v.append(h('div', { class: 'dj' }, deckEl(0), mixer, deckEl(1)));
  if (!settings.gameMode) startMiniViz($('.wavebar', mixer));
}

function startMiniViz(cv) {
  const c = cv.getContext('2d');
  const data = new Uint8Array(engine.analyser.fftSize);
  let raf;
  let last = 0;
  const color = getComputedStyle(document.documentElement).getPropertyValue('--accent');
  const draw = (now) => {
    raf = requestAnimationFrame(draw);
    if (document.hidden || now - last < 33) return;
    last = now;
    const W = (cv.width = cv.clientWidth), H = (cv.height = cv.clientHeight);
    engine.analyser.getByteTimeDomainData(data);
    c.strokeStyle = color;
    c.lineWidth = 2; c.beginPath();
    for (let i = 0; i < data.length; i += 8) { const x = (i / data.length) * W, y = (data[i] / 255) * H; i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.stroke();
  };
  raf = requestAnimationFrame(draw);
  S.cleanup.push(() => cancelAnimationFrame(raf));
}

function adoptDeck(idx) {
  const d = engine.decks[idx];
  P.finish(true);
  engine.active = idx;
  if (d.track) {
    if (P.queue[P.i + 1] !== d.track) P.queue.splice(P.i + 1, 0, d.track);
    P.i = Math.min(P.i + 1, P.queue.length - 1);
    P.preloaded = null; P.mixing = false;
    P.start(d.track);
  }
}
async function mixNow() {
  const o = engine.other;
  if (!o.track) { const n = P.peekNext(); if (!n) return toast('Carga una canción en el otro deck'); loadDeck(o.idx, n); }
  await engine.resume();
  if (!o.playing) await o.el.play().catch(() => { });
  beatMatch(engine.cur.track, o.track);
  const target = o.idx;
  engine.applyX(target, settings.djFade, settings.djCurve);
  const from = engine.cur;
  adoptDeck(target);
  setTimeout(() => { if (engine.cur !== from) from.el.pause(); if (S.view === 'dj') render(true); }, settings.djFade * 1000 + 150);
}
function syncDeck(idx) {
  const me = engine.decks[idx], ot = engine.decks[1 - idx];
  if (!me.track?.bpm || !ot.track?.bpm) return toast('Las dos pistas necesitan BPM en sus etiquetas');
  const target = ot.track.bpm * (ot.el.playbackRate || 1);
  let r = target / me.track.bpm;
  while (r > 1.45) r /= 2; while (r < 0.69) r *= 2;
  if (Math.abs(1 - r) > 0.16) return toast('Diferencia de tempo demasiado grande');
  engine.setTempo(idx, r, settings.keylock);
  toast(`Deck ${'AB'[idx]} sincronizado a ${target.toFixed(1)} BPM`);
  render(true);
}

// ---------- Perfil ----------
VIEWS.profile = (v) => {
  const st = Brain.stats();
  const plays = Object.values(st.tracks).reduce((s, x) => s + (x.p || 0), 0);
  const secs = Object.entries(st.tracks).reduce((s, [id, x]) => s + (x.c || 0) * (S.byId.get(id)?.duration || 0), 0);
  v.append(h('h1', { class: 'title' }, 'Tu perfil musical'), h('div', { class: 'sub' }, 'Sonora aprende de lo que completas, saltas y repites. Así se construyen tus mixes y la radio.'));
  v.append(h('div', { class: 'stat-cards', style: { marginTop: '20px' } },
    [[fmtNum(plays), 'reproducciones'], [fmtLong(secs), 'escuchado completo'], [fmtNum(Object.keys(st.tracks).length), 'canciones distintas'], [fmtNum(Object.keys(st.loved).length), 'favoritas'], [fmtNum(S.tracks.length), 'en tu biblioteca']]
      .map(([b, s]) => h('div', { class: 'm' }, h('b', null, b), h('small', null, s)))));
  const tg = Brain.topGenres(12);
  const max = tg[0]?.[1] || 1;
  v.append(h('h2', { class: 'sec' }, icon('spark'), 'Tu ADN musical'));
  if (!tg.length) v.append(h('div', { class: 'sub' }, 'Escucha algunas canciones y aquí verás tus géneros favoritos.'));
  else v.append(h('div', { class: 'panel bars' }, tg.map(([g, x]) => h('div', { class: 'barrow' }, h('span', null, g), h('div', { class: 'b' }, h('i', { style: { width: (x / max) * 100 + '%', background: genreGradient(g) } })), h('span', { class: 'sub', style: { textAlign: 'right' } }, x.toFixed(1))))));
  const ta = Brain.topArtists(12).map(([n]) => artistOf(n)).filter(Boolean);
  if (ta.length) v.append(h('h2', { class: 'sec' }, 'Tus artistas'), h('div', { class: 'shelf' }, ta.map(artistCard)));
  const lf = h('div');
  v.append(h('h2', { class: 'sec' }, 'Last.fm'), lf);
  if (!S.lastfm.connected) lf.append(h('div', { class: 'panel' }, h('div', { class: 'sub' }, 'Conecta tu cuenta para registrar todo lo que escuchas (scrobbling) y ver tus estadísticas aquí.'), h('div', { style: { height: '12px' } }), h('button', { class: 'btn primary', onClick: () => go('settings', 'lastfm') }, 'Conectar Last.fm')));
  else {
    lf.append(h('div', { class: 'sub' }, h('span', { class: 'loader' }), ' Cargando…'));
    call('lastfm.profile').then((p) => {
      if (!lf.isConnected || !p) return;
      const u = p.info?.user;
      const top = p.top?.topartists?.artist || [];
      const rec = p.recent?.recenttracks?.track || [];
      const tags = p.tags?.toptags?.tag || [];
      lf.replaceChildren(
        h('div', { class: 'stat-cards' },
          h('div', { class: 'm' }, h('b', null, fmtNum(+u?.playcount)), h('small', null, 'scrobbles totales')),
          h('div', { class: 'm' }, h('b', null, fmtNum(+u?.artist_count || 0)), h('small', null, 'artistas')),
          h('div', { class: 'm' }, h('b', null, u?.registered?.unixtime ? new Date(u.registered.unixtime * 1000).getFullYear() : '—'), h('small', null, 'miembro desde')),
          h('div', { class: 'm', style: { cursor: 'pointer' }, onClick: () => call('app.open', { url: u?.url }) }, h('b', null, u?.name || S.lastfm.user), h('small', null, 'ver perfil ↗'))),
        top.length ? h('h2', { class: 'sec' }, 'Top artistas del mes') : null,
        h('div', { class: 'shelf' }, top.map((a) => {
          const art = h('div', { class: 'art' }); const ph = placeholder(a.name, null, null); art.append(ph);
          artistImage(a.name, art, ph, 400);
          return h('div', { class: 'card round', onClick: () => artistOf(a.name) ? go('artist', a.name) : call('app.open', { url: a.url }) }, art, h('div', { class: 'meta' }, h('div', { class: 't' }, a.name), h('div', { class: 's' }, fmtNum(+a.playcount) + ' reproducciones')));
        })),
        tags.length ? h('h2', { class: 'sec' }, 'Tus etiquetas') : null,
        h('div', { class: 'chips' }, tags.map((x) => h('span', { class: 'chip' }, x.name))),
        rec.length ? h('h2', { class: 'sec' }, 'Últimos scrobbles') : null,
        h('div', { class: 'alist' }, rec.map((r) => h('div', { class: 'arow', style: { gridTemplateColumns: '56px 1fr 160px' } },
          h('div', { class: 'art' }, r.image?.[2]?.['#text'] ? h('img', { src: imgUrl(r.image[2]['#text'], 200), alt: '' }) : placeholder(r.name, null, 'music')),
          h('div', null, h('div', { style: { fontWeight: 600 } }, r.name), h('div', { class: 'sub', style: { fontSize: '13px' } }, r.artist?.['#text'])),
          h('div', { class: 'sub', style: { textAlign: 'right' } }, r['@attr']?.nowplaying ? '▶ Sonando' : r.date?.['#text'] || '')))));
    }).catch(() => lf.replaceChildren(h('div', { class: 'sub' }, 'No se pudo cargar Last.fm.')));
  }
};

// ---------- Ajustes ----------
VIEWS.settings = (v, tab) => {
  tab = tab || 'library';
  const tabs = [['library', 'Biblioteca', 'folder'], ['look', 'Apariencia', 'image'], ['audio', 'Audio', 'volume'], ['lastfm', 'Last.fm', 'radio'], ['perf', 'Rendimiento', 'chip'], ['keys', 'Atajos', 'game']];
  const body = h('div');
  v.append(h('h1', { class: 'title', style: { marginBottom: '20px' } }, 'Ajustes'),
    h('div', { class: 'settings' },
      h('div', { class: 'tabs' }, tabs.map(([k, l, ic]) => h('button', { class: 'nav-item' + (k === tab ? ' on' : ''), onClick: () => go('settings', k, { replace: true }) }, icon(ic), h('span', null, l)))),
      body));
  const row = (label, small, ctl) => h('div', { class: 'setrow' }, h('div', { class: 'lbl' }, label, small ? h('small', null, small) : null), ctl);
  const group = (title, ...rows) => h('div', { class: 'setgroup' }, h('h3', null, title), ...rows);
  const toggle = (k, after) => sw(settings[k], (x) => { set(k, x); applySettings(); after && after(x); });
  const range = (k, min, max, step, unit = '', after) => {
    const val = h('span', { class: 'val' }, settings[k] + unit);
    const s = slider({ min, max, step, value: settings[k], onInput: (x) => { settings[k] = x; val.textContent = (Math.round(x * 100) / 100) + unit; applySettings(); after && after(x); }, onChange: (x) => set(k, x) });
    return h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } }, s, val);
  };

  if (tab === 'library') {
    const unplay = S.tracks.filter((t) => !t.playable);
    const exts = [...new Set(unplay.map((t) => t.ext.toUpperCase()))].join(', ');
    body.append(
      group('Carpetas de música',
        ...S.folders.map((f) => h('div', { class: 'folder-row' }, icon('folder', 'sm'), h('span', { title: f }, f),
          h('button', { class: 'icon-btn', title: 'Quitar', onClick: async () => { S.folders = await call('library.removeFolder', { path: f }); render(true); } }, icon('x', 'sm')))),
        h('div', { class: 'chips', style: { marginTop: '10px' } },
          h('button', { class: 'btn primary', onClick: addFolder }, icon('plus', 'sm'), 'Agregar carpeta'),
          h('button', { class: 'btn', onClick: () => call('library.scan').then(() => toast('Escaneando cambios…')) }, icon('refresh', 'sm'), 'Volver a escanear'))),
      group('Géneros inteligentes',
        row('Análisis rápido', 'Etiquetas de Last.fm por artista y álbum + géneros de TheAudioDB. También descarga fotos y biografías.', h('button', { class: 'btn', onClick: () => analyzeGenres(false) }, icon('spark', 'sm'), 'Analizar')),
        row('Análisis profundo', 'Además consulta cada canción cuya clasificación sea dudosa (más lento, más preciso). Requiere API key de Last.fm.', h('button', { class: 'btn', onClick: () => analyzeGenres(true) }, 'Analizar a fondo'))),
      group('Resumen',
        row(`${fmtNum(S.tracks.length)} canciones · ${S.albums.length} álbumes · ${S.artists.length} artistas`, `${fmtLong(S.tracks.reduce((s, t) => s + (t.duration || 0), 0))} de música · ${(S.tracks.reduce((s, t) => s + (t.size || 0), 0) / 1073741824).toFixed(1)} GB`, null),
        unplay.length ? row(`${unplay.length} archivos aún no reproducibles (${exts})`, 'DSF y ALAC ya se reproducen directo; estos formatos (por ejemplo DFF) todavía no. Sonora puede convertirlos a FLAC con la misma calidad.', h('button', { class: 'btn primary', onClick: () => go('convert') }, 'Ver y convertir')) : null));
  }
  if (tab === 'look') {
    const swatches = ['#0a84ff', '#5e5ce6', '#bf5af2', '#ff375f', '#ff9f0a', '#30d158', '#64d2ff', '#8e8e93'];
    const sws = h('div', { class: 'swatches' },
      h('button', { class: 'swatch auto' + (settings.accent === 'auto' ? ' on' : ''), title: 'Automático: toma el color de la portada', onClick: () => { set('accent', 'auto'); applySettings(); render(true); } }),
      swatches.map((c) => h('button', { class: 'swatch' + (settings.accent !== 'auto' && settings.accentColor === c ? ' on' : ''), style: { background: c }, onClick: () => { set('accent', 'fixed'); set('accentColor', c); applySettings(); render(true); } })),
      h('input', { type: 'color', value: settings.accentColor, title: 'Color personalizado', style: { width: '34px', height: '30px', padding: 0, border: 0, background: 'none' }, onInput: (e) => { set('accent', 'fixed'); set('accentColor', e.target.value); applySettings(); } }));
    body.append(
      group('Tema',
        row('Estilo', null, segL([['dark', 'Oscuro'], ['light', 'Claro'], ['amoled', 'Negro']], settings.theme, (x) => { set('theme', x); applySettings(); })),
        S.fxSupported === false
          ? row('Transparencia de ventana', 'Necesita Windows 11 (versión 22H2 o más reciente). En este equipo se usa un fondo sólido.', null)
          : row('Transparencia de ventana', 'Cristal: transparente, deja ver ventanas y juegos detrás. Acrílico: más opaco. Mica: tinte de tu fondo de pantalla. Lo dibuja Windows: no usa RAM de Sonora.', segL([['glass', 'Cristal'], ['acrylic', 'Acrílico'], ['mica', 'Mica'], ['none', 'No']], settings.windowFx, (x) => { set('windowFx', x); applySettings(); })),
        row('Color de acento', 'Automático cambia con cada portada', sws),
        row('Fondo ambiental', 'Lo que se ve difuminado detrás de la interfaz', segL([['cover', 'Portada'], ['artist', 'Artista'], ['solid', 'Sólido']], settings.bg, (x) => { set('bg', x); bgCur = null; applySettings(); }))),
      group('Forma',
        row('Desenfoque (efecto cristal)', null, toggle('blur')),
        row('Intensidad del desenfoque', null, range('blurAmount', 10, 90, 1, ' px')),
        row('Esquinas redondeadas', null, range('radius', 0, 28, 1, ' px')),
        row('Tamaño de la interfaz', null, range('scale', 0.85, 1.3, 0.05, '×')),
        row('Animaciones', null, toggle('animations')),
        row('Menú lateral compacto', null, toggle('sideCollapsed'))),
      group('Televisión',
        row('Modo TV', 'Interfaz grande para verla desde el sillón. Se controla con flechas, control remoto o mando (Xbox/PlayStation).', sw(settings.tvMode, (x) => toggleTV(x)))));
  }
  if (tab === 'audio') {
    const sr = h('select', { onChange: (e) => { set('sampleRate', +e.target.value); toast('Reinicia Sonora para aplicar la nueva frecuencia'); } },
      [[0, 'Automática (la del dispositivo)'], [44100, '44.1 kHz'], [48000, '48 kHz'], [88200, '88.2 kHz'], [96000, '96 kHz'], [176400, '176.4 kHz'], [192000, '192 kHz']].map(([x, l]) => h('option', { value: x, selected: settings.sampleRate === x }, l)));
    body.append(
      group('Calidad',
        row('Frecuencia del motor de audio', `Ahora: ${engine.ctx.sampleRate / 1000} kHz · latencia ${(engine.ctx.baseLatency * 1000 || 0).toFixed(0)} ms. Igualarla a tu DAC (Panel de sonido → Formato predeterminado) evita remuestreos.`, sr),
        row('ReplayGain', 'Iguala el volumen entre canciones usando las etiquetas del archivo', segL([['off', 'No'], ['track', 'Pista'], ['album', 'Álbum']], settings.rg, (x) => set('rg', x))),
        row('Limitador anti-saturación', null, toggle('limiter', (x) => engine.setLimiter(x)))),
      group('Transiciones',
        row('Crossfade', 'Mezcla el final de una canción con el inicio de la siguiente (0 = desactivado)', range('crossfade', 0, 12, 0.5, ' s')),
        row('Crossfade inteligente', 'No mezcla pistas consecutivas del mismo álbum (respeta discos en vivo y conceptuales)', toggle('smartCrossfade')),
        row('Reproducción sin pausas (gapless)', 'Precarga la siguiente canción para que no haya silencios', toggle('gapless')),
        row('Radio inteligente al terminar', 'Cuando la cola se acaba, sigue con canciones parecidas según tus gustos', toggle('autoRadio'))));
  }
  if (tab === 'lastfm') {
    const lf = S.lastfm;
    const key = h('input', { value: '', placeholder: lf.keyHint ? `${lf.keyHint} (guardada · escribe otra para cambiarla)` : 'API key', autocomplete: 'off', spellcheck: false, style: { width: '320px' } });
    const sec = h('input', { type: 'password', autocomplete: 'off', placeholder: lf.hasSecret ? '•••••••• (guardado)' : 'Shared secret', style: { width: '320px' } });
    const bsel = h('select', { onChange: (e) => set('lfBrowser', e.target.value) }, h('option', { value: '' }, 'Navegador predeterminado'));
    call('app.browsers').then((list) => {
      for (const b of list || []) bsel.append(h('option', { value: b.path, selected: settings.lfBrowser === b.path }, b.name + (b.isDefault ? ' (predeterminado)' : '')));
    }).catch(() => { });
    const linkBox = h('div', { class: 'sub', style: { fontSize: '12px', marginTop: '6px', wordBreak: 'break-all' } });
    const status = h('div', { class: 'sub' }, lf.connected ? `✓ Conectado como ${lf.user}${lf.queued ? ` · ${lf.queued} scrobbles pendientes` : ''}` : lf.hasKey ? 'API key guardada. Ahora conecta tu cuenta.' : 'Sin configurar');
    body.append(
      group('Cuenta',
        row('Estado', null, status),
        lf.connected
          ? row('Desconectar', null, h('button', { class: 'btn ghost', onClick: async () => { S.lastfm = await call('lastfm.logout'); updateSideFoot(); render(true); } }, 'Cerrar sesión'))
          : row('Conectar', '1) Pulsa «Conectar» y autoriza Sonora en el navegador. 2) Vuelve y pulsa «Ya autoricé».',
            h('div', { class: 'chips' },
              h('button', { class: 'btn primary', disabled: !lf.hasKey, onClick: async () => {
                try {
                  const url = await call('lastfm.connect', { browser: settings.lfBrowser || '' });
                  toast('Autoriza en el navegador y vuelve aquí');
                  linkBox.replaceChildren('¿No se abrió? ', h('a', { href: '#', onClick: (e) => { e.preventDefault(); navigator.clipboard.writeText(url).then(() => toast('Enlace copiado: pégalo en tu navegador')); } }, 'Copiar enlace de autorización'));
                } catch (e) { toast(e.message); }
              } }, 'Conectar'),
              h('button', { class: 'btn', disabled: !lf.hasKey, onClick: async () => { try { S.lastfm = await call('lastfm.finish'); updateSideFoot(); toast('¡Last.fm conectado!'); render(true); } catch (e) { toast('Aún no autorizado: ' + e.message); } } }, 'Ya autoricé'))),
        lf.connected ? null : row('Abrir con', 'El navegador donde tienes tu sesión de Last.fm iniciada', h('div', null, bsel, linkBox)),
        row('Registrar lo que escucho (scrobbling)', 'Se registra al pasar la mitad de la canción o 4 minutos. Sin internet, se guarda y se envía después.', toggle('scrobble'))),
      group('Credenciales de la API',
        row('¿Cómo las obtengo?', 'Crea una «API account» gratuita en Last.fm (nombre de app: Sonora). Te dará una API key y un shared secret.', h('button', { class: 'btn ghost', onClick: () => call('app.open', { url: 'https://www.last.fm/api/account/create', browser: settings.lfBrowser || '' }) }, icon('external', 'sm'), 'Abrir Last.fm')),
        row('API key', null, key),
        row('Shared secret', 'Se guarda cifrado en tu PC (DPAPI de Windows) y nunca se muestra', sec),
        row('', null, h('div', { class: 'chips' }, h('button', { class: 'btn primary', onClick: async () => { try { S.lastfm = await call('lastfm.configure', { key: key.value, secret: sec.value }); artistMeta.clear(); toast('Credenciales guardadas y cifradas'); updateSideFoot(); render(true); } catch (e) { toast(e.message); } } }, 'Guardar'),
          lf.hasKey ? h('button', { class: 'btn ghost', onClick: async () => { S.lastfm = await call('lastfm.forget'); artistMeta.clear(); toast('Credenciales borradas de este equipo'); updateSideFoot(); render(true); } }, 'Borrar credenciales') : null))));
  }
  if (tab === 'perf') {
    const mem = h('div', { class: 'mem' }, h('div', { class: 'sub' }, 'Midiendo…'));
    const refresh = () => call('app.memory').then((m) => {
      mem.replaceChildren(
        h('div', { class: 'm' }, h('b', null, m.totalMB.toFixed(0) + ' MB'), h('small', null, `RAM total (${m.processes} procesos)`)),
        h('div', { class: 'm' }, h('b', null, m.hostMB.toFixed(0) + ' MB'), h('small', null, 'Núcleo (.NET)')),
        h('div', { class: 'm' }, h('b', null, m.webMB.toFixed(0) + ' MB'), h('small', null, 'Interfaz y audio (WebView2)')));
    }).catch(() => { });
    refresh();
    const iv = setInterval(refresh, 2500); S.cleanup.push(() => clearInterval(iv));
    body.append(
      group('Memoria en uso', mem, h('div', { class: 'chips', style: { marginTop: '10px' } }, h('button', { class: 'btn', onClick: () => call('app.trim').then(() => setTimeout(refresh, 600)) }, 'Liberar memoria ahora'))),
      group('Para jugar',
        row('Modo juego', 'Quita desenfoques, animaciones y visualizadores, y pide a Windows liberar memoria. Las teclas multimedia siguen funcionando dentro del juego.', sw(settings.gameMode, (x) => toggleGame(x))),
        row('Al minimizar', 'Sonora deja de dibujar la interfaz y recorta su memoria automáticamente; la música sigue sonando.', null),
        row('Cerrar a la bandeja', 'La X oculta la ventana en la bandeja del sistema en lugar de salir', toggle('closeToTray')),
        row('Visualizador', 'Espectro animado en la vista inmersiva', toggle('visualizer')),
        row('Aceleración por GPU', 'Desactivada: ~250 MB menos de RAM y la gráfica queda libre para tus juegos. Actívala si quieres animaciones más fluidas (requiere reiniciar Sonora).', toggle('gpuAccel', () => toast('Reinicia Sonora para aplicar el cambio')))));
  }
  if (tab === 'keys') {
    const keys = [['Espacio', 'Reproducir / pausa'], ['Ctrl + → / ←', 'Siguiente / anterior'], ['→ / ←', 'Adelantar / retroceder 5 s'], ['Ctrl + ↑ / ↓', 'Volumen'], ['M', 'Silenciar'], ['S', 'Aleatorio'], ['R', 'Repetir'], ['L', 'Me gusta'], ['Q', 'Mostrar cola'], ['N', 'Vista inmersiva'], ['Ctrl + F', 'Buscar'], ['F11', 'Pantalla completa'], ['Alt + ← / Retroceso', 'Atrás'], ['Teclas multimedia', 'Funcionan aunque estés en un juego'], ['Mando (modo TV)', 'Cruceta: mover · A: elegir · B: atrás · LB/RB: anterior/siguiente · Start: pausa']];
    body.append(group('Atajos de teclado', ...keys.map(([k, d]) => row(d, null, h('span', { class: 'badge', style: { fontSize: '12px', padding: '4px 10px' } }, k)))));
  }
};

// ======================================================================
// Teclado, mando y eventos
// ======================================================================
function onKey(e) {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const tv = settings.tvMode;
  const k = e.key;
  if (k === ' ' && !(tv && document.activeElement && document.activeElement !== document.body && document.activeElement.matches('button'))) { e.preventDefault(); togglePlay(); return; }
  if (tv && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(k) && !e.ctrlKey) { e.preventDefault(); spatialMove(k.slice(5).toLowerCase()); return; }
  if (e.ctrlKey && k === 'ArrowRight') { e.preventDefault(); P.next(); return; }
  if (e.ctrlKey && k === 'ArrowLeft') { e.preventDefault(); P.prev(); return; }
  if (e.ctrlKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); const nv = Math.max(0, Math.min(1, settings.volume + (k === 'ArrowUp' ? 0.05 : -0.05))); set('volume', nv); engine.setVolume(nv); bar.vol.set(nv); toast(`Volumen ${Math.round(nv * 100)}%`, 900); return; }
  if (e.ctrlKey && k.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); return; }
  if (k === 'ArrowRight' && !e.target.closest('.range')) { engine.seek(engine.time + 5); return; }
  if (k === 'ArrowLeft' && !e.target.closest('.range')) { engine.seek(engine.time - 5); return; }
  if ((e.altKey && k === 'ArrowLeft') || k === 'Backspace' || k === 'BrowserBack') { e.preventDefault(); back(); return; }
  if (k === 'Escape') { if ($('.modal-bg')) $('.modal-bg').remove(); else if (document.body.classList.contains('queue-open')) toggleQueue(); else if (settings.tvMode) back(); return; }
  if (k === 'F11') { e.preventDefault(); S.full = !S.full; call('app.fullscreen', { on: S.full }); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const map = { m: toggleMute, s: () => P.toggleShuffle(), r: cycleRepeat, l: () => toggleLove(), q: toggleQueue, n: () => go('now'), '/': () => $('#search').focus() };
  const f = map[k.toLowerCase()];
  if (f) { e.preventDefault(); f(); }
}

let padTimer = null;
function startGamepad() {
  if (padTimer) return;
  let prev = {};
  padTimer = setInterval(() => {
    if (!settings.tvMode) { clearInterval(padTimer); padTimer = null; return; }
    const gp = [...(navigator.getGamepads?.() || [])].find(Boolean);
    if (!gp) return;
    const b = (i) => gp.buttons[i]?.pressed;
    const now = { up: b(12) || gp.axes[1] < -0.6, down: b(13) || gp.axes[1] > 0.6, left: b(14) || gp.axes[0] < -0.6, right: b(15) || gp.axes[0] > 0.6, a: b(0), b: b(1), lb: b(4), rb: b(5), start: b(9), y: b(3) };
    const edge = (k) => now[k] && !prev[k];
    for (const d of ['up', 'down', 'left', 'right']) if (edge(d)) spatialMove(d);
    if (edge('a')) document.activeElement?.click();
    if (edge('b')) back();
    if (edge('lb')) P.prev();
    if (edge('rb')) P.next();
    if (edge('start')) togglePlay();
    if (edge('y')) go('now');
    prev = now;
  }, 90);
}

// ======================================================================
// Inicio
// ======================================================================
async function init() {
  applySettings();
  if (!hasHost) {
    $('#view').append(h('div', { class: 'empty' }, h('h2', null, 'Abre Sonora desde la aplicación'), 'Esta interfaz necesita el núcleo nativo (Sonora.exe).'));
    return;
  }
  const [st] = await Promise.all([call('state.load', { key: 'settings' }).catch(() => null), Brain.load()]);
  settings = { ...DEFAULTS, ...(st || {}) };
  if (!st?.v || st.v < 2) { // nuevo diseño: azul iOS, sin tema Medianoche
    Object.assign(settings, { accent: 'fixed', accentColor: '#0a84ff', blurAmount: 60 });
    if (settings.theme === 'midnight') settings.theme = 'dark';
  }
  if (!st?.v || st.v < 3) { // estilo «sala de escucha»: cristal transparente y riel de iconos
    Object.assign(settings, { v: 3, windowFx: 'glass', sideCollapsed: true });
    saveSettings();
  }
  engine = new Engine({ sampleRate: settings.sampleRate });
  engine.addEventListener('time', (e) => onTime(e.detail));
  engine.addEventListener('buffer', (e) => bar.seek?.setBuf(e.detail));
  engine.addEventListener('state', () => { if (dj?.busy && engine.cur.el.paused) dj.abort(); updateBar(); });
  dj = new AutoDJ(engine, { url: mediaUrl, rg: rgOf, adopt: (t) => P.adopt(t) });
  window.__sonora = { dj, engine, P, S }; // depuración (consola)
  engine.addEventListener('ended', () => P.next({ auto: true }));
  engine.addEventListener('error', (e) => { const t = e.detail.deck.track; if (t && e.detail.deck === engine.cur) { toast(`No se pudo reproducir «${t.title}»`); setTimeout(() => P.next({ auto: true }), 800); } });
  engine.addEventListener('fadedone', () => { if (S.view === 'dj') render(true); });

  buildBar();
  applySettings();
  buildNav();

  const d = await call('init');
  S.folders = d.folders; S.lastfm = d.lastfm; S.scanning = d.scanning; S.fxSupported = d.fxSupported !== false;
  setTracks(d.tracks || []);
  updateSideFoot();

  // Restaurar cola
  try {
    const q = await call('state.load', { key: 'queue' });
    if (q?.ids?.length) {
      P.queue = q.ids.map((id) => S.byId.get(id)).filter(Boolean);
      P.i = Math.min(Math.max(0, q.i), P.queue.length - 1);
      P.repeat = q.repeat || 'off'; P.shuffle = !!q.shuffle;
      const t = P.track;
      if (t?.playable) {
        engine.cur.load(t, mediaUrl(t));
        engine.cur.el.currentTime = q.t || 0;
        updateBar(); onTrackChange(t);
      }
    }
  } catch { }

  // Teclas multimedia (globales) y bandeja
  on('hotkey', ({ key }) => ({ playpause: togglePlay, next: () => P.next(), prev: () => P.prev(), stop: () => engine.pause() })[key]?.());
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => togglePlay());
    ms.setActionHandler('pause', () => engine.pause());
    ms.setActionHandler('nexttrack', () => P.next());
    ms.setActionHandler('previoustrack', () => P.prev());
    try { ms.setActionHandler('seekto', (e) => engine.seek(e.seekTime)); } catch { }
  }
  on('library', (tracks) => {
    S.scanning = false;
    setTracks(tracks);
    $('#scanPill').hidden = true;
    updateSideFoot();
    if (!['now', 'dj', 'eq', 'settings'].includes(S.view)) render(true);
    toast(`Biblioteca actualizada: ${fmtNum(tracks.length)} canciones`);
  });
  const pill = (title, { done, total, current }) => {
    const el = $('#scanPill');
    if (total && done >= total) { el.hidden = true; return; }
    el.hidden = false;
    el.replaceChildren(h('div', null, h('b', null, title), ` ${done}/${total}`), h('div', { class: 'sub', style: { fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, current || ''),
      h('div', { class: 'range', style: { '--p': (total ? (done / total) * 100 : 0) + '%' } }, h('div', { class: 'track' }, h('div', { class: 'fill' }))));
  };
  on('scan', (p) => { S.scanning = true; pill('Escaneando música', p); });
  on('genre', (p) => pill('Analizando géneros', p));
  on('djinfo', (list) => {
    for (const { id, dj: info } of list) { const t = S.byId.get(id); if (t) t.dj = info; }
    rankEnergy(S.tracks);
    dj.refresh();
  });
  on('djprogress', (p) => { S.djProg = p; });
  on('convert', (p) => document.dispatchEvent(new CustomEvent('convert', { detail: p })));
  on('djinfo', (list) => { const cur = P.track; if (cur && list.some((x) => x.id === cur.id)) { bar.seek.setWave(cur.dj?.wave); document.dispatchEvent(new CustomEvent('wave')); } });
  // Brillo del cristal líquido que sigue al cursor (solo repinta la tarjeta bajo el puntero)
  let glassRaf = 0, glassEv = null;
  document.addEventListener('pointermove', (e) => {
    glassEv = e;
    if (glassRaf) return;
    glassRaf = requestAnimationFrame(() => {
      glassRaf = 0;
      const el = glassEv.target.closest?.('.lg');
      if (!el) return;
      const r = el.getBoundingClientRect();
      el.style.setProperty('--mx', glassEv.clientX - r.left + 'px');
      el.style.setProperty('--my', glassEv.clientY - r.top + 'px');
    });
  }, { passive: true });
  const setMaxIcon = (max) => { const b = $('#winCtl [data-w=max]'); if (b) { setIcon(b.firstElementChild, max ? 'wrestore' : 'wmax'); b.title = max ? 'Restaurar' : 'Maximizar'; } document.body.classList.toggle('maximized', !!max); };
  on('window', ({ minimized, maximized }) => {
    if (maximized != null) setMaxIcon(maximized);
    if (!!minimized === document.body.classList.contains('minimized')) return;
    document.body.classList.toggle('minimized', !!minimized);
    if (minimized) {
      // Minimizada (p. ej. jugando): se desmonta la vista para liberar portadas decodificadas e intervalos
      S.cleanup.splice(0).forEach((f) => { try { f(); } catch { } });
      S.parkedScroll = $('#view').scrollTop;
      $('#view').replaceChildren();
      $$('#bg .bg-layer').forEach((l) => (l.style.backgroundImage = ''));
      bgCur = null;
    } else {
      render(false, S.parkedScroll || 0);
      updateBackground();
    }
  });
  call('app.window', { action: 'state' }).then((r) => r && setMaxIcon(r.maximized)).catch(() => { });
  $$('#winCtl .wbtn').forEach((b) => b.addEventListener('click', () => call('app.window', { action: b.dataset.w }).then((r) => r && setMaxIcon(r.maximized)).catch(() => { })));

  document.addEventListener('keydown', onKey);
  const search = $('#search');
  search.addEventListener('input', debounce(() => {
    const q = search.value.trim();
    if (q) go('search', q, { replace: S.view === 'search' });
    else if (S.view === 'search') back();
  }, 180));
  document.addEventListener('mouseup', (e) => { if (e.button === 3) back(); });
  window.addEventListener('beforeunload', () => { P.finish(false); saveQueue(); });

  if (settings.tvMode) { startGamepad(); call('app.fullscreen', { on: true }); }
  render();
}

init().catch((e) => { console.error(e); toast('Error al iniciar: ' + e.message, 8000); });
