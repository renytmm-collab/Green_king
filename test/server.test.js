const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const {
  createAppServer,
  rooms,
  HOST,
  GAME_CONFIG,
  MAP_CONFIG,
  LEVEL_CONFIG,
  COMBAT_CONFIG,
  NETWORK_CONFIG,
  createMap,
  cellFor,
  makeRoom,
  publicState,
  buildingCenter,
  expandTerritory,
  recomputeTerritory,
  build,
  clearObstacle,
  applyMineIncome,
  prepareRoute,
  validateRoute,
  createRoute,
  cancelRoute,
  spawnUnit,
  destroyBuilding,
  simulationStep,
  leaveRoom,
  joinRoom,
  handleMessage
} = require('../server');

function mockSocket(roomId, playerId) {
  return {
    readyState: WebSocket.OPEN,
    roomId,
    playerId,
    messages: [],
    send(data) {
      this.messages.push(JSON.parse(data));
    }
  };
}

function readyRoom(id = 'test-room') {
  const room = makeRoom();
  const player1 = mockSocket(id, 'player1');
  const player2 = mockSocket(id, 'player2');
  room.players.set('player1', { socket: player1 });
  room.players.set('player2', { socket: player2 });
  rooms.set(id, room);
  return { room, player1, player2 };
}

function addTestBuilding(room, building) {
  room.buildings.set(building.id, building);
  const cell = cellFor(room.map, building.row, building.column);
  cell.buildingId = building.id;
  cell.buildable = false;
  return building;
}

function removeObstacle(room, obstacleId) {
  const obstacle = room.obstacles.get(obstacleId);
  if (!obstacle) return;
  room.obstacles.delete(obstacleId);
  const cell = cellFor(room.map, obstacle.row, obstacle.column);
  cell.obstacleId = null;
  cell.blocked = false;
  cell.buildable = cell.territory !== 'neutral' && !cell.buildingId;
}

function removeAllObstacles(room) {
  for (const id of [...room.obstacles.keys()]) removeObstacle(room, id);
}

function directRoutePoints(room, barracksId, targetIds) {
  return [
    buildingCenter(room.buildings.get(barracksId)),
    ...targetIds.map((id) => buildingCenter(room.buildings.get(id)))
  ];
}

function assertOrthogonalGridRoute(points) {
  for (const point of points) {
    const gridColumn = point.x * MAP_CONFIG.columns - 0.5;
    const gridRow = point.y * MAP_CONFIG.rows - 0.5;
    assert.ok(
      Math.abs(gridColumn - Math.round(gridColumn)) < 1e-10,
      'every route point must be centered on a grid column'
    );
    assert.ok(
      Math.abs(gridRow - Math.round(gridRow)) < 1e-10,
      'every route point must be centered on a grid row'
    );
  }
  for (let index = 1; index < points.length; index += 1) {
    assert.ok(
      points[index - 1].x === points[index].x
      || points[index - 1].y === points[index].y,
      'every route segment must be horizontal or vertical'
    );
  }
}

function inbox(socket) {
  const queued = [];
  const waiting = [];
  socket.on('message', (data) => {
    const message = JSON.parse(data);
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queued.push(message);
  });
  return () => queued.length
    ? Promise.resolve(queued.shift())
    : new Promise((resolve) => waiting.push(resolve));
}

async function nextOfType(nextMessage, type) {
  for (;;) {
    const message = await nextMessage();
    if (message.type === type) return message;
  }
}

test.afterEach(() => rooms.clear());

test('authored island starts neutral and keeps its irregular cliff boundary', () => {
  const map = createMap();
  assert.equal(map.rows, MAP_CONFIG.rows);
  assert.equal(map.columns, MAP_CONFIG.columns);
  assert.equal(map.cells.length, MAP_CONFIG.rows * MAP_CONFIG.columns);
  assert.equal(new Set(map.cells.map((cell) => `${cell.row}:${cell.column}`)).size, map.cells.length);
  assert.ok(map.cells.some((cell) => cell.terrain === 'cliff' && cell.blocked));
  assert.ok(map.cells.some((cell) => cell.terrain === 'grass'));
  assert.ok(map.cells.every((cell) => cell.territory === 'neutral' && !cell.buildable));
  assert.equal('nodes' in map, false);
  assert.equal('edges' in map, false);
});

