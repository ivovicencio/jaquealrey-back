// Probe puntual del FlowingMenu: abre el menu, hace hover, navega y cierra.
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
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const ok = (c, m) => console.log(`${c ? 'OK  ' : 'FAIL'} ${m}`);

  await env('Page.navigate', { url: APP + '/' }, sessionId);
  await wait(4000);

  const items = await ev(`document.querySelectorAll('app-flowing-menu-item').length`);
  ok(items === 4, `items en el menu: ${items} (esperado 4 para visitante)`);

  ok(await ev(`getComputedStyle(document.querySelector('.hamburger')).display !== 'none'`),
    'el hamburguer se ve en desktop');

  await ev(`document.querySelector('.hamburger').click()`);
  await wait(900);

  ok(await ev(`document.querySelector('.fullmenu').classList.contains('open')`), 'menu abierto');
  ok(await ev(`getComputedStyle(document.querySelector('.fullmenu')).visibility === 'visible'`), 'overlay visible');
  ok(await ev(`getComputedStyle(document.body).overflow === 'hidden'`), 'scroll del body bloqueado');

  const cop = await ev(`document.querySelectorAll('.marquee__part').length / ${items}`);
  ok(cop >= 4, `copias del marquee por item: ${cop} (minimo 4)`);

  ok(await ev(`getComputedStyle(document.querySelector('.marquee__img')).backgroundImage.includes('/assets/')`),
    'el marquee trae foto de /assets');

  await env('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 640, y: 400, button: 'none' }, sessionId);
  await wait(1200);
  const mq = await ev(`(() => {
    const m = document.querySelector('.marquee');
    return { transform: getComputedStyle(m).transform, y: getComputedStyle(m).transform };
  })()`);
  ok(!/matrix.*matrix\((0, 0, 0, 0, 0, 0)/.test(JSON.stringify(mq)), 'el marquee se movio con el hover');

  await ev(`document.querySelectorAll('.menu__item-link')[1].click()`);
  await wait(2500);
  ok(await ev(`location.pathname === '/habitaciones'`), `navego a ${await ev('location.pathname')}`);
  ok(await ev(`!document.querySelector('.fullmenu').classList.contains('open')`), 'el menu se cerro al navegar');
  ok(await ev(`getComputedStyle(document.body).overflow !== 'hidden'`), 'scroll del body liberado');

  process.exit(0);
})();
