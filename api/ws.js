// Cloud relay for the Vercel site: the same game <-> phone relay as server.js, but in private rooms.
// The game makes a random room code and puts it in the phone link; whoever has the code is paired. Both devices only
// talk to Vercel, so neither ever learns the other's address and no home IP appears in any link.
// Sockets on the same function instance are relayed in memory. If REDIS_URL is set, instances also relay to each
// other over Redis pub/sub, and only for rooms that really have a peer on another instance (keeps Redis traffic low).
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const INST = crypto.randomBytes(6).toString('hex');  // 12 chars, prefixes every bus message
const ROOM_RE = /^[A-Za-z0-9_-]{12,40}$/;
const rooms = new Map();  // code -> { game: Set, wheel: Set, remote: Map(instance -> { g: games, w: [phone ids] }) }

function send(set, data, binary) { for (const c of set) if (c.readyState === 1 && !(binary && c.bufferedAmount > 400000)) c.send(data, { binary: !!binary }); }
function remoteHas(r, role) { for (const v of r.remote.values()) if (role === 'game' ? v.g > 0 : v.w.length > 0) return true; return false; }
function phonesChanged(k) {
  const r = rooms.get(k); if (!r) return;
  const ids = [...r.wheel].map(w => w.phoneId); let g = r.game.size;
  for (const v of r.remote.values()) { ids.push(...v.w); g += v.g; }
  send(r.game, JSON.stringify({ t: 'phones', n: ids.length, ids }));
  send(r.wheel, JSON.stringify({ t: 'games', n: g }));
}

// --- optional Redis bus. Message: instance id (12) + kind ('g' to games, 'w' to wheels, 'c' roster changed) + 'b'|'t' + payload
let pub = null, sub = null;
const REDIS = process.env.REDIS_URL || process.env.KV_URL;   // Redis Cloud sets REDIS_URL, Upstash also KV_URL
if (REDIS) {
  const { createClient } = require('redis');
  pub = createClient({ url: REDIS }); sub = pub.duplicate();
  pub.on('error', e => console.error('redis', e.message)); sub.on('error', e => console.error('redis sub', e.message));
  Promise.all([pub.connect(), sub.connect()]).catch(e => { console.error('redis off:', e.message); pub = sub = null; });
}
const CH = k => 'lar:' + k, RK = k => 'lar:r:' + k;
function publish(k, kind, data, binary) {
  if (!pub) return;
  pub.publish(CH(k), Buffer.concat([Buffer.from(INST + kind + (binary ? 'b' : 't')), Buffer.isBuffer(data) ? data : Buffer.from(data)])).catch(() => {});
}
function onBus(k, msg) {
  if (msg.toString('latin1', 0, 12) === INST) return;
  const r = rooms.get(k); if (!r) return;
  const kind = String.fromCharCode(msg[12]), bin = msg[13] === 98, body = msg.subarray(14);
  if (kind === 'c') { loadRoster(k); return; }
  send(kind === 'g' ? r.game : r.wheel, bin ? body : body.toString(), bin);
}
async function saveRoster(k) {
  if (!pub) return;
  const r = rooms.get(k), me = { g: r ? r.game.size : 0, w: r ? [...r.wheel].map(w => w.phoneId) : [] };
  try {
    if (me.g || me.w.length) { await pub.set(RK(k) + ':' + INST, JSON.stringify(me), { EX: 90 }); await pub.sAdd(RK(k), INST); await pub.expire(RK(k), 120); }
    else { await pub.del(RK(k) + ':' + INST); await pub.sRem(RK(k), INST); }
    publish(k, 'c', '');
  } catch (e) {}
}
async function loadRoster(k) {
  if (!pub) return;
  try {
    const ids = (await pub.sMembers(RK(k))).filter(i => i !== INST);
    const vals = ids.length ? await pub.mGet(ids.map(i => RK(k) + ':' + i)) : [];
    const r = rooms.get(k); if (!r) return;
    r.remote = new Map(); ids.forEach((i, n) => { if (vals[n]) r.remote.set(i, JSON.parse(vals[n])); });
  } catch (e) {}
  phonesChanged(k);
}
// refresh this instance's roster entries (they expire if the instance dies) and drop peers that went away
setInterval(() => { for (const k of rooms.keys()) saveRoster(k).then(() => loadRoster(k)); }, 30000).unref();

const server = http.createServer((req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('WebSocket only'); });
const wss = new WebSocketServer({ server, maxPayload: 4 << 20 });
setInterval(() => { for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; try { c.ping(); } catch (e) {} } }, 15000).unref();

// multiplayer: racers in the same room code relay their cars to each other (and, with Redis, across instances)
const races = new Map();   // code -> Set of sockets
const RCH = c => 'lar:race:' + c;
wss.on('connection', (ws, req) => {
  const q0 = new URL(req.url, 'http://x').searchParams;
  if (q0.get('role') === 'race') {
    const code = q0.get('r') || '';
    if (!/^[A-Za-z0-9_-]{4,24}$/.test(code)) { ws.close(4001, 'Bad room code'); return; }
    let room = races.get(code);
    if (!room) { room = new Set(); races.set(code, room); if (sub) sub.subscribe(RCH(code), m => { if (m.toString('latin1', 0, 12) !== INST) send(room, m.subarray(12).toString()); }, true).catch(() => {}); }
    room.add(ws); ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', (data, isBinary) => {
      const d = isBinary ? data : data.toString();
      for (const c of room) if (c !== ws && c.readyState === 1 && c.bufferedAmount < 400000) c.send(d, { binary: isBinary });
      if (pub && !isBinary) pub.publish(RCH(code), Buffer.concat([Buffer.from(INST), Buffer.from(d)])).catch(() => {});
    });
    ws.on('close', () => { room.delete(ws); if (!room.size) { races.delete(code); if (sub) sub.unsubscribe(RCH(code)).catch(() => {}); } });
    return;
  }
  const q = q0, k = q.get('k') || '', role = q.get('role') === 'wheel' ? 'wheel' : 'game';
  if (!ROOM_RE.test(k)) { ws.close(4001, 'Not paired'); return; }
  ws.phoneId = (q.get('id') || 'phone').slice(0, 24);
  let r = rooms.get(k);
  if (!r) {
    r = { game: new Set(), wheel: new Set(), remote: new Map() }; rooms.set(k, r);
    if (sub) sub.subscribe(CH(k), m => onBus(k, m), true).catch(() => {});
  }
  const mine = role === 'wheel' ? r.wheel : r.game, other = role === 'wheel' ? r.game : r.wheel, otherRole = role === 'wheel' ? 'game' : 'wheel';
  mine.add(ws); phonesChanged(k); saveRoster(k).then(() => loadRoster(k));
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data, isBinary) => {
    const d = isBinary ? data : data.toString();
    send(other, d, isBinary);
    if (remoteHas(r, otherRole)) publish(k, otherRole === 'game' ? 'g' : 'w', d, isBinary);
  });
  ws.on('close', () => {
    mine.delete(ws);
    if (role === 'wheel') { const bye = JSON.stringify({ t: 'bye', id: ws.phoneId }); send(r.game, bye); if (remoteHas(r, 'game')) publish(k, 'g', bye); }
    if (!r.game.size && !r.wheel.size) { rooms.delete(k); if (sub) sub.unsubscribe(CH(k)).catch(() => {}); }
    phonesChanged(k); saveRoster(k);
  });
});

module.exports = server;
