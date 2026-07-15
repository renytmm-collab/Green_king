const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createAppServer, rooms, MAP_NODES, MAP_EDGES } = require('../server');

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
  assert.equal(MAP_NODES.filter((node) => node.type === 'castle').length, 2); assert.equal(MAP_NODES.filter((node) => node.type === 'barracks').length, 2);
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
  assert.deepEqual((await routeForFirst).route, { owner: 'player1', fromNodeId: 'p1_barracks', toNodeId: 'neutral_top' });
  assert.deepEqual((await routeForSecond).route, { owner: 'player1', fromNodeId: 'p1_barracks', toNodeId: 'neutral_top' });
});
