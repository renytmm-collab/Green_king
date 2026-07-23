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
  MAPS,
  DEFAULT_MAP_ID,
  LEVEL_CONFIG,
  COMBAT_CONFIG,
  ROUTE_CONFIG,
  NETWORK_CONFIG,
  createMap,
  cellFor,
  makeRoom,
  publicState,
  buildingCenter,
  expandTerritory,
  recomputeTerritory,
  build,
  reserveCell,
  cancelReservation,
  clearObstacle,
  applyMineIncome,
  prepareRoute,
  validateRoute,
  createRoute,
  cancelRoute,
  spawnUnit,
  destroyBuilding,
  demolishBuilding,
  simulationStep,
  leaveRoom,
  returnToLobby, returnToBoard,
  createRoom,
  joinRoom,
  rejoinRoom,
  resetRoom,
  requestRematch,
  handleMessage,
  upgrade,
  upgradeCost,
  effectiveMineIncome,
  effectiveTowerDamage,
  effectiveTowerRange,
  effectiveSpawnInterval,
  effectiveUnitMaxHp,
  effectiveUnitSpeedMul,
  effectiveUnitExplosionDamage,
  UPGRADE_CONFIG,
  zeroUpgrades,
  broadcastState,
  spawnCoin,
  collectCoin,
  PICKUP_CONFIG
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
  const normalized = {
    attackCooldownMs: 0,
    spawnElapsedMs: 0,
    // Test fixtures are already finished constructing unless explicitly set.
    constructedAt: building.constructedAt ?? -1e12,
    constructionDurationMs: building.constructionDurationMs ?? GAME_CONFIG.constructionDurationMs,
    hp: GAME_CONFIG.buildingStats[building.type]?.maxHp,
    maxHp: GAME_CONFIG.buildingStats[building.type]?.maxHp,
    ...building
  };
  room.buildings.set(normalized.id, normalized);
  const cell = cellFor(room.map, normalized.row, normalized.column);
  cell.buildingId = normalized.id;
  cell.buildable = false;
  return normalized;
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

test('MAPS registry exposes five 180-degree-symmetric maps', () => {
  assert.deepEqual(Object.keys(MAPS).sort(), ['archipelago', 'bridge', 'canyon', 'forest', 'gambit', 'plain']);
  for (const [id, map] of Object.entries(MAPS)) {
    assert.equal(map.id, id);
    assert.equal(map.terrainRows.length, MAP_CONFIG.rows);
    assert.ok(map.terrainRows.every((row) => row.length === MAP_CONFIG.columns));
    // 180-degree rotation symmetry: cell (r,c) mirrors (rows-1-r, cols-1-c).
    const mirrored = map.terrainRows.map((row) => row.split('').reverse().join(''));
    assert.ok(
      map.terrainRows.every((row, r) => row === mirrored[map.terrainRows.length - 1 - r]),
      `${id} must be point-symmetric for fair 1v1`
    );
    assert.deepEqual(map.castles.player1, { row: 4, column: 1 });
    assert.deepEqual(map.castles.player2, { row: 4, column: 16 });
  }
  assert.equal(DEFAULT_MAP_ID, 'plain');
});

test('makeRoom builds the requested map terrain', () => {
  const plain = makeRoom('plain');
  assert.equal(plain.mapId, 'plain');
  assert.equal(cellFor(plain.map, 4, 8).terrain, 'grass', 'plain keeps an open center');
  const canyon = makeRoom('canyon');
  assert.equal(canyon.mapId, 'canyon');
  assert.equal(cellFor(canyon.map, 4, 8).terrain, 'cliff', 'canyon walls the center column');
  const archipelago = makeRoom('archipelago');
  assert.equal(archipelago.mapId, 'archipelago');
  assert.equal(cellFor(archipelago.map, 4, 8).terrain, 'cliff', 'archipelago splits the middle');
  // A missing/invalid map id falls back to the default map.
  const fallback = makeRoom('does-not-exist');
  assert.equal(fallback.mapId, 'plain');
});