test('castles seed only their surrounding base plates', () => {
  const room = makeRoom();
  for (const playerId of ['player1', 'player2']) {
    const castle = room.buildings.get(`${playerId}_castle`);
    const owned = room.map.cells.filter((cell) => cell.territory === playerId);
    assert.ok(owned.length > 0 && owned.length <= 9);
    assert.ok(owned.every((cell) => (
      Math.abs(cell.row - castle.row) <= LEVEL_CONFIG.initialTerritoryRadius
      && Math.abs(cell.column - castle.column) <= LEVEL_CONFIG.initialTerritoryRadius
    )));
    assert.equal(cellFor(room.map, castle.row, castle.column).buildable, false);
  }
  assert.equal(cellFor(room.map, 4, 8).territory, 'neutral');
});

test('rooms own independent terrain, obstacles, buildings and routes', () => {
  const first = makeRoom();
  const second = makeRoom();
  removeObstacle(first, 'tree_left_front');
  expandTerritory(first, 'player1', 4, 4, 1);
  first.routes.push({ id: 'route' });
  assert.equal(second.obstacles.has('tree_left_front'), true);
  assert.equal(cellFor(second.map, 4, 4).territory, 'neutral');
  assert.equal(second.routes.length, 0);
});

test('public state exposes automatic-income and route rules without collectible coins', () => {
  const room = makeRoom();
  let state = publicState(room);
  assert.equal(state.ready, false);
  assert.equal(state.rules.maxRouteTargets, 3);
  assert.deepEqual(state.rules.buildingCosts, GAME_CONFIG.buildingCosts);
  assert.equal('coins' in state, false);
  room.players.set('player1', { socket: mockSocket('room', 'player1') });
  room.players.set('player2', { socket: mockSocket('room', 'player2') });
  state = publicState(room);
  assert.equal(state.ready, true);
});

test('a completed building expands its 3x3 base plate', () => {
  const { room, player1 } = readyRoom();
  const building = build(player1, 4, 2, 'mine');
  assert.equal(building.type, 'mine');
  assert.equal(cellFor(room.map, 4, 3).territory, 'player1');
  assert.equal(cellFor(room.map, 3, 3).territory, 'player1');
  assert.equal(cellFor(room.map, 4, 4).territory, 'neutral');
  assert.equal(cellFor(room.map, 4, 3).buildable, false, 'authored tree remains blocked');
});

test('base expansion captures enemy empty land but never overwrites an enemy building', () => {
  const { room, player1 } = readyRoom();
  const emptyEnemyCell = cellFor(room.map, 5, 3);
  emptyEnemyCell.territory = 'player2';
  emptyEnemyCell.buildable = true;
  const protectedBuilding = addTestBuilding(room, {
    id: 'enemy_tower', type: 'tower', owner: 'player2',
    row: 3, column: 3, width: 1, height: 1
  });
  cellFor(room.map, protectedBuilding.row, protectedBuilding.column).territory = 'player2';
  build(player1, 4, 2, 'tower');
  assert.equal(emptyEnemyCell.territory, 'player1');
  assert.equal(cellFor(room.map, 3, 3).territory, 'player2');
  assert.equal(cellFor(room.map, 3, 3).buildingId, protectedBuilding.id);
});

test('players advance by building on the newly expanded edge', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_left_front');
  const second = build(player1, 4, 3, 'tower');
  assert.equal(second.type, 'tower');
  assert.equal(cellFor(room.map, 4, 4).territory, 'player1');
  assert.equal(cellFor(room.map, 4, 5).territory, 'neutral');
});

