const express = require('express'), http = require('http'), { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
const fs = require('fs'), WEB = fs.existsSync(__dirname + '/public/index.html') ? __dirname + '/public' : __dirname;
app.use(express.static(WEB));
app.get('/', (q, res) => res.sendFile(WEB + '/index.html'));

const START = [0, 13, 26, 39], SAFE = new Set([0, 8, 13, 21, 26, 34, 39, 47]);
const SEATS = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] }, BOTS = ['Aria', 'Zed', 'Mika', 'Rex', 'Nova'], rooms = {};
// token progress: -1 yard, 0..50 shared track (relative to start), 51..55 home column, 56 finished

const mkCode = () => { let c; do c = Array.from({ length: 5 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.random() * 32 | 0]).join(''); while (rooms[c]); return c; };
const cur = r => r.players[r.turn], auto = p => p.bot || !p.connected;
const pub = r => ({
  code: r.code, mode: r.mode, host: r.host, started: r.started, tokens: r.tokens, turn: r.turn, dice: r.dice,
  rollN: r.rollN, phase: r.phase, legal: r.phase === 'move' ? r.legal : null, winner: r.winner, last: r.last, mn: r.mn, msg: r.msg,
  players: r.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, color: p.color, bot: p.bot, connected: p.connected }))
});
const push = r => io.to(r.code).emit('state', pub(r));
const later = (r, ms, fn) => { clearTimeout(r.timer); r.timer = setTimeout(() => { if (rooms[r.code] === r) fn(); }, ms); };
const legal = (r, c, d) => [0, 1, 2, 3].filter(i => { const q = r.tokens[c][i]; return q < 0 ? d === 6 : q + d <= 56; });
const hits = (r, c, t) => {
  if (t > 50) return false; const a = (START[c] + t) % 52; if (SAFE.has(a)) return false;
  return r.players.some(p => p.color !== c && r.tokens[p.color].some(q => q >= 0 && q <= 50 && (START[p.color] + q) % 52 === a));
};
function pick(r, c, d, L) {
  const sc = i => { const q = r.tokens[c][i], t = q < 0 ? 0 : q + d; let s = t; if (q < 0) s += 30; if (t === 56) s += 60; if (t <= 50 && SAFE.has((START[c] + t) % 52)) s += 15; if (hits(r, c, t)) s += 80; return s + Math.random(); };
  return L.slice().sort((a, b) => sc(b) - sc(a))[0];
}
function resume(r) {
  const p = cur(r); if (!p || !auto(p) || r.phase === 'over') return;
  if (r.phase === 'roll') later(r, 1100, () => roll(r));
  else if (r.phase === 'move') later(r, 1100, () => move(r, pick(r, p.color, r.dice, r.legal)));
}
function next(r, again) {
  if (!again) { r.sixes = 0; r.turn = (r.turn + 1) % r.players.length; }
  r.phase = 'roll'; r.legal = null; push(r); resume(r);
}
function roll(r) {
  if (r.phase !== 'roll') return; clearTimeout(r.timer);
  const p = cur(r), d = r.dice = 1 + Math.random() * 6 | 0; r.rollN++; r.msg = '';
  r.sixes = d === 6 ? r.sixes + 1 : 0;
  if (r.sixes >= 3) { r.phase = 'wait'; r.msg = 'Three sixes in a row — turn lost!'; push(r); return later(r, 1800, () => next(r, false)); }
  const L = legal(r, p.color, d);
  if (!L.length) { r.phase = 'wait'; push(r); return later(r, 1500, () => next(r, false)); }
  r.phase = 'move'; r.legal = L; push(r);
  if (auto(p)) later(r, 1500, () => move(r, pick(r, p.color, d, L)));
  else if (L.length === 1) later(r, 1200, () => move(r, L[0]));
}
function move(r, i) {
  if (r.phase !== 'move') return; clearTimeout(r.timer);
  const c = cur(r).color, t = r.tokens[c], from = t[i], to = from < 0 ? 0 : from + r.dice, cap = [];
  if (hits(r, c, to)) {
    const a = (START[c] + to) % 52;
    r.players.forEach(o => { if (o.color !== c) r.tokens[o.color].forEach((q, j) => { if (q >= 0 && q <= 50 && (START[o.color] + q) % 52 === a) { r.tokens[o.color][j] = -1; cap.push({ color: o.color, idx: j }); } }); });
  }
  t[i] = to; r.mn++; r.last = { color: c, idx: i, from, to, captured: cap };
  if (t.every(q => q === 56)) { r.phase = 'over'; r.winner = c; r.legal = null; return push(r); }
  next(r, r.dice === 6 || cap.length > 0 || to === 56); // extra turn: six, capture, or reaching home
}
function leave(s) {
  const r = rooms[s.room]; if (!r) return; s.leave(r.code); s.room = null;
  const p = r.players.find(x => x.id === s.id); if (!p) return;
  if (!r.started) { r.players = r.players.filter(x => x !== p); r.players.forEach((x, i) => x.color = SEATS[r.mode][i]); } else p.connected = false;
  const hum = r.players.filter(x => !x.bot && x.connected);
  if (!hum.length) { clearTimeout(r.timer); delete rooms[r.code]; return; }
  if (r.host === s.id) r.host = hum[0].id;
  push(r); if (r.started && cur(r) === p) resume(r); // disconnected player is auto-played by a bot
}
const addPlayer = (r, s, d) => r.players.push({ id: s.id, name: String(d.name || 'Player').slice(0, 14), avatar: String(d.avatar || '🦊').slice(0, 4), color: SEATS[r.mode][r.players.length], bot: false, connected: true });