test('bridge map funnels both castles through one central crossing', () => {
  const room = makeRoom('bridge');
  assert.equal(room.mapId, 'bridge');
  // The bridge deck is open grass at the dead-center columns.
  assert.equal(cellFor(room.map, 4, 8).terrain, 'grass');
  assert.equal(cellFor(room.map, 4, 9).terrain, 'grass');
  // The cliff wall seals every other crossing on those center columns.
  for (const r of [1, 2, 6, 7]) {
    assert.equal(cellFor(room.map, r, 8).terrain, 'cliff');
    assert.equal(cellFor(room.map, r, 9).terrain, 'cliff');
  }
  const rows = room.map.rows, cols = room.map.columns;
  const passable = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols
    && cellFor(room.map, r, c).terrain === 'grass';
  const reachesEnemy = (blockBridge) => {
    const seen = new Set(['4,1']);
    const stack = [[4, 1]];
    while (stack.length) {
      const [r, c] = stack.pop();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (!passable(nr, nc)) continue;
        if (blockBridge && nr >= 3 && nr <= 5 && nc >= 8 && nc <= 9) continue;
        const key = `${nr},${nc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stack.push([nr, nc]);
      }
    }
    return seen.has('4,16');
  };
  assert.equal(reachesEnemy(false), true, 'both castles connect through the bridge');
  assert.equal(reachesEnemy(true), false, 'sealing the bridge splits the map in two');
});

test('gambit map has two offset gates and a sole central link', () => {
  const room = makeRoom('gambit');
  assert.equal(room.mapId, 'gambit');
  const rows = room.map.rows, cols = room.map.columns;
  const passable = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols
    && cellFor(room.map, r, c).terrain === 'grass';
  // Two cliffs (col 6 and col 11) each leave an offset gate, so a single
  // tower line cannot cover both approaches at once — that is the gamble.
  const openCols = (c, list) => list.filter((r) => passable(r, c)).sort((a, b) => a - b);
  assert.deepEqual(openCols(6, [0, 1, 2, 3, 4, 5, 6, 7, 8]), [4, 5, 6], 'left wall gate sits low');
  assert.deepEqual(openCols(11, [0, 1, 2, 3, 4, 5, 6, 7, 8]), [2, 3, 4], 'right wall gate sits high (offset)');
  // The central plaza (cols 7-10) is the ONLY link between the halves.
  const reachesEnemy = (blockPlaza) => {
    const seen = new Set(['4,1']);
    const stack = [[4, 1]];
    while (stack.length) {
      const [r, c] = stack.pop();
      for (const [dr, dc] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nr = r + dr, nc = c + dc;
        if (!passable(nr, nc)) continue;
        if (blockPlaza && nr >= 2 && nr <= 6 && nc >= 7 && nc <= 10) continue;
        const key = `${nr},${nc}`;
        if (seen.has(key)) continue;
        seen.add(key);
        stack.push([nr, nc]);
      }
    }
    return seen.has('4,16');
  };
  assert.equal(reachesEnemy(false), true, 'both castles connect through the plaza');
  assert.equal(reachesEnemy(true), false, 'sealing the plaza splits the map in two');
});

test('createRoom honours the requested map id and advertises the catalog', () => {
  const socket = mockSocket(undefined, undefined);
  createRoom(socket, 'canyon');
  const welcome = socket.messages.find((message) => message.type === 'welcome');
  assert.equal(welcome.mapId, 'canyon');
  assert.equal(welcome.mapName, MAPS.canyon.name);
  assert.ok(Array.isArray(welcome.maps) && welcome.maps.length === 6);
  // Default when no map is requested.
  const other = mockSocket(undefined, undefined);
  createRoom(other);
  assert.equal(other.messages.find((m) => m.type === 'welcome').mapId, 'plain');
});

test('resetRoom keeps the room on its original map', () => {
  const socket = mockSocket(undefined, undefined);
  createRoom(socket, 'archipelago');
  const roomId = socket.roomId;
  const room = rooms.get(roomId);
  resetRoom(room);
  assert.equal(room.mapId, 'archipelago');
  assert.equal(cellFor(room.map, 4, 8).terrain, 'cliff');
});

test('public state reports the active map id and name', () => {
  const socket = mockSocket(undefined, undefined);
  createRoom(socket, 'forest');
  const room = rooms.get(socket.roomId);
  const state = publicState(room);
  assert.equal(state.mapId, 'forest');
  assert.equal(state.mapName, MAPS.forest.name);
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
  removeObstacle(first, 'tree_lf');
  expandTerritory(first, 'player1', 4, 4, 1);
  first.routes.push({ id: 'route' });
  assert.equal(second.obstacles.has('tree_lf'), true);
  assert.equal(cellFor(second.map, 4, 4).territory, 'neutral');
  assert.equal(second.routes.length, 0);
});

test('public state exposes automatic-income, route rules and the collectible coin array', () => {
  const room = makeRoom();
  let state = publicState(room);
  assert.equal(state.ready, false);
  assert.equal(state.rules.maxRouteTargets, 3);
  assert.deepEqual(state.rules.buildingCosts, GAME_CONFIG.buildingCosts);
  assert.ok(Array.isArray(state.coins), 'coins are exposed as an array');
  assert.equal(state.coins.length, 0, 'no coins on a fresh room');
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
  removeObstacle(room, 'tree_lf');
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
  assert.equal(clearObstacle(player1, 'tree_lf'), undefined);
  assert.equal(room.obstacles.has('tree_lf'), true);
  build(player1, 4, 2, 'mine');
  const cleared = clearObstacle(player1, 'tree_lf');
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
  assert.ok(room.coins instanceof Map, 'collectible coins are tracked separately from automatic mine income');
});

test('empty rooms do not receive mine income', () => {
  const { room, player1 } = readyRoom();
  build(player1, 4, 2, 'mine');
  const before = room.playerState.player1.gold;
  room.players.clear();
  assert.equal(applyMineIncome(room), 0);
  assert.equal(room.playerState.player1.gold, before);
});

test('a player with no mine still gains gold at one mine rate', () => {
  const { room, player1 } = readyRoom();
  // player1 owns two mines; player2 owns none.
  build(player1, 4, 2, 'mine');
  build(player1, 3, 2, 'mine');
  const p1Before = room.playerState.player1.gold;
  const p2Before = room.playerState.player2.gold;
  const paid = applyMineIncome(room, false);
  assert.equal(paid, 2, 'both players earn (baseline for the no-mine side, 2x for the owner)');
  assert.equal(room.playerState.player1.gold, p1Before + GAME_CONFIG.mineIncome * 2, 'mine owner keeps two-mine income');
  assert.equal(room.playerState.player2.gold, p2Before + GAME_CONFIG.mineIncome, 'no-mine player earns exactly one mine rate');
});

test('a room with zero mines still grants both players a baseline income', () => {
  const { room } = readyRoom();
  const p1Before = room.playerState.player1.gold;
  const p2Before = room.playerState.player2.gold;
  const paid = applyMineIncome(room, false);
  assert.equal(paid, 2, 'both players receive the baseline');
  assert.equal(room.playerState.player1.gold, p1Before + GAME_CONFIG.mineIncome);
  assert.equal(room.playerState.player2.gold, p2Before + GAME_CONFIG.mineIncome);
});

test('baseline income is a fixed one-mine speed, never scaled by mine upgrades', () => {
  const { room, player2 } = readyRoom();
  // player2 owns no mine but buys several mine upgrades — the baseline must stay
  // at the raw one-mine rate, decoupled from the upgrade logic.
  room.playerState.player2.upgrades.mine = 3;
  const p2Before = room.playerState.player2.gold;
  const paid = applyMineIncome(room, false);
  assert.equal(paid, 2, 'both players still earn (baseline for the upgraded, mine-less player)');
  assert.equal(room.playerState.player2.gold, p2Before + GAME_CONFIG.mineIncome);
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

test('straight routes reject obstacles and the player\'s own buildings', () => {
  const { room, player1 } = readyRoom();
  const barracks = build(player1, 4, 2, 'barracks');
  const direct = directRoutePoints(room, barracks.id, ['player2_castle']);
  assert.match(validateRoute(room, 'player1', barracks.id, ['player2_castle'], direct), /trees or rocks/);
  removeAllObstacles(room);
  addTestBuilding(room, {
    id: 'blocking_mine', type: 'mine', owner: 'player1',
    row: 4, column: 8, width: 1, height: 1
  });
  assert.match(validateRoute(room, 'player1', barracks.id, ['player2_castle'], direct), /your own building/);
});

test('a route may cross enemy buildings that are not declared targets', () => {
  const { room, player1 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  // An enemy structure sits directly on the straight path to the castle but is
  // NOT declared as a target. The route must still be accepted — soldiers will
  // self-destruct on it at runtime and later soldiers push on to the castle.
  addTestBuilding(room, {
    id: 'enemy_blocker', type: 'tower', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1
  });
  const direct = directRoutePoints(room, barracks.id, ['player2_castle']);
  assert.equal(validateRoute(room, 'player1', barracks.id, ['player2_castle'], direct), null);
  const route = createRoute(player1, barracks.id, ['player2_castle'], direct);
  assert.ok(route);
  assert.deepEqual(route.targetBuildingIds, ['player2_castle']);
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
  clearObstacle(player1, 'tree_lf');
  assert.equal(room.buildings.size, 2);
  assert.equal(room.obstacles.has('tree_lf'), true);
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
  assert.ok(Array.isArray(state.coins), 'coins array present in broadcast state');
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

test('GET /maps exposes full terrain preview data for each map', async (t) => {
  const { server, wss } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const response = await fetch(`http://127.0.0.1:${port}/maps`);
  assert.equal(response.status, 200);
  const catalog = await response.json();
  assert.equal(catalog.defaultMapId, DEFAULT_MAP_ID);
  assert.equal(catalog.maps.length, Object.keys(MAPS).length);
  for (const map of catalog.maps) {
    assert.ok(Array.isArray(map.terrainRows), `${map.id} has terrainRows`);
    assert.equal(map.terrainRows.length, MAP_CONFIG.rows);
    assert.ok(
      map.terrainRows.every((row) => row.length === MAP_CONFIG.columns),
      `${map.id} terrain width is ${MAP_CONFIG.columns}`
    );
    assert.ok(Array.isArray(map.obstacles), `${map.id} has obstacles`);
    assert.ok(
      map.castles && map.castles.player1 && map.castles.player2,
      `${map.id} has both castles`
    );
  }
});

test('client uses LAN addressing and submits sampled polyline routes', () => {
  assert.equal(HOST, '0.0.0.0');
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'renderer.js'), 'utf8');
  assert.match(appSource, /location\.host/);
  assert.match(appSource, /collect_coin/);
  assert.match(appSource, /coinAtPoint/);
  assert.match(rendererSource, /drawCoins/);
  assert.doesNotMatch(rendererSource, /drawGrid/);
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

test('units ignore enemy soldiers and only advance toward target buildings', () => {
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
  // Units are self-destruct troops; they do not fight each other.
  assert.equal(room.units.get('one').hp, COMBAT_CONFIG.unitMaxHp);
  assert.equal(room.units.get('two').hp, COMBAT_CONFIG.unitMaxHp);
});

test('towers automatically damage enemy units inside their range', () => {
  const { room, player2 } = readyRoom();
  room.phase = 'playing';
  const tower = build(player2, 4, 15, 'tower');
  tower.constructedAt = -1e12; // already finished constructing in this unit test
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

test('a barracks does not spawn soldiers until the 0.5s construction finishes', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  room.playerState.player1.gold = 1000;
  const realNow = Date.now;
  try {
    const base = 1_700_000_000_000;
    // Freeze the clock so the build lands at `base` and construction ends at base+500.
    Date.now = () => base;
    const barracks = build(player1, 4, 2, 'barracks');
    const start = buildingCenter(barracks);
    const end = buildingCenter(room.buildings.get('player2_castle'));
    const bentPoints = [start, { x: start.x, y: 0.38 }, { x: end.x, y: 0.38 }, end];
    createRoute(player1, barracks.id, ['player2_castle'], bentPoints);
    // Still under construction: the barracks must not produce units yet.
    Date.now = () => base + 100;
    simulationStep(room, 1000);
    assert.equal(room.units.size, 0, 'no spawn while under construction');
    // Construction finished: spawns resume.
    Date.now = () => base + 600;
    simulationStep(room, 3000);
    assert.ok(room.units.size >= 1, 'barracks spawns after construction');
  } finally {
    Date.now = realNow;
  }
});

test('a tower does not fire until the 0.5s construction finishes', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const realNow = Date.now;
  try {
    const base = 1_700_000_000_000;
    Date.now = () => base;
    const tower = build(player1, 4, 2, 'tower');
    const center = buildingCenter(tower);
    // Enemy unit parked just inside tower range. player1's castle sits at
    // column 1, immediately LEFT of this tower (column 2), so we offset the
    // intruder to the RIGHT of the tower center — away from the castle — or it
    // would self-destruct on the castle before the tower ever fires.
    room.units.set('intruder', {
      id: 'intruder',
      owner: 'player2',
      barracksId: 'test',
      routeId: 'test',
      targetBuildingIds: ['player1_castle'],
      currentTargetIndex: 0,
      x: center.x + 0.05,
      y: center.y,
      hp: COMBAT_CONFIG.unitMaxHp,
      maxHp: COMBAT_CONFIG.unitMaxHp,
      attackCooldownMs: COMBAT_CONFIG.unitAttackIntervalMs
    });
    // Still under construction: the tower must not fire.
    Date.now = () => base + 100;
    simulationStep(room, COMBAT_CONFIG.tickMs);
    assert.equal(room.units.size, 1, 'intruder survives while tower is inert');
    assert.equal(
      room.units.get('intruder').hp,
      COMBAT_CONFIG.unitMaxHp,
      'tower does not fire while under construction'
    );
    // Construction finished: the tower fires on the in-range enemy.
    Date.now = () => base + 600;
    simulationStep(room, COMBAT_CONFIG.tickMs);
    assert.equal(
      room.units.get('intruder').hp,
      COMBAT_CONFIG.unitMaxHp - COMBAT_CONFIG.towerDamage,
      'tower fires after construction'
    );
  } finally {
    Date.now = realNow;
  }
});

test('destroyed expansion sources retract unsupported territory and cancel affected routes', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  const first = build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
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

test('destroying an intermediate route target prunes it but keeps the route and its soldiers', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  room.playerState.player1.gold = 1000;
  removeObstacle(room, 'tree_lf');
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  // Two enemy targets along the way: an intermediate tower, then the castle (final).
  const intermediate = addTestBuilding(room, {
    id: 'mid', type: 'tower', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1,
    hp: 100, maxHp: 100, claimOrder: room.nextClaimOrder++, attackCooldownMs: 0
  });
  const castle = room.buildings.get('player2_castle');
  const route = createRoute(
    player1, barracks.id,
    [intermediate.id, castle.id],
    directRoutePoints(room, barracks.id, [intermediate.id, castle.id])
  );
  assert.ok(route);
  assert.equal(room.routes.length, 1);
  spawnUnit(room, route);

  // Destroy only the intermediate target.
  destroyBuilding(room, intermediate.id, 'player1');

  // Route must survive; only the final target / barracks loss cancels it.
  assert.equal(room.routes.length, 1, 'route must survive an intermediate target loss');
  const live = room.routes[0];
  assert.ok(!live.targetBuildingIds.includes(intermediate.id), 'intermediate target pruned from route');
  assert.ok(live.targetBuildingIds.includes(castle.id), 'final target kept on route');
  // In-flight soldiers are NOT cleared — they keep marching to the final target.
  assert.equal(room.units.size, 1, 'soldiers must keep marching after an intermediate target is destroyed');
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

test('self-destruct units explode and disappear when reaching target', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  const castle = room.buildings.get('player2_castle');
  const castleHpBefore = castle.hp;
  const center = buildingCenter(castle);
  const unitId = 'bomber';
  room.units.set(unitId, {
    id: unitId,
    owner: 'player1',
    barracksId: 'test_barracks',
    routeId: 'test_route',
    targetBuildingIds: ['player2_castle'],
    currentTargetIndex: 0,
    x: center.x,
    y: center.y,
    hp: COMBAT_CONFIG.unitMaxHp,
    maxHp: COMBAT_CONFIG.unitMaxHp,
    attackCooldownMs: 0
  });
  simulationStep(room, COMBAT_CONFIG.tickMs);
  // Unit must have exploded and been removed.
  assert.equal(room.units.has(unitId), false);
  // Building must have taken explosion damage.
  assert.equal(castle.hp, castleHpBefore - COMBAT_CONFIG.unitExplosionDamage);
});

test('canceling a route removes all units spawned by that route', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const barracks = build(player1, 4, 2, 'barracks');
  room.routes.push({
    id: 'route_test',
    owner: 'player1',
    barracksId: barracks.id,
    targetBuildingIds: ['player2_castle'],
    targetPointIndices: [1],
    points: [buildingCenter(barracks), buildingCenter(room.buildings.get('player2_castle'))]
  });
  spawnUnit(room, room.routes[0]);
  spawnUnit(room, room.routes[0]);
  assert.equal(room.units.size, 2);
  // Real cancel: drops the route AND every in-flight unit.
  assert.equal(cancelRoute(player1, barracks.id), true);
  assert.equal(room.routes.length, 0);
  assert.equal(room.units.size, 0);
});

test('destroying a route target removes the route and its in-flight units', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const barracks = build(player1, 4, 2, 'barracks');
  const target = addTestBuilding(room, {
    id: 'route_target_x', type: 'tower', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1,
    hp: 100, maxHp: 100, claimOrder: room.nextClaimOrder++, attackCooldownMs: 0
  });
  recomputeTerritory(room);
  room.routes.push({
    id: 'route_x', owner: 'player1', barracksId: barracks.id,
    targetBuildingIds: [target.id], targetPointIndices: [1],
    points: [buildingCenter(barracks), buildingCenter(target)]
  });
  spawnUnit(room, room.routes[0]);
  spawnUnit(room, room.routes[0]);
  assert.equal(room.units.size, 2);
  destroyBuilding(room, target.id, 'player1');
  assert.equal(room.routes.length, 0);
  assert.equal(room.units.size, 0);
});

test('a building dropped on an existing route is not cancelled; marching units self-destruct on it', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  // Give plenty of gold so builds never fail.
  room.playerState.player1.gold = 9999;
  removeObstacle(room, 'tree_lf');
  removeAllObstacles(room);
  // Set up a barracks and a clean horizontal route to enemy castle.
  build(player1, 4, 2, 'mine');
  const barracks = build(player1, 4, 3, 'barracks');
  const start = buildingCenter(barracks);
  const end = buildingCenter(room.buildings.get('player2_castle'));
  const n = Math.ceil(ROUTE_CONFIG.minRawPoints) + 4;
  const rawPoints = [];
  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    rawPoints.push({ x: start.x + (end.x - start.x) * t, y: start.y });
  }
  const route = createRoute(player1, barracks.id, ['player2_castle'], rawPoints);
  assert.ok(route);
  assert.equal(room.routes.length, 1, 'route should exist before the blocker is placed');

  // The enemy drops a tower directly on the horizontal route path (neutral mid-map).
  const blocker = addTestBuilding(room, {
    id: 'blocker', type: 'tower', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1,
    hp: 420, maxHp: 420, claimOrder: room.nextClaimOrder++, attackCooldownMs: 0
  });

  // The route must stay — only destroying a target cancels it.
  assert.equal(room.routes.length, 1, 'route must NOT be cancelled when a building is placed on it');

  // A marching unit must self-destruct on the blocker instead of passing through.
  const unit = spawnUnit(room, route);
  assert.ok(unit);
  const unitId = unit.id;
  const towerHpBefore = blocker.hp;
  let steps = 0;
  // Track this specific unit — the barracks keeps auto-spawning others, so we
  // must not wait for the whole field to clear.
  while (room.units.has(unitId) && steps < 300) {
    simulationStep(room, COMBAT_CONFIG.tickMs);
    steps += 1;
  }
  assert.equal(room.units.has(unitId), false, 'the marching unit must explode on the blocker');
  assert.ok(blocker.hp < towerHpBefore, 'the blocker must take explosion damage');
});