test('build rejects cliffs, neutral ground, enemy buildings and invalid types', () => {
  const { room, player1 } = readyRoom();
  const before = room.playerState.player1.gold;
  const invalid = [
    [0, 0, 'mine'],
    [4, 8, 'mine'],
    [4, 16, 'mine'],
    [4, 1, 'mine'],
    [-1, 2, 'mine'],
    [4.5, 2, 'mine'],
    [4, 2, 'castle'],
    [4, 2, null]
  ];
  for (const request of invalid) build(player1, ...request);
  assert.equal(room.playerState.player1.gold, before);
  assert.equal(player1.messages.filter((message) => message.type === 'action_rejected').length, invalid.length);
});

test('an obstacle becomes clearable only after expansion reaches it', () => {
  const { room, player1 } = readyRoom();
  const before = room.playerState.player1.gold;
  assert.equal(clearObstacle(player1, 'tree_left_front'), undefined);
  assert.equal(room.obstacles.has('tree_left_front'), true);
  build(player1, 4, 2, 'mine');
  const cleared = clearObstacle(player1, 'tree_left_front');
  assert.equal(cleared.type, 'tree');
  assert.equal(room.playerState.player1.gold, before - 100 - GAME_CONFIG.clearCosts.tree);
  const cell = cellFor(room.map, 4, 3);
  assert.equal(cell.blocked, false);
  assert.equal(cell.buildable, true);
});

test('mine income is added automatically on every server tick', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  build(player1, 3, 2, 'mine');
  const afterBuild = room.playerState.player1.gold;
  assert.equal(applyMineIncome(room), 2);
  assert.equal(room.playerState.player1.gold, afterBuild + GAME_CONFIG.mineIncome * 2);
  assert.equal(applyMineIncome(room), 2);
  assert.equal(room.playerState.player1.gold, afterBuild + GAME_CONFIG.mineIncome * 4);
  assert.equal('coins' in room, false);
});

test('empty rooms do not receive mine income', () => {
  const { room, player1 } = readyRoom();
  build(player1, 4, 2, 'mine');
  const before = room.playerState.player1.gold;
  room.players.clear();
  assert.equal(applyMineIncome(room), 0);
  assert.equal(room.playerState.player1.gold, before);
});

test('route authority requires an owned barracks and enemy targets', () => {
  const { room, player1 } = readyRoom();
  const barracks = build(player1, 4, 2, 'barracks');
  assert.match(validateRoute(room, 'player2', barracks.id, ['player1_castle']), /own barracks/);
  assert.match(validateRoute(room, 'player1', 'missing', ['player2_castle']), /start from a barracks/);
  assert.match(validateRoute(room, 'player1', barracks.id, []), /1 to 3/);
  assert.match(validateRoute(room, 'player1', barracks.id, ['missing']), /does not exist/);
  assert.match(validateRoute(room, 'player1', barracks.id, ['player1_castle']), /enemy/);
  assert.match(validateRoute(room, 'player1', barracks.id, ['player2_castle', 'player2_castle']), /same building/);
});

test('server canonicalizes a direct route to building centers', () => {
  const { room, player1 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  const points = directRoutePoints(room, barracks.id, ['player2_castle']);
  const result = prepareRoute(room, 'player1', barracks.id, ['player2_castle'], points);
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.points, [
    buildingCenter(barracks),
    buildingCenter(room.buildings.get('player2_castle'))
  ]);
  const route = createRoute(player1, barracks.id, ['player2_castle'], points);
  assert.deepEqual(route.points, result.points);
  assert.deepEqual(route.targetPointIndices, [1]);
});

test('a segmented route can bend around front-line obstacles', () => {
  const { room, player1 } = readyRoom();
  const barracks = build(player1, 4, 2, 'barracks');
  const start = buildingCenter(barracks);
  const end = buildingCenter(room.buildings.get('player2_castle'));
  const bentPoints = [
    start,
    { x: start.x, y: 0.46 },
    { x: start.x, y: 0.42 },
    { x: start.x, y: 0.38 },
    { x: 0.45, y: 0.38 },
    { x: 0.7, y: 0.38 },
    { x: end.x, y: 0.38 },
    end
  ];
  assert.equal(validateRoute(room, 'player1', barracks.id, ['player2_castle'], bentPoints), null);
  const route = createRoute(player1, barracks.id, ['player2_castle'], bentPoints);
  const snappedY = 3.5 / MAP_CONFIG.rows;
  assert.deepEqual(route.points, [
    start,
    { x: start.x, y: snappedY },
    { x: end.x, y: snappedY },
    end
  ]);
  assert.deepEqual(route.targetPointIndices, [3]);
  assertOrthogonalGridRoute(route.points);
});

