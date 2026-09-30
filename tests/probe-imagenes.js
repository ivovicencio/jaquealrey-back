// Probe puntual: confirma que las fotos se piden y se aplican, sin correr T1 entero.
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
    return r.result.value;
  };

  for (const ruta of ['/', '/habitaciones', '/habitaciones/1']) {
    await env('Page.navigate', { url: APP + ruta }, sessionId);
    await new Promise((r) => setTimeout(r, 3500));

    const fondos = await ev(`JSON.stringify([...document.querySelectorAll('.room-image, .hero-bg, .hotel-info-bg')]
      .map(el => {
        const b = getComputedStyle(el).backgroundImage;
        const m = b.match(/url\\(["']?([^"')]+)/);
        return { clases: el.className, foto: m ? m[1] : null, tieneGradiente: b.includes('gradient') };
      }))`);

    const cargadas = await ev(`JSON.stringify(performance.getEntriesByType('resource')
      .filter(e => /\\.(jpe?g|png|webp)/.test(e.name))
      .map(e => ({ url: e.name.split('/').pop(), kb: Math.round(e.transferSize/1024) })))`);

    console.log(`\n--- ${ruta} ---`);
    console.log('  fondos:', fondos);
    console.log('  imagenes pedidas:', cargadas);
  }

  process.exit(0);
})();
