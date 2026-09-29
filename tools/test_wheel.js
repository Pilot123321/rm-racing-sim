// Exercise the complete controller script with a small DOM fixture. No browser is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function fixture(options = {}) {
  let now = 1000, nextTimer = 0, nextRaf = 0;
  const elements = new Map(), timers = new Map(), rafs = new Map(), sockets = [], texts = [];
  const events = new Map();
  const on = (type, callback) => { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); };
  const canvasContext = new Proxy({
    fillText(text) { texts.push(String(text)); },
    measureText(text) { return {width: String(text).length * 7}; },
    getImageData(x, y, width, height) { return {data: new Uint8ClampedArray(width * height * 4)}; },
    createRadialGradient() { return {addColorStop() {}}; },
    createLinearGradient() { return {addColorStop() {}}; },
  }, {get(target, key) { return key in target ? target[key] : () => {}; }});
  function node(id) {
    const classes = new Set(), attributes = new Map(), handlers = new Map();
    return {
      id, hidden: false, textContent: '', width: 1280, height: 720,
      dataset: {}, style: {setProperty() {}},
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); },
        toggle(name, force) { const add = force === undefined ? !classes.has(name) : !!force; add ? classes.add(name) : classes.delete(name); return add; },
      },
      setAttribute(name, value) { attributes.set(name, String(value)); },
      getAttribute(name) { return attributes.get(name) ?? null; },
      addEventListener(type, callback) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(callback); },
      dispatch(type, event = {}) { for (const handler of handlers.get(type) || []) handler(event); },
      closest() { return null; }, setPointerCapture() {},
      getContext() { return canvasContext; },
      getBoundingClientRect() { return {left: 0, top: 0, width: this.width, height: this.height}; },
    };
  }
  const element = id => { if (!elements.has(id)) elements.set(id, node(id)); return elements.get(id); };
  const document = {
    body: node('body'), documentElement: {requestFullscreen: async () => {}}, visibilityState: 'visible',
    getElementById: element, createElement: tag => node(tag), addEventListener: on,
    querySelectorAll: () => [], querySelector: () => null,
  };
  const localStorage = {getItem() { return null; }, setItem() {}};
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    open() { this.readyState = 1; this.onopen(); }
    receive(message) { this.onmessage({data: JSON.stringify(message)}); }
    close(code = 1006) { this.readyState = 3; this.onclose({code}); }
  }
  const hud = {
    NAV: {}, setCalm() {}, setTrack() {}, setWorld() {}, setSize() {}, drawScreen() {},
    drawTracker() {}, drawFlagChip() {}, drawNav() {}, wrapS: s => ((s % 1000) + 1000) % 1000,
    dSigned: (a, b) => { const d = ((b - a) % 1000 + 1000) % 1000; return d > 500 ? d - 1000 : d; },
  };
  const context = {
    console, document, navigator: {userAgent: 'test', platform: 'test', maxTouchPoints: 0,
      wakeLock: {request: async () => ({release: async () => {}})},
    },
    location: {search: '?k=test-pair', protocol: 'https:', host: 'example.test'},
    localStorage, sessionStorage: localStorage, performance: {now: () => now}, screen: {orientation: {angle: 90, lock: async () => {}}},
    innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1, isSecureContext: true,
    URLSearchParams, Uint8Array, Uint8ClampedArray, Float64Array, ArrayBuffer, WebSocket: Socket,
    makeHUD: () => hud, addEventListener: on,
    requestAnimationFrame(callback) { const id = ++nextRaf; rafs.set(id, callback); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay, repeat: false}); return id; },
    setInterval(callback, delay) { const id = ++nextTimer; timers.set(id, {callback, delay, repeat: true}); return id; },
    clearTimeout(id) { timers.delete(id); }, clearInterval(id) { timers.delete(id); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/wheel.js'), 'utf8'), context, {filename: 'wheel.js'});
  return {
    context, element, document, sockets, texts, timers,
    async click(id) { await element(id).onclick(); },
    async flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); },
    frame(time = now + 40) {
      now = time;
      const pending = [...rafs.values()]; rafs.clear(); pending.forEach(callback => callback(now));
    },
    runTimeout(delay) { for (const [id, timer] of [...timers]) if (!timer.repeat && timer.delay === delay) { timers.delete(id); timer.callback(); } },
    emit(type, event) { for (const callback of events.get(type) || []) callback(event); },
    interval(delay) { for (const timer of [...timers.values()]) if (timer.repeat && timer.delay === delay) timer.callback(); },
  };
}