test('up to three targets create one straight segment per target', () => {
  const { room, player1 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  const first = addTestBuilding(room, {
    id: 'enemy_mine', type: 'mine', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1
  });
  const second = addTestBuilding(room, {
    id: 'enemy_tower', type: 'tower', owner: 'player2',
    row: 4, column: 12, width: 1, height: 1
  });
  const targets = [first.id, second.id, 'player2_castle'];
  const route = createRoute(player1, barracks.id, targets, directRoutePoints(room, barracks.id, targets));
  assert.deepEqual(route.targetBuildingIds, targets);
  assert.deepEqual(route.points, [barracks, first, second, room.buildings.get('player2_castle')].map(buildingCenter));
  assert.equal(route.points.length, targets.length + 1);
  assertOrthogonalGridRoute(route.points);
});

test('straight routes reject obstacles and non-target buildings', () => {
  const { room, player1 } = readyRoom();
  const barracks = build(player1, 4, 2, 'barracks');
  const direct = directRoutePoints(room, barracks.id, ['player2_castle']);
  assert.match(validateRoute(room, 'player1', barracks.id, ['player2_castle'], direct), /trees or rocks/);
  removeAllObstacles(room);
  addTestBuilding(room, {
    id: 'blocking_mine', type: 'mine', owner: 'player1',
    row: 4, column: 8, width: 1, height: 1
  });
  assert.match(validateRoute(room, 'player1', barracks.id, ['player2_castle'], direct), /non-target building/);
});

test('a valid route replaces the previous route from the same barracks', () => {
  const { room, player1 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  const firstTargets = ['player2_castle'];
  const first = createRoute(player1, barracks.id, firstTargets, directRoutePoints(room, barracks.id, firstTargets));
  const target = addTestBuilding(room, {
    id: 'enemy_target', type: 'tower', owner: 'player2',
    row: 3, column: 15, width: 1, height: 1
  });
  const secondTargets = [target.id];
  const second = createRoute(player1, barracks.id, secondTargets, directRoutePoints(room, barracks.id, secondTargets));
  assert.equal(second.id, first.id);
  assert.equal(room.routes.length, 1);
  assert.deepEqual(second.targetBuildingIds, [target.id]);
  assert.deepEqual(second.points, [
    buildingCenter(barracks),
    { x: buildingCenter(target).x, y: buildingCenter(barracks).y },
    buildingCenter(target)
  ]);
  assertOrthogonalGridRoute(second.points);
});

test('route cancellation is authoritative', () => {
  const { room, player1, player2 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  const targets = ['player2_castle'];
  createRoute(player1, barracks.id, targets, directRoutePoints(room, barracks.id, targets));
  assert.equal(cancelRoute(player2, barracks.id), false);
  assert.equal(room.routes.length, 1);
  assert.equal(cancelRoute(player1, barracks.id), true);
  assert.equal(room.routes.length, 0);
});

test('mutating actions are rejected while a room is waiting', () => {
  const roomId = 'waiting';
  const room = makeRoom();
  const player1 = mockSocket(roomId, 'player1');
  room.players.set('player1', { socket: player1 });
  rooms.set(roomId, room);
  build(player1, 4, 2, 'mine');
  clearObstacle(player1, 'tree_left_front');
  assert.equal(room.buildings.size, 2);
  assert.equal(room.obstacles.has('tree_left_front'), true);
});

test('leaving a room frees the same player role', () => {
  const { room, player1, player2 } = readyRoom('replace-room');
  leaveRoom(player1);
  const replacement = mockSocket(undefined, undefined);
  joinRoom(replacement, 'replace-room');
  assert.equal(replacement.playerId, 'player1');
  assert.equal(room.players.get('player2').socket, player2);
});

test('message handler validates client route samples and rejects malformed input', () => {
  const { room, player1 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  handleMessage(player1, Buffer.from(JSON.stringify({
    type: 'create_route',
    barracksId: barracks.id,
    targetBuildingIds: ['player2_castle'],
    points: [{ x: 999, y: 999 }]
  })));
  assert.equal(room.routes.length, 0);
  assert.equal(player1.messages.at(-1).type, 'action_rejected');
  const validPoints = directRoutePoints(room, barracks.id, ['player2_castle']);
  handleMessage(player1, Buffer.from(JSON.stringify({
    type: 'create_route',
    barracksId: barracks.id,
    targetBuildingIds: ['player2_castle'],
    points: validPoints
  })));
  assert.deepEqual(room.routes[0].points, validPoints);
  const socket = mockSocket(undefined, undefined);
  handleMessage(socket, Buffer.alloc(NETWORK_CONFIG.maxMessageBytes + 1));
  handleMessage(socket, Buffer.from('{bad json'));
  handleMessage(socket, Buffer.from('[]'));
  handleMessage(socket, Buffer.from('{}'));
  handleMessage(socket, Buffer.from(JSON.stringify({ type: 'unknown' })));
  assert.equal(socket.messages.length, 5);
  assert.ok(socket.messages.every((message) => message.type === 'error'));
});

test('two WebSocket players receive the expanding-map state', async (t) => {
  const { server, wss } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const first = new WebSocket(`ws://127.0.0.1:${port}`);
  const firstMessage = inbox(first);
  await new Promise((resolve) => first.once('open', resolve));
  first.send(JSON.stringify({ type: 'create_room' }));
  const welcome = await nextOfType(firstMessage, 'welcome');
  assert.equal((await nextOfType(firstMessage, 'game_state')).ready, false);
  const second = new WebSocket(`ws://127.0.0.1:${port}`);
  const secondMessage = inbox(second);
  await new Promise((resolve) => second.once('open', resolve));
  second.send(JSON.stringify({ type: 'join_room', roomId: welcome.roomId }));
  assert.equal((await nextOfType(secondMessage, 'welcome')).playerId, 'player2');
  const state = await nextOfType(secondMessage, 'game_state');
  assert.equal(state.ready, true);
  assert.equal(state.map.cells.length, MAP_CONFIG.rows * MAP_CONFIG.columns);
  assert.equal('coins' in state, false);
  first.send(JSON.stringify({ type: 'pointer_click', x: 0.25, y: 0.75 }));
  assert.equal((await nextOfType(secondMessage, 'opponent_pointer')).playerId, 'player1');
});

test('third player and invalid JSON are rejected without stopping the server', async (t) => {
  const { server, wss } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const one = new WebSocket(`ws://127.0.0.1:${port}`);
  const oneMessage = inbox(one);
  await new Promise((resolve) => one.once('open', resolve));
  one.send(JSON.stringify({ type: 'create_room' }));
  const welcome = await nextOfType(oneMessage, 'welcome');
  await nextOfType(oneMessage, 'game_state');
  const two = new WebSocket(`ws://127.0.0.1:${port}`);
  const twoMessage = inbox(two);
  await new Promise((resolve) => two.once('open', resolve));
  two.send(JSON.stringify({ type: 'join_room', roomId: welcome.roomId }));
  await nextOfType(twoMessage, 'welcome');
  const three = new WebSocket(`ws://127.0.0.1:${port}`);
  const threeMessage = inbox(three);
  await new Promise((resolve) => three.once('open', resolve));
  three.send(JSON.stringify({ type: 'join_room', roomId: welcome.roomId }));
  assert.match((await nextOfType(threeMessage, 'error')).message, /full/);
  one.send('{bad json');
  assert.equal((await nextOfType(oneMessage, 'error')).type, 'error');
  assert.equal(server.listening, true);
});

test('client uses LAN addressing and submits sampled polyline routes', () => {
  assert.equal(HOST, '0.0.0.0');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'renderer.js'), 'utf8');
  assert.match(appSource, /location\.host/);
  assert.doesNotMatch(appSource, /collect_coin|coinAtPoint/);
  assert.doesNotMatch(rendererSource, /drawCoin|drawGrid/);
  assert.match(rendererSource, /drawTerrain/);
  assert.match(appSource, /targetBuildingIds: current\.targetBuildingIds/);
  assert.match(appSource, /points: current\.points/);
  assert.match(appSource, /orthogonalizePreview/);
});

test('original visual assets are present and loaded with geometric fallbacks', () => {
  const assetRoot = path.join(__dirname, '..', 'public', 'assets', 'original');
  const expectedAssets = {
    'buildings/castle_player1.png': [63, 60],
    'buildings/castle_player2.png': [63, 60],
    'buildings/mine_player1.png': [59, 58],
    'buildings/mine_player2.png': [59, 58],
    'buildings/tower_player1.png': [43, 61],
    'buildings/tower_player2.png': [43, 61],
    'buildings/barracks_player1.png': [50, 64],
    'buildings/barracks_player2.png': [50, 64],
    'obstacles/tree.png': [80, 82],
    'obstacles/rock.png': [80, 82],
    'units/soldier_player1_left.png': [246, 222],
    'units/soldier_player1_right.png': [246, 222],
    'units/soldier_player2_left.png': [246, 222],
    'units/soldier_player2_right.png': [246, 222]
  };
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const crc32 = (buffer) => {
    let crc = 0xffffffff;
    for (const byte of buffer) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const readPngSize = (data, relativeAsset) => {
    assert.equal(data.subarray(0, pngSignature.length).equals(pngSignature), true, relativeAsset);
    let offset = pngSignature.length;
    let width;
    let height;
    let foundEnd = false;
    while (offset < data.length) {
      assert.ok(offset + 12 <= data.length, `${relativeAsset} has a complete chunk header`);
      const length = data.readUInt32BE(offset);
      const chunkEnd = offset + 12 + length;
      assert.ok(chunkEnd <= data.length, `${relativeAsset} has a complete chunk body`);
      const type = data.toString('ascii', offset + 4, offset + 8);
      const storedCrc = data.readUInt32BE(offset + 8 + length);
      const computedCrc = crc32(data.subarray(offset + 4, offset + 8 + length));
      assert.equal(computedCrc, storedCrc, `${relativeAsset} ${type} CRC`);
      if (type === 'IHDR') {
        assert.equal(length, 13, `${relativeAsset} IHDR length`);
        width = data.readUInt32BE(offset + 8);
        height = data.readUInt32BE(offset + 12);
      }
      offset = chunkEnd;
      if (type === 'IEND') {
        foundEnd = true;
        break;
      }
    }
    assert.equal(foundEnd, true, `${relativeAsset} has IEND`);
    assert.equal(offset, data.length, `${relativeAsset} has no trailing data`);
    return [width, height];
  };
  for (const [relativeAsset, expectedSize] of Object.entries(expectedAssets)) {
    const data = fs.readFileSync(path.join(assetRoot, relativeAsset));
    assert.deepEqual(readPngSize(data, relativeAsset), expectedSize, `${relativeAsset} dimensions`);
  }
  const visualSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'visual-config.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'renderer.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const sandbox = {};
  require('node:vm').runInNewContext(
    `${visualSource.replaceAll('export const', 'const')}\nthis.manifest = ASSET_MANIFEST;`,
    sandbox
  );
  const manifest = sandbox.manifest;
  const manifestPaths = [
    ...Object.values(manifest.buildings).flatMap((owners) => Object.values(owners)),
    ...Object.values(manifest.obstacles),
    ...Object.values(manifest.units).flatMap((directions) => Object.values(directions))
  ].map((asset) => asset.src).sort();
  const expectedPaths = Object.keys(expectedAssets)
    .map((relativeAsset) => `/assets/original/${relativeAsset}`)
    .sort();
  assert.deepEqual(manifestPaths, expectedPaths);
  for (const directions of Object.values(manifest.units)) {
    for (const asset of Object.values(directions)) {
      assert.deepEqual(
        [asset.frameWidth, asset.frameHeight, asset.frameCount, asset.columns],
        [41, 37, 36, 6]
      );
    }
  }
  assert.match(visualSource, /ASSET_MANIFEST/);
  assert.match(rendererSource, /preloadVisualAssets/);
  assert.match(rendererSource, /if \(!drewSprite\)/);
  assert.match(rendererSource, /ASSET_MANIFEST\.obstacles/);
  assert.match(rendererSource, /sceneItems\.sort/);
  assert.match(rendererSource, /unit\.facing/);
  assert.match(appSource, /requestAnimationFrame/);
  assert.match(appSource, /applyUnitFacing/);
});

test('buildings expose authoritative health values', () => {
  const { room, player1 } = readyRoom();
  const mine = build(player1, 4, 2, 'mine');
  assert.equal(mine.maxHp, GAME_CONFIG.buildingStats.mine.maxHp);
  assert.equal(mine.hp, mine.maxHp);
  const stateMine = publicState(room).buildings.find((building) => building.id === mine.id);
  assert.equal(stateMine.hp, mine.hp);
  assert.equal('claimOrder' in stateMine, false);
  assert.equal('attackCooldownMs' in stateMine, false);
});

test('barracks spawn units that advance toward the first route target', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const barracks = build(player1, 4, 2, 'barracks');
  const targets = ['player2_castle'];
  const start = buildingCenter(barracks);
  const end = buildingCenter(room.buildings.get('player2_castle'));
  const bentPoints = [start, { x: start.x, y: 0.38 }, { x: end.x, y: 0.38 }, end];
  const route = createRoute(player1, barracks.id, targets, bentPoints);
  assert.equal(spawnUnit(room, route).owner, 'player1');
  const firstUnit = [...room.units.values()][0];
  simulationStep(room, 500);
  assert.equal(firstUnit.x, start.x);
  assert.ok(firstUnit.y < start.y);
  simulationStep(room, 1000);
  assert.ok(firstUnit.x > start.x);
  assert.equal(firstUnit.y, 3.5 / MAP_CONFIG.rows);
  assert.equal(publicState(room).units.length, 1);
});

test('unit facing follows a horizontal route fold in both directions', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const barracks = build(player1, 4, 2, 'barracks');
  const start = buildingCenter(barracks);
  const route = {
    id: 'fold-test-route',
    owner: 'player1',
    barracksId: barracks.id,
    targetBuildingIds: ['player2_castle'],
    targetPointIndices: [2],
    points: [
      start,
      { x: start.x + 0.06, y: start.y },
      { x: start.x - 0.06, y: start.y }
    ]
  };
  const unit = spawnUnit(room, route);
  room.routes = [];

  simulationStep(room, 500);
  assert.equal(publicState(room).units[0].facing, 'right');
  simulationStep(room, 500);
  assert.equal(publicState(room).units[0].facing, 'left');
});

test('opposing soldiers exchange damage simultaneously at close range', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  const makeUnit = (id, owner) => ({
    id,
    owner,
    barracksId: 'test',
    routeId: 'test',
    targetBuildingIds: [`${owner === 'player1' ? 'player2' : 'player1'}_castle`],
    currentTargetIndex: 0,
    x: 0.5,
    y: 0.5,
    hp: COMBAT_CONFIG.unitMaxHp,
    maxHp: COMBAT_CONFIG.unitMaxHp,
    attackCooldownMs: 0
  });
  room.units.set('one', makeUnit('one', 'player1'));
  room.units.set('two', makeUnit('two', 'player2'));
  simulationStep(room, COMBAT_CONFIG.tickMs);
  assert.equal(room.units.get('one').hp, COMBAT_CONFIG.unitMaxHp - COMBAT_CONFIG.unitDamage);
  assert.equal(room.units.get('two').hp, COMBAT_CONFIG.unitMaxHp - COMBAT_CONFIG.unitDamage);
});