test('resetRoom clears the board but keeps both castles at full hp', () => {
  const { room, player1 } = readyRoom();
  removeAllObstacles(room);
  const barracks = build(player1, 4, 2, 'barracks');
  assert.ok(barracks, 'barracks must build');
  const tower = addTestBuilding(room, {
    id: 't', type: 'tower', owner: 'player2',
    row: 4, column: 8, width: 1, height: 1, hp: 100, maxHp: 100,
    claimOrder: room.nextClaimOrder++
  });
  const route = createRoute(
    player1, barracks.id, ['player2_castle'],
    directRoutePoints(room, barracks.id, ['player2_castle'])
  );
  spawnUnit(room, route);
  room.playerState.player1.gold = 123;

  resetRoom(room);

  assert.equal(room.buildings.size, 2, 'only the two castles remain');
  assert.ok(room.buildings.has('player1_castle'));
  assert.ok(room.buildings.has('player2_castle'));
  assert.equal(room.units.size, 0, 'units cleared');
  assert.equal(room.routes.length, 0, 'routes cleared');
  assert.equal(room.playerState.player1.gold, GAME_CONFIG.startingGold, 'gold reset');
  assert.equal(room.winner, null, 'winner cleared');
  assert.equal(room.phase, 'playing', 'phase reset to playing');
  assert.equal(
    room.buildings.get('player1_castle').hp,
    GAME_CONFIG.buildingStats.castle.maxHp,
    'castle restored to full hp'
  );
  void tower;
});

