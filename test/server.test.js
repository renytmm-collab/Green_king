const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createAppServer, rooms, GAME_CONFIG, MAP_CONFIG, ROUTE_CONFIG, createMap, cellFor, makeRoom, buildingCenter, applyMineIncome, build, validateRoute, createRoute } = require('../server');

function mockSocket(roomId, playerId) { return { readyState: WebSocket.OPEN, roomId, playerId, messages: [], send(data) { this.messages.push(JSON.parse(data)); } }; }
function readyRoom(id = 'test-room') { const room = makeRoom(); const p1 = mockSocket(id, 'player1'); const p2 = mockSocket(id, 'player2'); room.players.set('player1', { socket: p1 }); room.players.set('player2', { socket: p2 }); rooms.set(id, room); return { room, p1, p2 }; }
function inbox(socket) {
  const queued = []; const waiting = [];
  socket.on('message', (data) => { const message = JSON.parse(data); const resolve = waiting.shift(); if (resolve) resolve(message); else queued.push(message); });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => waiting.push(resolve));
}
function routePoints(room, barracksId, targetId) { return [buildingCenter(room.buildings.get(barracksId)), { x: .2, y: .2 }, { x: .8, y: .2 }, buildingCenter(room.buildings.get(targetId))]; }

test.afterEach(() => rooms.clear());

test('map is a deterministic symmetric 9x18 grid without nodes or edges', () => {
  const map = createMap(); assert.equal(map.rows, 9); assert.equal(map.columns, 18); assert.equal(map.cells.length, 162);
  assert.equal(new Set(map.cells.map((cell) => `${cell.row}:${cell.column}`)).size, 162);
  for (const cell of map.cells) { assert.ok(['player1', 'player2', 'neutral'].includes(cell.territory)); assert.equal(cell.territory, cellFor(map, cell.row, map.columns - 1 - cell.column).territory === 'player1' ? 'player2' : cellFor(map, cell.row, map.columns - 1 - cell.column).territory === 'player2' ? 'player1' : 'neutral'); }
  assert.ok(map.cells.filter((cell) => cell.territory === 'neutral').every((cell) => !cell.buildable)); assert.equal('edges' in map, false); assert.equal('nodes' in map, false);
});

test('rooms own independent maps and symmetric server-created castles', () => {
  const first = makeRoom(); const second = makeRoom(); first.map.cells[0].blocked = true;
  assert.equal(second.map.cells[0].blocked, false); assert.equal(first.buildings.size, 2);
  const castles = [...first.buildings.values()]; assert.deepEqual(castles.map((item) => item.type), ['castle', 'castle']);
  assert.equal(castles[0].row, castles[1].row); assert.equal(castles[0].column + castles[1].column, MAP_CONFIG.columns - 1);
  assert.ok(castles.every((castle) => cellFor(first.map, castle.row, castle.column).buildingId === castle.id));
});

test('players can build all supported types on owned empty cells with authoritative costs', () => {
  const { room, p1, p2 } = readyRoom();
  const mine = build(p1, 1, 2, 'mine'); const tower = build(p1, 2, 2, 'tower'); const barracks = build(p2, 1, 15, 'barracks');
  assert.equal(mine.type, 'mine'); assert.equal(tower.type, 'tower'); assert.equal(barracks.owner, 'player2');
  assert.equal(room.playerState.player1.gold, 400 - 100 - 150); assert.equal(room.playerState.player2.gold, 400 - 180);
  assert.equal(cellFor(room.map, 1, 2).buildingId, mine.id); assert.equal(new Set([mine.id, tower.id, barracks.id]).size, 3);
});

test('build rejects enemy, neutral, occupied, out-of-map, non-integer and unknown requests without charging', () => {
  const { room, p1 } = readyRoom(); const initial = room.playerState.player1.gold;
  build(p1, 2, 15, 'mine'); build(p1, 2, 8, 'mine'); build(p1, 4, 1, 'mine'); build(p1, -1, 2, 'mine'); build(p1, 1.5, 2, 'mine'); build(p1, 1, 2, 'castle');
  assert.equal(room.playerState.player1.gold, initial); assert.equal(p1.messages.filter((message) => message.type === 'action_rejected').length, 6);
});