test('towers automatically damage enemy units inside their range', () => {
  const { room, player2 } = readyRoom();
  room.phase = 'playing';
  const tower = build(player2, 4, 15, 'tower');
  const center = buildingCenter(tower);
  room.units.set('intruder', {
    id: 'intruder',
    owner: 'player1',
    barracksId: 'test',
    routeId: 'test',
    targetBuildingIds: ['player2_castle'],
    currentTargetIndex: 0,
    x: center.x - 0.05,
    y: center.y,
    hp: COMBAT_CONFIG.unitMaxHp,
    maxHp: COMBAT_CONFIG.unitMaxHp,
    attackCooldownMs: COMBAT_CONFIG.unitAttackIntervalMs
  });
  simulationStep(room, COMBAT_CONFIG.tickMs);
  assert.equal(room.units.get('intruder').hp, COMBAT_CONFIG.unitMaxHp - COMBAT_CONFIG.towerDamage);
});

test('destroyed expansion sources retract unsupported territory and cancel affected routes', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  const first = build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_left_front');
  const frontier = build(player1, 4, 3, 'barracks');
  assert.equal(cellFor(room.map, 4, 4).territory, 'player1');
  removeAllObstacles(room);
  const enemyTarget = addTestBuilding(room, {
    id: 'route_target', type: 'tower', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1,
    hp: 100, maxHp: 100, claimOrder: room.nextClaimOrder++, attackCooldownMs: 0
  });
  recomputeTerritory(room);
  const targets = [enemyTarget.id];
  createRoute(player1, frontier.id, targets, directRoutePoints(room, frontier.id, targets));
  assert.equal(room.routes.length, 1);
  destroyBuilding(room, enemyTarget.id, 'player1');
  assert.equal(room.routes.length, 0);
  destroyBuilding(room, frontier.id, 'player2');
  assert.equal(cellFor(room.map, 4, 4).territory, 'neutral');
  assert.equal(room.buildings.has(first.id), true);
});