test('resetRoom recreates a destroyed castle so rematch can continue', () => {
  const { room, player1 } = readyRoom();
  const castle = room.buildings.get('player2_castle');
  destroyBuilding(room, castle.id, 'player1');
  assert.equal(room.winner, 'player1', 'castle destroyed ends the game');
  assert.equal(room.buildings.has('player2_castle'), false, 'destroyed castle removed');

  resetRoom(room);

  assert.equal(room.buildings.has('player2_castle'), true, 'castle recreated');
  assert.equal(
    room.buildings.get('player2_castle').hp,
    GAME_CONFIG.buildingStats.castle.maxHp
  );
  assert.equal(room.winner, null);
  assert.equal(room.phase, 'playing');
});

test('requestRematch resets only after both players vote', () => {
  const { room, player1, player2 } = readyRoom();
  destroyBuilding(room, room.buildings.get('player2_castle').id, 'player1');

  requestRematch(player1);
  assert.equal(room.winner, 'player1', 'no reset on single vote');
  assert.ok(
    player2.messages.some((m) => m.type === 'rematch_pending'),
    'opponent is notified of the pending request'
  );

  requestRematch(player2);
  assert.equal(room.winner, null, 'room resets once both vote');
  assert.equal(room.phase, 'playing');
  assert.ok(
    player1.messages.some((m) => m.type === 'game_reset'),
    'both players receive game_reset'
  );
  assert.ok(
    player2.messages.some((m) => m.type === 'game_reset')
  );
});

