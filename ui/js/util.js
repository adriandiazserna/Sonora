// Utilidades de interfaz
const SVG = 'http://www.w3.org/2000/svg';

// append/replaceChildren ignoran null/false (si no, el DOM los escribe como texto "null")
for (const m of ['append', 'replaceChildren', 'prepend']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...n) { return orig.apply(this, n.filter((x) => x != null && x !== false)); };
}

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Crea elementos: h('div', {class:'x', onClick: fn}, hijos...) */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv);
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (typeof v === 'boolean' || (typeof v !== 'string' && k in el)) el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const c of kids) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = '') {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', 'i ' + cls);
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', '#i-' + name);
  s.append(u);
  return s;
}

export function setIcon(svg, name) { svg.firstChild.setAttribute('href', '#i-' + name); }

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  s = Math.floor(s);
  const hh = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function fmtLong(s) {
  const hh = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return hh ? `${hh} h ${m} min` : `${m} min`;
}

export const fmtNum = (n) => new Intl.NumberFormat('es-MX', { notation: n > 99999 ? 'compact' : 'standard' }).format(n || 0);

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function shuffleArr(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

/** Color de acento a partir de una imagen (mismo origen → canvas no se contamina) */
const accentCache = new Map();
export function accentFrom(url) {
  if (accentCache.has(url)) return Promise.resolve(accentCache.get(url));
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 24;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0, 24, 24);
        const d = x.getImageData(0, 0, 24, 24).data;
        let best = null, bestScore = -1, ar = 0, ag = 0, ab = 0;
        const buckets = new Map();
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i], g = d[i + 1], b = d[i + 2];
          ar += r; ag += g; ab += b;
          const [hh, s, l] = rgbToHsl(r, g, b);
          if (l < .18 || l > .85 || s < .25) continue;
          const key = Math.round(hh * 18);
          const bk = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, s: 0 };
          bk.n++; bk.r += r; bk.g += g; bk.b += b; bk.s += s;
          buckets.set(key, bk);
        }
        for (const bk of buckets.values()) {
          const score = bk.n * (bk.s / bk.n);
          if (score > bestScore) { bestScore = score; best = bk; }
        }
        let rgb = best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [ar / 576, ag / 576, ab / 576];
        rgb = vivid(rgb);
        accentCache.set(url, rgb);
        res(rgb);
      } catch { res(null); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
}

/**
 * Desenfoque "horneado": dibuja la imagen en un canvas diminuto con blur y saturación y devuelve un data URL.
 * Al estirarse con CSS se ve como un desenfoque fuerte, sin que la GPU tenga que aplicar filtros en cada fotograma.
 */
const blurCache = new Map();
export function softBlur(url, amount = 40) {
  const size = Math.max(16, Math.min(96, Math.round(110 - amount)));
  const key = url + '|' + size;
  if (blurCache.has(key)) return blurCache.get(key);
  const p = new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = size;
        const x = c.getContext('2d');
        x.filter = 'blur(2px) saturate(1.5)';
        x.drawImage(img, -4, -4, size + 8, size + 8);
        res(c.toDataURL('image/jpeg', 0.85));
      } catch { res(url); }
    };
    img.onerror = () => res(null);
    img.src = url;
  });
  blurCache.set(key, p);
  if (blurCache.size > 60) blurCache.delete(blurCache.keys().next().value);
  return p;
}

function vivid([r, g, b]) {
  let [hh, s, l] = rgbToHsl(r, g, b);
  s = Math.max(s, .55); l = Math.min(Math.max(l, .55), .68);
  return hslToRgb(hh, s, l);
}

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let hh = 0, s = 0; const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    hh = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    hh /= 6;
  }
  return [hh, s, l];
}

export function hslToRgb(hh, s, l) {
  const f = (n) => {
    const k = (n + hh * 12) % 12, a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)].map(Math.round);
}

export const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
export function hexToRgb(hx) { const n = parseInt(hx.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

/** Lista virtual: solo dibuja las filas visibles (miles de canciones sin coste de RAM) */
export class VirtualList {
  constructor(scroller, host, rowH, render) {
    this.scroller = scroller; this.rowH = rowH; this.render = render; this.items = [];
    this.host = host; host.classList.add('vlist');
    this.rows = h('div', { class: 'rows' }); host.append(this.rows);
    this.onScroll = () => { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); };
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.ro = new ResizeObserver(this.onScroll); this.ro.observe(scroller);
  }
  set(items) {
    this.items = items; this.host.style.height = items.length * this.rowH + 'px'; this.first = -1;
    if (this.host.isConnected) this.draw(true); else requestAnimationFrame(() => this.draw(true));
  }
  draw(force) {
    if (!this.host.isConnected) return;
    const top = this.host.getBoundingClientRect().top - this.scroller.getBoundingClientRect().top + this.scroller.scrollTop;
    const st = this.scroller.scrollTop - top, vh = this.scroller.clientHeight;
    const first = Math.max(0, Math.floor(st / this.rowH) - 8);
    const last = Math.min(this.items.length, Math.ceil((st + vh) / this.rowH) + 8);
    if (!force && first === this.first && last === this.last) return;
    this.first = first; this.last = last;
    this.rows.style.transform = `translateY(${first * this.rowH}px)`;
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) frag.append(this.render(this.items[i], i));
    this.rows.replaceChildren(frag);
  }
  refresh() { this.draw(true); }
  destroy() { this.scroller.removeEventListener('scroll', this.onScroll); this.ro.disconnect(); }
}