test('destroying a castle finishes the battle and records the winner', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  const castle = room.buildings.get('player2_castle');
  castle.hp = 1;
  const center = buildingCenter(castle);
  room.units.set('finisher', {
    id: 'finisher',
    owner: 'player1',
    barracksId: 'test',
    routeId: 'test',
    targetBuildingIds: [castle.id],
    currentTargetIndex: 0,
    x: center.x,
    y: center.y,
    hp: COMBAT_CONFIG.unitMaxHp,
    maxHp: COMBAT_CONFIG.unitMaxHp,
    attackCooldownMs: 0
  });
  simulationStep(room, COMBAT_CONFIG.tickMs);
  assert.equal(room.buildings.has(castle.id), false);
  assert.equal(room.winner, 'player1');
  assert.equal(room.phase, 'finished');
  assert.equal(publicState(room).winner, 'player1');
  assert.equal(simulationStep(room, COMBAT_CONFIG.tickMs), false);
});

test('simultaneous castle destruction produces a draw', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  for (const owner of ['player1', 'player2']) {
    const enemy = owner === 'player1' ? 'player2' : 'player1';
    const castle = room.buildings.get(`${enemy}_castle`);
    castle.hp = 1;
    const center = buildingCenter(castle);
    room.units.set(`${owner}_finisher`, {
      id: `${owner}_finisher`, owner, barracksId: 'test', routeId: 'test',
      targetBuildingIds: [castle.id], currentTargetIndex: 0,
      x: center.x, y: center.y,
      hp: COMBAT_CONFIG.unitMaxHp, maxHp: COMBAT_CONFIG.unitMaxHp, attackCooldownMs: 0
    });
  }
  simulationStep(room, COMBAT_CONFIG.tickMs);
  assert.equal(room.winner, 'draw');
  assert.equal(room.phase, 'finished');
});