test('requestRematch resets immediately when the opponent is absent', () => {
  const { room, player1, player2 } = readyRoom();
  leaveRoom(player2);
  assert.equal(room.players.size, 1, 'only one player remains');

  requestRematch(player1);

  assert.equal(room.winner, null, 'solo rematch resets the board');
  assert.equal(room.phase, 'playing');
  assert.ok(
    player1.messages.some((m) => m.type === 'game_reset'),
    'the remaining player receives game_reset'
  );
});

test('rejoinRoom restores a player into their original slot', () => {
  const { room, player1, player2 } = readyRoom();
  const roomId = 'test-room';
  leaveRoom(player1);
  assert.equal(room.players.has('player1'), false, 'player1 left');

  const fresh = mockSocket(roomId, 'player1');
  fresh.roomId = undefined; // simulate a brand-new socket reconnecting
  rejoinRoom(fresh, roomId, 'player1');

  assert.equal(room.players.get('player1').socket, fresh, 'player1 restored');
  assert.equal(fresh.roomId, roomId);
  assert.equal(fresh.playerId, 'player1');
  assert.ok(
    fresh.messages.some((m) => m.type === 'welcome'),
    'rejoinee gets welcome'
  );
  assert.ok(
    player2.messages.some((m) => m.type === 'opponent_joined'),
    'opponent is told the player rejoined'
  );
});

test('rejoinRoom evicts a stale socket occupying the preferred slot', () => {
  const { room } = readyRoom();
  const roomId = 'test-room';
  // Simulate a dead socket still registered in player1's slot.
  room.players.set('player1', { socket: { readyState: WebSocket.CLOSED, send() {} } });

  const fresh = mockSocket(roomId, 'player1');
  fresh.roomId = undefined; // simulate a brand-new socket reconnecting
  rejoinRoom(fresh, roomId, 'player1');

  assert.equal(room.players.get('player1').socket, fresh, 'stale socket evicted');
  assert.equal(fresh.playerId, 'player1');
});

test('upgradeCost scales with the next level', () => {
  const track = UPGRADE_CONFIG.tracks.mine;
  assert.equal(upgradeCost('mine', 0), track.baseCost);
  assert.equal(upgradeCost('mine', 1), track.baseCost + track.costStep);
  assert.equal(upgradeCost('mine', track.maxLevel), Number.POSITIVE_INFINITY);
});

test('zeroUpgrades seeds every track at level 0', () => {
  const upgrades = zeroUpgrades();
  assert.equal(Object.keys(upgrades).length, Object.keys(UPGRADE_CONFIG.tracks).length);
  assert.ok(Object.values(upgrades).every((level) => level === 0));
});

test('effective helpers grow with upgrade level', () => {
  const { room } = readyRoom();
  const baseIncome = effectiveMineIncome(room, 'player1');
  const baseDamage = effectiveTowerDamage(room, 'player1');
  const baseRange = effectiveTowerRange(room, 'player1');
  const baseInterval = effectiveSpawnInterval(room, 'player1');
  const baseHp = effectiveUnitMaxHp(room, 'player1');
  const baseExplosion = effectiveUnitExplosionDamage(room, 'player1');
  room.playerState.player1.upgrades.mine = UPGRADE_CONFIG.tracks.mine.maxLevel;
  room.playerState.player1.upgrades.towerDamage = UPGRADE_CONFIG.tracks.towerDamage.maxLevel;
  room.playerState.player1.upgrades.towerRange = UPGRADE_CONFIG.tracks.towerRange.maxLevel;
  room.playerState.player1.upgrades.barracksRate = UPGRADE_CONFIG.tracks.barracksRate.maxLevel;
  room.playerState.player1.upgrades.soldierHp = UPGRADE_CONFIG.tracks.soldierHp.maxLevel;
  room.playerState.player1.upgrades.soldierDamage = UPGRADE_CONFIG.tracks.soldierDamage.maxLevel;
  assert.ok(effectiveMineIncome(room, 'player1') > baseIncome);
  assert.ok(effectiveTowerDamage(room, 'player1') > baseDamage);
  assert.ok(effectiveTowerRange(room, 'player1') > baseRange);
  assert.ok(effectiveSpawnInterval(room, 'player1') < baseInterval);
  assert.ok(effectiveUnitMaxHp(room, 'player1') > baseHp);
  assert.ok(effectiveUnitExplosionDamage(room, 'player1') > baseExplosion);
});

test('upgrade deducts gold, raises level and rejects maxed or unaffordable', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const track = UPGRADE_CONFIG.tracks.mine;
  const before = room.playerState.player1.gold;
  upgrade(player1, 'mine');
  assert.equal(room.playerState.player1.upgrades.mine, 1);
  assert.equal(room.playerState.player1.gold, before - upgradeCost('mine', 0));

  room.playerState.player1.upgrades.mine = track.maxLevel;
  const rejectedMax = upgrade(player1, 'mine');
  assert.equal(rejectedMax, undefined);
  assert.equal(room.playerState.player1.upgrades.mine, track.maxLevel);

  room.playerState.player1.gold = 0;
  const rejectedPoor = upgrade(player1, 'towerDamage');
  assert.equal(rejectedPoor, undefined);
  assert.equal(room.playerState.player1.upgrades.towerDamage, 0);
});

test('mine upgrade increases per-tick income', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  const mine = addTestBuilding(room, {
    id: 'p1_mine', type: 'mine', owner: 'player1', row: 4, column: 3, width: 1, height: 1
  });
  room.playerState.player1.gold = 0;
  applyMineIncome(room, false);
  const base = room.playerState.player1.gold;
  room.playerState.player1.upgrades.mine = UPGRADE_CONFIG.tracks.mine.maxLevel;
  room.playerState.player1.gold = 0;
  applyMineIncome(room, false);
  const boosted = room.playerState.player1.gold;
  assert.ok(boosted > base, 'upgraded mine should pay more');
  assert.ok(mine.owner === 'player1');
});

test('upgraded tower deals more damage to an enemy unit', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  addTestBuilding(room, { id: 'p1_tower', type: 'tower', owner: 'player1', row: 4, column: 5, width: 1, height: 1 });
  addTestBuilding(room, { id: 'p2_barracks', type: 'barracks', owner: 'player2', row: 4, column: 10, width: 1, height: 1 });
  addTestBuilding(room, { id: 'p1_mine', type: 'mine', owner: 'player1', row: 4, column: 13, width: 1, height: 1 });
  removeAllObstacles(room);
  createRoute(room.players.get('player2').socket, 'p2_barracks', ['p1_mine'], directRoutePoints(room, 'p2_barracks', ['p1_mine']));
  const towerCenter = buildingCenter(room.buildings.get('p1_tower'), room.map);

  function spawnNearTower() {
    room.units.clear();
    room.buildings.get('p1_tower').attackCooldownMs = 0;
    const unit = spawnUnit(room, room.routes[0]);
    unit.x = towerCenter.x + 0.10;
    unit.y = towerCenter.y;
    unit.hp = 200;
    unit.maxHp = 200;
    return unit;
  }

  const baseUnit = spawnNearTower();
  simulationStep(room);
  const baseDamage = 200 - baseUnit.hp;
  assert.ok(baseDamage > 0, 'tower should damage an in-range enemy');

  const boostedUnit = spawnNearTower();
  room.playerState.player1.upgrades.towerDamage = UPGRADE_CONFIG.tracks.towerDamage.maxLevel;
  simulationStep(room);
  const boostedDamage = 200 - boostedUnit.hp;
  assert.ok(boostedDamage > baseDamage, 'upgraded tower should hit harder');
});

