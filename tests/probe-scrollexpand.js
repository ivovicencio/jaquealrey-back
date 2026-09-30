// Diagnostico puntual del ScrollExpand: dims reales, src y si la imagen cargo.
const WebSocket = require('ws');
const APP = process.argv[2] || 'http://localhost:4200';

(async () => {
  const v = await (await fetch('http://localhost:9222/json/version')).json();
  const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });

  let id = 0;
  const pend = new Map();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  });
  const env = (method, params = {}, sessionId) => {
    const i = ++id;
    ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((r) => pend.set(i, r));
  };

  const { targetId } = await env('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await env('Target.attachToTarget', { targetId, flatten: true });
  await env('Page.enable', {}, sessionId);
  await env('Runtime.enable', {}, sessionId);
  const ev = async (e) => {
    const r = await env('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) return 'EXCEPCION: ' + (r.exceptionDetails.exception?.description || '').split('\n')[0];
    return r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await env('Page.navigate', { url: APP + '/' }, sessionId);
  // El bloque esta mas abajo del fold: hay que scrollear hasta el rooms.
  await wait(5000);
  await ev(`document.querySelector('app-scroll-expand')?.scrollIntoView({block:'center'})`);
  await wait(1500);

  console.log('track :', await ev(`(() => { const t = document.querySelector('.scroll-expand__track'); return t ? t.style.height + ' / offset ' + t.offsetHeight : 'NO EXISTE'; })()`));
  console.log('stage :', await ev(`(() => { const s = document.querySelector('.scroll-expand__stage'); return s ? s.style.height + ' / offset ' + s.offsetHeight : 'NO EXISTE'; })()`));
  console.log('frame :', await ev(`(() => { const f = document.querySelector('.scroll-expand__frame'); return f ? f.offsetWidth + 'x' + f.offsetHeight + ' clip=' + f.style.clipPath : 'NO EXISTE'; })()`));
  console.log('media :', await ev(`(() => { const m = document.querySelector('.scroll-expand__media'); if (!m) return 'NO EXISTE'; const c = getComputedStyle(m); return JSON.stringify({ tag: m.tagName, src: m.getAttribute('src'), natural: m.naturalWidth + 'x' + m.naturalHeight, box: m.offsetWidth + 'x' + m.offsetHeight, pos: c.position, op: c.opacity, vis: c.visibility, z: c.zIndex, tf: c.transform }); })()`));
  console.log('fondo de la seccion:', await ev(`(() => { const r = document.querySelector('.rooms'); return r ? getComputedStyle(r).backgroundColor : '?'; })()`));

  process.exit(0);
})();