function saidHello(socket) { return socket.sent.some(message => message.t === 'hello'); }
function track(src = 'game-a', trackRev = 1) { return {t: 'track', src, trackRev}; }
function state(overrides = {}) {
  return {t: 'w', src: 'game-a', trackRev: 1, worldRev: 1, tw: 1000, tm: 1,
    p: [100, 0, 0, 0, 0, 10, 10, 0, 0, 0, 1, 4000, 0, 0], tr: [], hz: [],
    cm: [0, 1, 0, 0, 0, 0, 1], scr: [1280, 720],
    fov: 60, vis: 100, a: 0, ni: -1, dn: 200, z: 1, ...overrides};
}
function checkProjection() {
  const THREE = require('../public/vendor/three.min.js');
  const context = {window: {}};
  vm.runInNewContext(require('./hud.js')(), context);
  const hud = context.window.makeHUD(), N = 1000;
  hud.setTrack({N, L: N, DS: 1, PX: Array(N).fill(0), PZ: Array.from({length: N}, (_, i) => -i),
    TX: Array(N).fill(0), TZ: Array(N).fill(-1), H: Array(N).fill(0), SL: Array(N).fill(0), C: []});
  for (const [width, height, fov, angles] of [[1280, 720, 60, [0, 0, 0]], [720, 1280, 75, [.1, -.15, .07]], [1536, 864, 52, [-.1, .15, -.08]]]) {
    const camera = new THREE.PerspectiveCamera(fov, width / height, .04, 4000);
    camera.position.set(0, 1, 5); camera.quaternion.setFromEuler(new THREE.Euler(...angles)); camera.updateMatrixWorld();
    // Deliberately non-unit received quaternion models serialization roundoff.
    const cm = [...camera.position.toArray(), ...camera.quaternion.toArray().map(v => v * 1.0005)];
    const expected = new THREE.Vector3(-16, 0, -1).project(camera), points = [];   // the left guardrail, WALL = 16
    const drawing = new Proxy({moveTo(x, y) { points.push([x, y]); }}, {get(target, key) { return key in target ? target[key] : () => {}; }});
    const world = {player: {s: 0}, cm, fov, opts: {hud: false}};
    hud.setSize(width, height); hud.setWorld(world); hud.drawScreen(drawing, world, 0, 0, true);
    assert(points.length, 'HUD draws the first track barrier');
    const error = Math.hypot(points[0][0] - (expected.x * .5 + .5) * width, points[0][1] - (-expected.y * .5 + .5) * height);
    assert(error < 1e-8, `Phone HUD projection matches Three.js across viewport/FOV/pose (error ${error})`);
  }
}

async function main() {
  checkProjection();
  const app = fixture();
  await app.flush();
  app.sockets[0].open();
  assert(saidHello(app.sockets[0]), 'The phone introduces itself to the game');
  app.sockets[0].close();
  app.runTimeout(1000);
  const reconnected = app.sockets.at(-1);
  reconnected.open();
  assert(saidHello(reconnected), 'A reconnect introduces the phone again');
  reconnected.sent.length = 0;
  reconnected.receive({t: 'games', n: 1});
  assert(saidHello(reconnected), 'A game reload gets the phone introduced again');
  await app.click('bCal');
  assert.equal(app.element('recenter').textContent, 'Centred', 'Centre makes the way the phone is held straight ahead');

  const reload = fixture();
  await reload.flush();
  const socket = reload.sockets[0]; socket.open();
  socket.receive(track()); socket.receive(state()); reload.frame();
  assert.equal(reload.context.__view.player.s, 100);
  // A track echo must retain snapshots; a fresh game source must replace both geometry and timing.
  socket.receive(track()); reload.frame(1100);
  assert(reload.context.__view.player.s >= 100);
  // a second sim tab in the same room must not take over while the first is live
  socket.receive(track('game-x', 9)); socket.receive(state({src: 'game-x', trackRev: 9, p: [555, 0, 0, 0, 0, 0]}));
  reload.frame(1120);
  assert(reload.context.__view.player.s !== 555, 'Another game tab in the room does not hijack the phone');
  // a reload of the game page: the relay reports the game gone and back, then the new source is followed
  socket.receive({t: 'games', n: 0}); socket.receive({t: 'games', n: 1});
  socket.receive(track('game-b', 2));
  socket.receive(state({src: 'game-b', trackRev: 2, worldRev: 1, tw: 50, p: [400, 0, 0, 0, 0, 0]}));
  socket.receive(state({src: 'game-a', p: [900, 0, 0, 0, 0, 0]}));
  reload.frame(1140);
  assert.equal(reload.context.__view.player.s, 400, 'Reload discards old source state and clock offset');
  socket.receive(state({src: 'game-b', trackRev: 2, worldRev: 2, tw: 100, p: [700, 0, 0, 0, 0, 0]}));
  reload.frame(1180);
  assert.equal(reload.context.__view.player.s, 700, 'Restart does not interpolate across world revisions');

  // steering sign: phone held sideways (landscape, screen rotation 90), level, then turned clockwise = right
  const wheel = fixture();
  await wheel.flush(); wheel.sockets[0].open();
  await wheel.element('go').onclick();
  const tilt = deg => { const r = deg * Math.PI / 180; for (let i = 0; i < 20; i++) wheel.emit('devicemotion', {accelerationIncludingGravity: {x: 9.81 * Math.cos(r), y: 9.81 * Math.sin(r), z: 0}}); };
  const steer = () => { wheel.interval(25); const m = wheel.sockets[0].sent.filter(x => x && x.t === 'in').at(-1); return m ? m.s : NaN; };
  tilt(0); assert.equal(steer(), 0, 'Level phone steers straight');
  tilt(15); assert(steer() > 0.2, 'Turning the phone clockwise steers right');
  tilt(-15); assert(steer() < -0.2, 'Turning the phone anticlockwise steers left');
  tilt(4); const small = steer(); assert(small > 0 && small < 0.2, 'A small tilt gives a small steer, not full lock');
  // the sim's steering wheel mirrors the phone: the angle sent is the phone's own rotation, in degrees
  const sent = () => wheel.sockets[0].sent.filter(x => x && x.t === 'in').at(-1);
  tilt(15); steer(); assert(Math.abs(sent().a - 15) < 1.5, `The phone sends its own angle for the sim's wheel (${sent().a}° at 15°)`);
  tilt(-30); steer(); assert(Math.abs(sent().a + 30) < 1.5, `...and anticlockwise too (${sent().a}° at -30°)`);

  console.log('wheel runtime checks passed');
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = {fixture};
