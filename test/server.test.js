const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createAppServer, rooms, MAP_NODES, MAP_EDGES, GAME_CONFIG, makeRoom, applyMineIncome, build, createRoute } = require('../server');

function nextMessage(socket) {
  return new Promise((resolve) => socket.once('message', (data) => resolve(JSON.parse(data))));
}

test('two players receive roles and pointer event is forwarded', async (t) => {
  rooms.clear();
  const { server, wss } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
    rooms.clear();
  });
  const first = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => first.once('open', resolve));
  first.send(JSON.stringify({ type: 'create_room' }));
  const welcome1 = await nextMessage(first);
  assert.equal(welcome1.type, 'welcome');
  assert.equal(welcome1.playerId, 'player1');
  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolve) => second.once('open', resolve));
  const joined = nextMessage(first);
  second.send(JSON.stringify({ type: 'join_room', roomId: welcome1.roomId }));
  const welcome2 = await nextMessage(second);
  assert.equal(welcome2.playerId, 'player2');
  assert.equal((await joined).type, 'opponent_joined');
  const pointer = nextMessage(second);
  first.send(JSON.stringify({ type: 'pointer_click', x: 0.25, y: 0.75 }));
  assert.deepEqual(await pointer, { type: 'opponent_pointer', playerId: 'player1', x: 0.25, y: 0.75 });
});

test('server validates and synchronizes one route per barracks', async (t) => {
  rooms.clear();
  const { server, wss } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => { for (const client of wss.clients) client.terminate(); await new Promise((resolve) => server.close(resolve)); rooms.clear(); });
  const first = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((resolve) => first.once('open', resolve));
  assert.equal(MAP_NODES.filter((node) => node.buildingType === 'castle').length, 2); assert.equal(MAP_NODES.filter((node) => node.buildingType === 'barracks').length, 2);
  assert.equal(new Set(MAP_NODES.map((node) => node.id)).size, MAP_NODES.length);
  assert.ok(MAP_NODES.every((node) => node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1));
  assert.ok(MAP_EDGES.every(([from, to]) => MAP_NODES.some((node) => node.id === from) && MAP_NODES.some((node) => node.id === to)));
  first.send(JSON.stringify({ type: 'create_room' })); const welcome1 = await nextMessage(first);
  const second = new WebSocket(`ws://127.0.0.1:${port}`); await new Promise((resolve) => second.once('open', resolve));
  const joined = nextMessage(first); second.send(JSON.stringify({ type: 'join_room', roomId: welcome1.roomId })); await nextMessage(second); await joined;
  const rejected = nextMessage(second); second.send(JSON.stringify({ type: 'create_route', fromNodeId: 'p1_barracks', toNodeId: 'neutral_top' }));
  assert.equal((await rejected).type, 'action_rejected');
  const routeForFirst = nextMessage(first); const routeForSecond = nextMessage(second);
  first.send(JSON.stringify({ type: 'create_route', fromNodeId: 'p1_barracks', toNodeId: 'neutral_top' }));
  assert.deepEqual((await routeForFirst).routes[0], { owner: 'player1', fromNodeId: 'p1_barracks', toNodeId: 'neutral_top' });
  assert.deepEqual((await routeForSecond).routes[0], { owner: 'player1', fromNodeId: 'p1_barracks', toNodeId: 'neutral_top' });
});

function mockSocket(roomId, playerId) {
  return { readyState: WebSocket.OPEN, roomId, playerId, messages: [], send(data) { this.messages.push(JSON.parse(data)); } };
}

test('builds only on owned empty slots and deducts server gold', () => {
  rooms.clear();
  const room = makeRoom(); const socket = mockSocket('build-room', 'player1');
  room.players.set('player1', { socket }); room.players.set('player2', { socket: mockSocket('build-room', 'player2') }); rooms.set('build-room', room);
  assert.equal(room.playerState.player1.gold, GAME_CONFIG.startingGold);
  assert.equal(room.nodes.filter((node) => node.nodeType === 'build_slot').length, 6);
  build(socket, 'p1_slot_top', 'mine');
  assert.equal(room.playerState.player1.gold, GAME_CONFIG.startingGold - GAME_CONFIG.buildingCosts.mine);
  assert.equal(room.nodes.find((node) => node.id === 'p1_slot_top').buildingType, 'mine');
  build(socket, 'p1_slot_top', 'tower');
  assert.equal(room.playerState.player1.gold, GAME_CONFIG.startingGold - GAME_CONFIG.buildingCosts.mine);
  assert.equal(socket.messages.at(-1).type, 'action_rejected');
  build(socket, 'p2_slot_top', 'tower');
  assert.equal(socket.messages.at(-1).reason, 'You can only build on your own slot.');
  rooms.clear();
});

test('mine income is isolated and newly built barracks can create routes', () => {
  rooms.clear();
  const room = makeRoom(); const p1 = mockSocket('income-room', 'player1'); const p2 = mockSocket('income-room', 'player2');
  room.players.set('player1', { socket: p1 }); room.players.set('player2', { socket: p2 }); rooms.set('income-room', room);
  build(p1, 'p1_slot_middle', 'barracks'); build(p1, 'p1_slot_top', 'mine');
  const beforeP1 = room.playerState.player1.gold; const beforeP2 = room.playerState.player2.gold;
  assert.equal(applyMineIncome(room), true);
  assert.equal(room.playerState.player1.gold, beforeP1 + GAME_CONFIG.mineIncome);
  assert.equal(room.playerState.player2.gold, beforeP2);
  createRoute(p1, 'p1_slot_middle', 'neutral_top');
  assert.deepEqual(room.routes[0], { owner: 'player1', fromNodeId: 'p1_slot_middle', toNodeId: 'neutral_top' });
  createRoute(p1, 'p1_slot_top', 'neutral_top');
  assert.equal(p1.messages.at(-1).type, 'action_rejected');
  const other = makeRoom(); other.nodes.find((node) => node.id === 'p1_slot_top').buildingType = 'mine';
  assert.equal(other.nodes.find((node) => node.id === 'p1_slot_top').buildingType, 'mine');
  assert.equal(room.nodes.find((node) => node.id === 'p1_slot_top').buildingType, 'mine');
  rooms.clear();
});