/** Slider personalizado (horizontal o vertical) */
export function slider({ min = 0, max = 1, step = 0, value = 0, vertical = false, bipolar = false, onInput, onChange, cls = '' }) {
  const el = h('div', { class: 'range ' + (vertical ? 'vert ' : '') + cls, tabindex: 0 },
    h('div', { class: 'track' }, h('div', { class: 'buf' }), h('div', { class: 'fill' })), h('div', { class: 'knob' }));
  let v = value;
  const pct = () => ((v - min) / (max - min)) * 100;
  const fill = el.querySelector('.fill');
  const paint = () => {
    const p = pct();
    el.style.setProperty('--p', p + '%');
    if (bipolar) { // la barra sale desde el centro (0 dB)
      const lo = Math.min(p, 50) + '%', len = Math.abs(p - 50) + '%';
      if (vertical) { fill.style.bottom = lo; fill.style.height = len; } else { fill.style.left = lo; fill.style.width = len; }
    }
  };
  const fromEvent = (e) => {
    const r = el.getBoundingClientRect();
    let p = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    p = Math.min(1, Math.max(0, p));
    let nv = min + p * (max - min);
    if (step) nv = Math.round(nv / step) * step;
    return nv;
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); el.classList.add('drag');
    v = fromEvent(e); paint(); onInput && onInput(v);
    const move = (ev) => { v = fromEvent(ev); paint(); onInput && onInput(v); };
    const up = () => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); onChange && onChange(v); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    const s = step || (max - min) / 50;
    v = Math.min(max, Math.max(min, v + (e.deltaY < 0 ? s : -s))); paint(); onInput && onInput(v); onChange && onChange(v);
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const s = step || (max - min) / 50;
    const inc = vertical ? { ArrowUp: 1, ArrowDown: -1 } : { ArrowRight: 1, ArrowLeft: -1 };
    if (!(e.key in inc) || document.body.classList.contains('tv') && !e.shiftKey && !vertical) return;
    e.preventDefault(); e.stopPropagation();
    v = Math.min(max, Math.max(min, v + inc[e.key] * s)); paint(); onInput && onInput(v); onChange && onChange(v);
  });
  el.set = (nv) => { if (el.classList.contains('drag')) return; v = nv; paint(); };
  el.setBuf = (p) => { el.querySelector('.buf').style.width = p * 100 + '%'; };
  el.get = () => v;
  paint();
  return el;
}

export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}

/** Menú contextual */
export function contextMenu(x, y, items) {
  closeMenus();
  const m = h('div', { class: 'ctx' }, items.map((it) => it === '-' ? h('hr') :
    h('button', { onClick: () => { closeMenus(); it.run(); } }, it.icon ? icon(it.icon, 'sm') : null, it.label)));
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  m.querySelector('button')?.focus();
  setTimeout(() => document.addEventListener('pointerdown', outside, { once: true }), 0);
  function outside(e) { if (!m.contains(e.target)) closeMenus(); else document.addEventListener('pointerdown', outside, { once: true }); }
}
export function closeMenus() { $$('.ctx').forEach((m) => m.remove()); }

/** Imagen con aparición suave y respaldo */
export function lazyImg(src, alt = '', fallback) {
  const img = h('img', { alt, loading: 'lazy', decoding: 'async', draggable: false });
  img.onload = () => img.classList.add('ok');
  img.onerror = () => { img.remove(); fallback && fallback(); };
  if (src) img.src = src; else setTimeout(() => img.onerror(), 0);
  return img;
}

/** Navegación espacial para TV / mando (flechas) */
export function spatialMove(dir) {
  const cur = document.activeElement;
  const sel = 'button:not([disabled]), [tabindex="0"], a[href], input, .card, .trow[tabindex], .gcard, .arow, .qitem';
  const all = $$(sel).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && e.offsetParent !== null; });
  if (!cur || cur === document.body || !all.includes(cur)) { all[0]?.focus(); return; }
  const c = cur.getBoundingClientRect(), cx = c.left + c.width / 2, cy = c.top + c.height / 2;
  let best = null, bd = Infinity;
  for (const e of all) {
    if (e === cur) continue;
    const r = e.getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const dx = x - cx, dy = y - cy;
    const ok = dir === 'left' ? dx < -4 : dir === 'right' ? dx > 4 : dir === 'up' ? dy < -4 : dy > 4;
    if (!ok) continue;
    const main = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
    const cross = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
    const d = main + cross * 2.5;
    if (d < bd) { bd = d; best = e; }
  }
  if (best) { best.focus({ preventScroll: true }); best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); }
}