test('spawned unit carries upgraded hp, speed and explosion damage', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  const barracks = addTestBuilding(room, {
    id: 'p1_barracks', type: 'barracks', owner: 'player1', row: 4, column: 4, width: 1, height: 1
  });
  const enemy = addTestBuilding(room, {
    id: 'p2_castle', type: 'castle', owner: 'player2', row: 4, column: 8, width: 1, height: 1
  });
  createRoute(room.players.get('player1').socket, 'p1_barracks', ['p2_castle'], directRoutePoints(room, 'p1_barracks', ['p2_castle']));
  room.playerState.player1.upgrades.soldierHp = UPGRADE_CONFIG.tracks.soldierHp.maxLevel;
  room.playerState.player1.upgrades.soldierSpeed = UPGRADE_CONFIG.tracks.soldierSpeed.maxLevel;
  room.playerState.player1.upgrades.soldierDamage = UPGRADE_CONFIG.tracks.soldierDamage.maxLevel;
  const unit = spawnUnit(room, room.routes[0]);
  assert.equal(unit.maxHp, effectiveUnitMaxHp(room, 'player1'));
  assert.equal(unit.speedMul, effectiveUnitSpeedMul(room, 'player1'));
  assert.equal(unit.explosionDamage, effectiveUnitExplosionDamage(room, 'player1'));
});

test('combat emits transient events drained by broadcastState', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  addTestBuilding(room, { id: 'p1_tower', type: 'tower', owner: 'player1', row: 4, column: 5, width: 1, height: 1 });
  addTestBuilding(room, { id: 'p2_barracks', type: 'barracks', owner: 'player2', row: 4, column: 10, width: 1, height: 1 });
  addTestBuilding(room, { id: 'p1_mine', type: 'mine', owner: 'player1', row: 4, column: 13, width: 1, height: 1 });
  addTestBuilding(room, { id: 'p1_castle', type: 'castle', owner: 'player1', row: 7, column: 13, width: 1, height: 1 });
  removeAllObstacles(room);
  createRoute(room.players.get('player2').socket, 'p2_barracks', ['p1_mine'], directRoutePoints(room, 'p2_barracks', ['p1_mine']));
  const towerCenter = buildingCenter(room.buildings.get('p1_tower'), room.map);
  const unit = spawnUnit(room, room.routes[0]);
  unit.x = towerCenter.x + 0.10;
  unit.y = towerCenter.y;
  simulationStep(room, 50);
  assert.ok(room.effects.some((effect) => effect.type === 'tower_fire'), 'tower fire event emitted');

  destroyBuilding(room, 'p1_tower', 'player2');
  assert.ok(room.effects.some((effect) => effect.type === 'building_destroyed'), 'building destroyed event emitted');

  const castle = [...room.buildings.values()].find((b) => b.type === 'castle');
  destroyBuilding(room, castle.id, 'player2');
  assert.ok(room.effects.some((effect) => effect.type === 'castle_destroyed'), 'castle destroyed event emitted');

  const snapshot = publicState(room);
  assert.ok(Array.isArray(snapshot.events) && snapshot.events.length > 0);
  assert.ok(snapshot.rules.upgrades && snapshot.rules.upgrades.mine, 'rules expose upgrades');

  broadcastState(room);
  assert.equal(room.effects.length, 0, 'events drained after broadcast');
});

test('spawnCoin drops a neutral coin on a walkable tile and honours maxActive', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  for (let i = 0; i < PICKUP_CONFIG.maxActive + 3; i += 1) spawnCoin(room);
  assert.equal(room.coins.size, PICKUP_CONFIG.maxActive, 'coin count capped at maxActive');
  for (const coin of room.coins.values()) {
    const cell = cellFor(room.map, coin.row, coin.column);
    assert.equal(cell.terrain, 'grass', 'coin sits on grass');
    assert.ok(!cell.blocked && !cell.buildingId && !cell.obstacleId, 'coin tile is walkable and empty');
    assert.equal(coin.value, PICKUP_CONFIG.value);
    assert.equal(coin.remainingMs, PICKUP_CONFIG.lifetimeMs);
  }
});

test('coins expire after their lifetime during simulationStep', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  spawnCoin(room);
  assert.equal(room.coins.size, 1);
  // One step longer than the lifetime but shorter than the spawn interval so no
  // replacement coin appears this tick.
  simulationStep(room, PICKUP_CONFIG.lifetimeMs + 1);
  assert.equal(room.coins.size, 0, 'expired coin removed');
});

test('collectCoin awards gold to whoever clicks first and is contested', () => {
  const { room, player1, player2 } = readyRoom();
  room.phase = 'playing';

  const coinA = spawnCoin(room);
  const before1 = room.playerState.player1.gold;
  const gained = collectCoin(player1, coinA.id);
  assert.equal(gained, coinA.value);
  assert.equal(room.playerState.player1.gold, before1 + coinA.value, 'player1 gains coin value');
  assert.ok(!room.coins.has(coinA.id), 'collected coin removed');
  // collectCoin broadcasts immediately (which drains room.effects), so inspect the
  // game_state that was pushed to the players instead of the now-empty room.effects.
  const stateMsg = [...player1.messages].reverse().find((m) => m.type === 'game_state');
  assert.ok(
    stateMsg && stateMsg.events.some((e) => e.type === 'coin_collect' && e.owner === 'player1'),
    'coin_collect event broadcast to players'
  );

  // A neutral coin can just as well be grabbed by the opponent.
  const coinB = spawnCoin(room);
  const before2 = room.playerState.player2.gold;
  collectCoin(player2, coinB.id);
  assert.equal(room.playerState.player2.gold, before2 + coinB.value, 'player2 can also collect');
});

test('collectCoin on a missing/expired coin is rejected without granting gold', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const before = room.playerState.player1.gold;
  player1.messages.length = 0;
  const result = collectCoin(player1, 'coin_does_not_exist');
  assert.equal(result, undefined, 'no value returned for a missing coin');
  assert.equal(room.playerState.player1.gold, before, 'gold unchanged');
  assert.ok(
    player1.messages.some((m) => m.type === 'action_rejected' && m.action === 'collect_coin'),
    'client told the coin is gone'
  );
});

