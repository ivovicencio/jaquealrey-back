// Verifica que cada habitacion del catalogo tenga una foto real (no 404 + gradiente).
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
    return r.exceptionDetails ? 'ERR' : r.result.value;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await env('Page.navigate', { url: APP + '/habitaciones' }, sessionId);
  await wait(5000);

  const fotos = await ev(`JSON.stringify([...document.querySelectorAll('.room-image')]
    .map(el => (getComputedStyle(el).backgroundImage.match(/url\\(["']?([^"')]+)/) || [])[1]))`);
  console.log('fotos pedidas:', fotos);

  // Cada URL realmente responde 200 con contenido?
  const arr = JSON.parse(fotos || '[]');
  let malas = 0;
  for (const u of arr) {
    if (!u) { console.log('  SIN FOTO'); malas++; continue; }
    const res = await fetch(u);
    const ok = res.status === 200 && Number(res.headers.get('content-length') || 1) > 1000;
    if (!ok) { console.log(`  FALLA ${res.status} ${u}`); malas++; }
  }
  console.log(malas === 0 ? `OK  las ${arr.length} habitaciones cargan foto real` : `${malas} con problema`);

  process.exit(0);
})();