test('rapid duplicate build succeeds only once', () => {
  const { room, p1 } = readyRoom(); build(p1, 1, 2, 'mine'); build(p1, 1, 2, 'mine');
  assert.equal([...room.buildings.values()].filter((item) => item.row === 1 && item.column === 2).length, 1); assert.equal(room.playerState.player1.gold, 300);
});

test('mine income accumulates by owner and is isolated between rooms', () => {
  const { room, p1, p2 } = readyRoom('income-a'); build(p1, 1, 2, 'mine'); build(p1, 2, 2, 'mine'); build(p2, 1, 15, 'mine');
  const other = readyRoom('income-b').room; const beforeOther = other.playerState.player1.gold;
  const before1 = room.playerState.player1.gold; const before2 = room.playerState.player2.gold; assert.equal(applyMineIncome(room), true);
  assert.equal(room.playerState.player1.gold, before1 + 2 * GAME_CONFIG.mineIncome); assert.equal(room.playerState.player2.gold, before2 + GAME_CONFIG.mineIncome); assert.equal(other.playerState.player1.gold, beforeOther);
  room.players.clear(); assert.equal(applyMineIncome(room), false);
});

test('route format rejects missing, short, oversized, non-finite and out-of-range points', () => {
  const { room, p1 } = readyRoom(); const barracks = build(p1, 4, 2, 'barracks'); const target = 'player2_castle'; const start = buildingCenter(barracks); const end = buildingCenter(room.buildings.get(target));
  const cases = [null, [start], Array.from({ length: ROUTE_CONFIG.maxPoints + 1 }, () => start), [start, { x: 'x', y: .2 }, end], [start, { x: Infinity, y: .2 }, end], [start, { x: 1.1, y: .2 }, end]];
  for (const points of cases) assert.ok(validateRoute(room, 'player1', barracks.id, target, points));
});

test('route authority requires an owned barracks and enemy building target', () => {
  const { room, p1, p2 } = readyRoom(); const barracks = build(p1, 4, 2, 'barracks'); const mine = build(p1, 1, 2, 'mine'); const points = routePoints(room, barracks.id, 'player2_castle');
  assert.match(validateRoute(room, 'player2', barracks.id, 'player1_castle', points), /own barracks/); assert.match(validateRoute(room, 'player1', mine.id, 'player2_castle', points), /start from a barracks/); assert.match(validateRoute(room, 'player1', barracks.id, 'player1_castle', points), /enemy/);
  createRoute(p2, barracks.id, 'player1_castle', points); assert.equal(p2.messages.at(-1).type, 'action_rejected');
});

test('route must begin and end at matching buildings and respect length limits', () => {
  const { room, p1 } = readyRoom(); const barracks = build(p1, 4, 2, 'barracks'); const target = 'player2_castle'; const valid = routePoints(room, barracks.id, target);
  const wrongStart = valid.map((point) => ({ ...point })); wrongStart[0] = { x: .5, y: .5 };
  const wrongEnd = valid.map((point) => ({ ...point })); wrongEnd[wrongEnd.length - 1] = { x: .5, y: .5 };
  assert.match(validateRoute(room, 'player1', barracks.id, target, wrongStart), /start/); assert.match(validateRoute(room, 'player1', barracks.id, target, wrongEnd), /end/);
  const looping = [valid[0]]; for (let i = 0; i < 20; i += 1) looping.push({ x: i % 2, y: i % 2 }); looping.push(valid.at(-1)); assert.match(validateRoute(room, 'player1', barracks.id, target, looping), /too long/);
});

test('route collision rejects crossing another building but permits leaving start and entering target', () => {
  const { room, p1 } = readyRoom(); const barracks = build(p1, 4, 2, 'barracks'); build(p1, 4, 5, 'mine'); const target = 'player2_castle'; const start = buildingCenter(barracks); const end = buildingCenter(room.buildings.get(target));
  assert.match(validateRoute(room, 'player1', barracks.id, target, [start, end]), /another building/); assert.equal(validateRoute(room, 'player1', barracks.id, target, routePoints(room, barracks.id, target)), null);
});

