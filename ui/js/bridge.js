// Puente con el host nativo (.NET + WebView2)
const pending = new Map();
const listeners = {};
let seq = 0;
const wv = window.chrome && window.chrome.webview;

if (wv) {
  wv.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.ev) { (listeners[m.ev] || []).forEach((f) => { try { f(m.data); } catch (err) { console.error(err); } }); return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.res(m.data) : p.rej(new Error(m.error || 'Error'));
  });
}

export const hasHost = !!wv;

export function call(cmd, args) {
  if (!wv) return Promise.reject(new Error('Sonora debe abrirse desde la aplicación de escritorio'));
  const id = ++seq;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    wv.postMessage({ id, cmd, args: args ?? {} });
  });
}

export function on(ev, fn) { (listeners[ev] ||= []).push(fn); }