test('publicState exposes coins and resetRoom clears them', () => {
  const { room } = readyRoom();
  room.phase = 'playing';
  spawnCoin(room);
  spawnCoin(room);
  const snapshot = publicState(room);
  assert.ok(Array.isArray(snapshot.coins) && snapshot.coins.length === 2, 'coins in snapshot');
  assert.ok(
    snapshot.coins.every((c) => typeof c.id === 'string' && Number.isFinite(c.x) && Number.isFinite(c.y) && c.value > 0),
    'coin snapshot has id/x/y/value'
  );
  resetRoom(room);
  assert.equal(room.coins.size, 0, 'coins cleared on rematch');
  assert.equal(room.coinElapsedMs, 0, 'coin timer reset');
});

test('returnToLobby keeps the room alive and the opponent continues playing', () => {
  const { room, player1, player2 } = readyRoom();
  const roomId = player1.roomId;
  assert.ok(rooms.has(roomId), 'room exists before returning to lobby');
  returnToLobby(player1);
  assert.ok(rooms.has(roomId), 'room stays in the registry (not dissolved)');
  assert.equal(player1.roomId, roomId, 'player stays attached to the room');
  assert.equal(player2.roomId, roomId, 'opponent stays attached to the room');
  assert.equal(room.players.get('player1').inLobby, true, 'player flagged as in lobby');
  const closed = player2.messages.find((m) => m.type === 'room_closed');
  assert.ok(!closed, 'opponent is NOT told the room closed');
  const inLobby = player2.messages.find((m) => m.type === 'opponent_in_lobby');
  assert.ok(inLobby, 'opponent told the player stepped back to the lobby');
});

test('returnToLobby is a no-op without an active room', () => {
  const socket = mockSocket('nowhere', 'player1');
  assert.equal(returnToLobby(socket), undefined, 'nothing to return from');
});

test('a new barracks route can merge into an existing friendly route (shared corridor)', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  // Two barracks for player1 on the same row as the enemy castle, so the merge
  // segment stays clear of own buildings. b1 leads; b2 merges in partway.
  addTestBuilding(room, { id: 'b1', type: 'barracks', owner: 'player1', row: 4, column: 2, width: 1, height: 1 });
  addTestBuilding(room, { id: 'b2', type: 'barracks', owner: 'player1', row: 8, column: 4, width: 1, height: 1 });
  removeAllObstacles(room);
  // Flatten cliffs so the only route constraint in this test is own buildings.
  for (const cell of room.map.cells) cell.terrain = 'grass';
  const enemyCastle = [...room.buildings.values()].find((b) => b.type === 'castle' && b.owner === 'player2');
  createRoute(player1, 'b1', [enemyCastle.id], directRoutePoints(room, 'b1', [enemyCastle.id]));
  const aRoute = room.routes.find((r) => r.barracksId === 'b1');
  assert.ok(aRoute, 'first route created');

  // Merge b2 into b1's route at an interior point: new segment + inherited tail.
  const snapIndex = Math.min(3, aRoute.points.length - 2);
  const combined = [buildingCenter(room.buildings.get('b2'), room.map), ...aRoute.points.slice(snapIndex + 1)];
  const merged = createRoute(player1, 'b2', [...aRoute.targetBuildingIds], combined);
  assert.ok(merged, 'merged route created');
  assert.deepEqual(merged.targetBuildingIds, aRoute.targetBuildingIds, 'merged route inherits the original targets');
  assert.ok(
    Math.hypot(merged.points[0].x - buildingCenter(room.buildings.get('b2'), room.map).x,
      merged.points[0].y - buildingCenter(room.buildings.get('b2'), room.map).y) < 1e-6,
    'merged route starts at the new barracks'
  );
  assert.ok(
    Math.hypot(merged.points.at(-1).x - buildingCenter(enemyCastle, room.map).x,
      merged.points.at(-1).y - buildingCenter(enemyCastle, room.map).y) < 1e-6,
    'merged route ends at the shared enemy target'
  );
  // Both barracks now feed the same corridor (two routes sharing the tail segment).
  assert.equal(room.routes.filter((r) => r.owner === 'player1').length, 2, 'both barracks have a route');
});

test('demolishBuilding removes the player\'s own non-castle building and refunds no gold', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  const goldBefore = room.playerState.player1.gold;
  // Give player1 a mine to demolish.
  addTestBuilding(room, { id: 'p1_mine', type: 'mine', owner: 'player1', row: 4, column: 4, width: 1, height: 1 });
  assert.ok(room.buildings.has('p1_mine'), 'mine placed');
  const result = demolishBuilding(player1, 'p1_mine');
  assert.equal(result, true, 'demolish succeeds');
  assert.ok(!room.buildings.has('p1_mine'), 'building removed from the room');
  assert.equal(room.playerState.player1.gold, goldBefore, 'no gold refunded on demolish');
  const broadcast = player1.messages.at(-1);
  assert.equal(broadcast?.type, 'game_state', 'state broadcast after demolish');
  assert.ok(broadcast?.events?.some((e) => e.type === 'building_destroyed' && e.owner === 'player1'), 'destruction effect broadcast');
});

test('demolishBuilding rejects the castle and enemy/unknown buildings', () => {
  const { room, player1, player2 } = readyRoom();
  room.phase = 'playing';
  // Enemy building cannot be demolished by player1.
  const enemyCastle = [...room.buildings.values()].find((b) => b.type === 'castle' && b.owner === 'player2');
  assert.equal(demolishBuilding(player1, enemyCastle.id), undefined, 'cannot demolish enemy castle');
  assert.ok(room.buildings.has(enemyCastle.id), 'enemy castle untouched');
  // Own castle cannot be demolished.
  const ownCastle = [...room.buildings.values()].find((b) => b.type === 'castle' && b.owner === 'player1');
  assert.equal(demolishBuilding(player1, ownCastle.id), undefined, 'own castle cannot be demolished');
  assert.ok(room.buildings.has(ownCastle.id), 'own castle untouched');
  // Unknown id rejected.
  assert.equal(demolishBuilding(player1, 'does_not_exist'), undefined, 'unknown building rejected');
});

test('demolishing a barracks cancels its route and removes its marching units', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  addTestBuilding(room, { id: 'b1', type: 'barracks', owner: 'player1', row: 4, column: 2, width: 1, height: 1 });
  for (const o of [...room.obstacles.values()]) room.obstacles.delete(o.id);
  const enemyCastle = [...room.buildings.values()].find((b) => b.type === 'castle' && b.owner === 'player2');
  createRoute(player1, 'b1', [enemyCastle.id], directRoutePoints(room, 'b1', [enemyCastle.id]));
  spawnUnit(room, room.routes.find((r) => r.barracksId === 'b1'));
  assert.equal(room.routes.length, 1, 'route exists');
  assert.ok(room.units.size >= 1, 'a unit is marching');
  demolishBuilding(player1, 'b1');
  assert.ok(!room.buildings.has('b1'), 'barracks removed');
  assert.equal(room.routes.length, 0, 'route cancelled with the barracks');
  assert.equal(room.units.size, 0, 'marching units removed');
});