test('valid polyline is stored, broadcast, and replaced per barracks without changing route id', () => {
  const { room, p1, p2 } = readyRoom(); const barracks = build(p1, 4, 2, 'barracks'); const target = 'player2_castle'; const first = createRoute(p1, barracks.id, target, routePoints(room, barracks.id, target));
  assert.equal(room.routes.length, 1); assert.equal(first.points.length, 4); assert.ok(p2.messages.some((message) => message.type === 'game_state' && message.routes[0]?.id === first.id));
  const replacement = [buildingCenter(barracks), { x: .2, y: .75 }, { x: .8, y: .75 }, buildingCenter(room.buildings.get(target))]; const second = createRoute(p1, barracks.id, target, replacement);
  assert.equal(room.routes.length, 1); assert.equal(second.id, first.id); assert.deepEqual(room.routes[0].points, replacement);
});

test('invalid replacement preserves the prior route', () => {
  const { room, p1 } = readyRoom(); const barracks = build(p1, 4, 2, 'barracks'); const target = 'player2_castle'; createRoute(p1, barracks.id, target, routePoints(room, barracks.id, target)); const before = structuredClone(room.routes[0]);
  createRoute(p1, barracks.id, target, [{ x: .5, y: .5 }, { x: .6, y: .6 }]); assert.deepEqual(room.routes[0], before); assert.equal(p1.messages.at(-1).type, 'action_rejected');
});

test('two players receive roles, full grid state, and pointer forwarding over WebSocket', async (t) => {
  const { server, wss } = createAppServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { for (const client of wss.clients) client.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const first = new WebSocket(`ws://127.0.0.1:${port}`); const firstMessage = inbox(first); await new Promise((resolve) => first.once('open', resolve)); first.send(JSON.stringify({ type: 'create_room' })); const welcome1 = await firstMessage(); const initialState = await firstMessage();
  assert.equal(welcome1.playerId, 'player1'); assert.equal(initialState.map.cells.length, MAP_CONFIG.rows * MAP_CONFIG.columns); assert.equal(initialState.buildings.length, 2); assert.equal('nodes' in initialState, false); assert.equal('edges' in initialState, false);
  const second = new WebSocket(`ws://127.0.0.1:${port}`); const secondMessage = inbox(second); await new Promise((resolve) => second.once('open', resolve)); second.send(JSON.stringify({ type: 'join_room', roomId: welcome1.roomId })); const welcome2 = await secondMessage(); await secondMessage(); assert.equal(welcome2.playerId, 'player2'); assert.equal((await firstMessage()).type, 'opponent_joined');
  first.send(JSON.stringify({ type: 'pointer_click', x: .25, y: .75 })); assert.deepEqual(await secondMessage(), { type: 'opponent_pointer', playerId: 'player1', x: .25, y: .75 });
});

test('third player and invalid JSON are rejected without stopping the server', async (t) => {
  const { server, wss } = createAppServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
  t.after(async () => { for (const client of wss.clients) client.terminate(); await new Promise((resolve) => server.close(resolve)); });
  const one = new WebSocket(`ws://127.0.0.1:${port}`); const oneMessage = inbox(one); await new Promise((resolve) => one.once('open', resolve)); one.send(JSON.stringify({ type: 'create_room' })); const welcome = await oneMessage(); await oneMessage();
  const two = new WebSocket(`ws://127.0.0.1:${port}`); const twoMessage = inbox(two); await new Promise((resolve) => two.once('open', resolve)); two.send(JSON.stringify({ type: 'join_room', roomId: welcome.roomId })); await twoMessage(); await twoMessage(); await oneMessage();
  const three = new WebSocket(`ws://127.0.0.1:${port}`); const threeMessage = inbox(three); await new Promise((resolve) => three.once('open', resolve)); three.send(JSON.stringify({ type: 'join_room', roomId: welcome.roomId })); assert.match((await threeMessage()).message, /full/);
  one.send('{bad json'); assert.equal((await oneMessage()).type, 'error'); assert.equal(server.listening, true);
});