io.on('connection', s => {
  s.on('create', (d, cb) => {
    leave(s); const mode = [2, 3, 4].includes(+d.mode) ? +d.mode : 4, c = mkCode();
    const r = rooms[c] = { code: c, mode, host: s.id, started: false, players: [], tokens: {}, turn: 0, dice: 0, rollN: 0, mn: 0, phase: 'lobby', sixes: 0, winner: null, last: null, msg: '' };
    addPlayer(r, s, d); s.join(c); s.room = c; cb && cb({ ok: true, code: c }); push(r);
  });
  s.on('join', (d, cb) => {
    leave(s); const r = rooms[String(d.code || '').trim().toUpperCase()];
    if (!r) return cb && cb({ ok: false, err: 'Room not found' });
    if (r.started) return cb && cb({ ok: false, err: 'Game already started' });
    if (r.players.length >= r.mode) return cb && cb({ ok: false, err: 'Room is full' });
    addPlayer(r, s, d); s.join(r.code); s.room = r.code; cb && cb({ ok: true }); push(r);
  });
  s.on('start', () => {
    const r = rooms[s.room]; if (!r || r.started || r.host !== s.id) return; let k = 0;
    while (r.players.length < r.mode) r.players.push({ id: 'bot' + k, name: BOTS[k++ % 5], avatar: '🤖', bot: true, connected: true, color: SEATS[r.mode][r.players.length] });
    r.players.forEach(p => r.tokens[p.color] = [-1, -1, -1, -1]); r.started = true; r.phase = 'roll'; push(r); resume(r);
  });
  s.on('roll', () => { const r = rooms[s.room]; if (r && r.started && r.phase === 'roll' && cur(r).id === s.id) roll(r); });
  s.on('move', i => { const r = rooms[s.room]; if (r && r.phase === 'move' && cur(r).id === s.id && r.legal.includes(i)) move(r, i); });
  s.on('rematch', () => {
    const r = rooms[s.room]; if (!r || r.phase !== 'over' || r.host !== s.id) return;
    r.players.forEach(p => r.tokens[p.color] = [-1, -1, -1, -1]); Object.assign(r, { turn: 0, dice: 0, sixes: 0, winner: null, last: null, msg: '', phase: 'roll', legal: null }); push(r); resume(r);
  });
  const who = () => { const r = rooms[s.room]; return r && { r, p: r.players.find(x => x.id === s.id) }; };
  s.on('chat', t => { const w = who(); if (w && w.p) io.to(w.r.code).emit('chat', { name: w.p.name, avatar: w.p.avatar, color: w.p.color, text: String(t).slice(0, 140) }); });
  s.on('emoji', e => { const w = who(); if (w && w.p) io.to(w.r.code).emit('emoji', { color: w.p.color, e: String(e).slice(0, 4) }); });
  s.on('leave', () => leave(s));
  s.on('disconnect', () => leave(s));
});
srv.listen(process.env.PORT || 3000, () => console.log('Ludo running on http://localhost:' + (process.env.PORT || 3000)));