test('createRoute prunes backtracking loops from the drawn path', () => {
  const { room, player1 } = readyRoom();
  room.phase = 'playing';
  for (const o of [...room.obstacles.values()]) room.obstacles.delete(o.id);
  addTestBuilding(room, { id: 'b1', type: 'barracks', owner: 'player1', row: 4, column: 2, width: 1, height: 1 });
  addTestBuilding(room, { id: 'enemy_tower', type: 'tower', owner: 'player2', row: 1, column: 2, width: 1, height: 1 });
  const start = buildingCenter(room.buildings.get('b1'));
  const right = buildingCenter({ row: 4, column: 6, width: 1, height: 1 });
  const back = buildingCenter({ row: 4, column: 4, width: 1, height: 1 });
  const up = buildingCenter(room.buildings.get('enemy_tower'));
  const route = createRoute(player1, 'b1', ['enemy_tower'], [start, right, back, up]);
  assert.ok(route, 'route is created despite the drawn loop');
  assert.deepEqual(route.targetBuildingIds, ['enemy_tower']);
  // The right-then-left detour should be removed: no segment should travel
  // back toward the barracks horizontally.
  for (let i = 1; i < route.points.length; i += 1) {
    assert.ok(
      !(route.points[i].x < route.points[i - 1].x),
      `no leftward backtracking at segment ${i - 1}->${i}`
    );
  }
});

test('reserve_cell lets a player build after the cell flips to the opponent', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf'); // open (4,3)
  const target = cellFor(room.map, 4, 3);
  assert.equal(target.territory, 'player1', 'cell is ours before the grab');
  const index = 4 * room.map.columns + 3;
  reserveCell(player1, 4, 3);
  assert.equal(room.reservations.get(index), 'player1', 'cell is reserved by us');
  // The opponent's expansion overwrites the cell while our build menu is open.
  target.territory = 'player2';
  target.buildable = false;
  // Without the reservation this would be rejected; with it, the build lands.
  const building = build(player1, 4, 3, 'tower');
  assert.ok(building, 'build succeeds despite the flipped territory');
  assert.equal(building.owner, 'player1');
  assert.equal(cellFor(room.map, 4, 3).buildingId, building.id);
  assert.equal(room.reservations.has(index), false, 'reservation consumed by the build');
});

test('a reservation blocks the opponent from building on that cell', () => {
  const { room, player1, player2 } = readyRoom();
  room.playerState.player1.gold = 1000;
  room.playerState.player2.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
  const target = cellFor(room.map, 4, 3);
  reserveCell(player1, 4, 3);
  const index = 4 * room.map.columns + 3;
  // Flip the territory to the opponent.
  target.territory = 'player2';
  target.buildable = false;
  const goldBefore = room.playerState.player2.gold;
  const result = build(player2, 4, 3, 'tower');
  assert.equal(result, undefined, 'opponent build rejected on a reserved cell');
  assert.equal(cellFor(room.map, 4, 3).buildingId, null, 'no building placed');
  assert.equal(room.playerState.player2.gold, goldBefore, 'no gold spent');
  assert.equal(room.reservations.get(index), 'player1', 'our reservation survives');
});

test('cancelReservation releases the cell so the opponent can claim it', () => {
  const { room, player1, player2 } = readyRoom();
  room.playerState.player1.gold = 1000;
  room.playerState.player2.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
  const index = 4 * room.map.columns + 3;
  reserveCell(player1, 4, 3);
  assert.ok(room.reservations.has(index));
  cancelReservation(player1, 4, 3);
  assert.equal(room.reservations.has(index), false, 'reservation released');
  // Now the opponent grabs and builds it.
  const target = cellFor(room.map, 4, 3);
  target.territory = 'player2';
  const building = build(player2, 4, 3, 'tower');
  assert.ok(building, 'opponent can now build there');
  assert.equal(building.owner, 'player2');
});

test('a reservation is first-come and silently ignores a repeat reservation', () => {
  const { room, player1, player2 } = readyRoom();
  room.playerState.player1.gold = 1000;
  room.playerState.player2.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
  const index = 4 * room.map.columns + 3;
  reserveCell(player1, 4, 3);
  // Opponent trying to reserve the same cell is a no-op (cannot steal the grab).
  reserveCell(player2, 4, 3);
  assert.equal(room.reservations.get(index), 'player1');
  // A repeat reservation by the same player does not error or change ownership.
  reserveCell(player1, 4, 3);
  assert.equal(room.reservations.get(index), 'player1');
});

test('reserveCell only accepts your own buildable land', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  const index = 4 * room.map.columns + 3;
  // (4,3) still has the authored tree -> cannot be reserved.
  assert.equal(cellFor(room.map, 4, 3).obstacleId, 'tree_lf');
  reserveCell(player1, 4, 3);
  assert.equal(room.reservations.has(index), false, 'blocked cell not reserved');
  // Neutral cell away from any territory cannot be reserved either.
  reserveCell(player1, 4, 8);
  assert.equal(room.reservations.has(4 * room.map.columns + 8), false);
});

test('destroyBuilding frees any reservation held on its cell', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
  const index = 4 * room.map.columns + 3;
  reserveCell(player1, 4, 3);
  assert.ok(room.reservations.has(index));
  const mine = room.buildings.get('player1_building') || [...room.buildings.values()].find((b) => b.type === 'mine' && b.owner === 'player1');
  // Reserve a cell, then destroy a building on a DIFFERENT cell to confirm only
  // the destroyed cell's reservation (if any) is cleared. Here we reserve (4,3)
  // and destroy the mine at (4,2); (4,3) reservation must remain until built.
  assert.ok(mine);
  destroyBuilding(room, mine.id, 'player2');
  assert.ok(room.reservations.has(index), 'unrelated reservation survives a destroy');
  // Building consumes the reservation.
  build(player1, 4, 3, 'tower');
  assert.equal(room.reservations.has(index), false);
});

test('resetRoom clears all reservations', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
  reserveCell(player1, 4, 3);
  assert.ok(room.reservations.size > 0);
  resetRoom(room);
  assert.equal(room.reservations.size, 0, 'reservations wiped by rematch reset');
});

test('publicState reports active reservations', () => {
  const { room, player1 } = readyRoom();
  room.playerState.player1.gold = 1000;
  build(player1, 4, 2, 'mine');
  removeObstacle(room, 'tree_lf');
  reserveCell(player1, 4, 3);
  const state = publicState(room);
  assert.ok(Array.isArray(state.reservations));
  assert.ok(state.reservations.some((r) => r.row === 4 && r.column === 3 && r.owner === 'player1'));
});
