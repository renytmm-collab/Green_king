const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const {
  GAME_CONFIG,
  MAP_CONFIG,
  MAPS,
  DEFAULT_MAP_ID,
  LEVEL_CONFIG,
  ROUTE_CONFIG,
  COMBAT_CONFIG,
  UPGRADE_CONFIG,
  zeroUpgrades,
  PICKUP_CONFIG,
  NETWORK_CONFIG
} = require('./server/config');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';
const rooms = new Map();

function safeSend(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket, message) {
  safeSend(socket, { type: 'error', message });
}

function reject(socket, action, reason) {
  safeSend(socket, { type: 'action_rejected', action, reason });
}

function broadcast(room, message) {
  for (const player of room.players.values()) safeSend(player.socket, message);
}

// ── Upgrade-aware value helpers (server-authoritative) ──
function upgradeLevel(room, owner, trackId) {
  return room.playerState[owner]?.upgrades?.[trackId] || 0;
}

function upgradeCost(trackId, currentLevel) {
  const track = UPGRADE_CONFIG.tracks[trackId];
  if (!track) return Number.POSITIVE_INFINITY;
  if (currentLevel >= track.maxLevel) return Number.POSITIVE_INFINITY;
  return track.baseCost + track.costStep * currentLevel;
}

function effectiveMineIncome(room, owner) {
  const track = UPGRADE_CONFIG.tracks.mine;
  return GAME_CONFIG.mineIncome * (1 + upgradeLevel(room, owner, 'mine') * track.mul);
}

function effectiveTowerDamage(room, owner) {
  const track = UPGRADE_CONFIG.tracks.towerDamage;
  return COMBAT_CONFIG.towerDamage * (1 + upgradeLevel(room, owner, 'towerDamage') * track.mul);
}

function effectiveTowerRange(room, owner) {
  const track = UPGRADE_CONFIG.tracks.towerRange;
  return COMBAT_CONFIG.towerRange * (1 + upgradeLevel(room, owner, 'towerRange') * track.mul);
}

function effectiveSpawnInterval(room, owner) {
  const track = UPGRADE_CONFIG.tracks.barracksRate;
  return COMBAT_CONFIG.barracksSpawnIntervalMs
    / (1 + upgradeLevel(room, owner, 'barracksRate') * track.mul);
}

function effectiveUnitMaxHp(room, owner) {
  const track = UPGRADE_CONFIG.tracks.soldierHp;
  return COMBAT_CONFIG.unitMaxHp * (1 + upgradeLevel(room, owner, 'soldierHp') * track.mul);
}

function effectiveUnitSpeedMul(room, owner) {
  const track = UPGRADE_CONFIG.tracks.soldierSpeed;
  return 1 + upgradeLevel(room, owner, 'soldierSpeed') * track.mul;
}

function effectiveUnitExplosionDamage(room, owner) {
  const track = UPGRADE_CONFIG.tracks.soldierDamage;
  return COMBAT_CONFIG.unitExplosionDamage * (1 + upgradeLevel(room, owner, 'soldierDamage') * track.mul);
}

function pushEffect(room, effect) {
  if (!room.effects) room.effects = [];
  room.effects.push(effect);
}

function publicState(room) {
  return {
    type: 'game_state',
    ready: room.players.size === 2,
    phase: room.phase,
    winner: room.winner,
    events: room.effects || [],
    serverTime: Date.now(),
    mapId: room.mapId,
    mapName: room.mapDef.name,
    rules: {
      buildingCosts: GAME_CONFIG.buildingCosts,
      clearCosts: GAME_CONFIG.clearCosts,
      maxRouteTargets: ROUTE_CONFIG.maxTargets,
      maxRouteSamples: ROUTE_CONFIG.maxRawPoints,
      combat: COMBAT_CONFIG,
      upgrades: UPGRADE_CONFIG.tracks
    },
    players: room.playerState,
    map: room.map,
    buildings: [...room.buildings.values()].map((building) => ({
      id: building.id,
      type: building.type,
      owner: building.owner,
      row: building.row,
      column: building.column,
      width: building.width,
      height: building.height,
      hp: building.hp,
      maxHp: building.maxHp,
      constructedAt: building.constructedAt,
      constructionDurationMs: building.constructionDurationMs
    })),
    obstacles: [...room.obstacles.values()],
    reservations: [...room.reservations.entries()].map(([index, owner]) => ({
      row: Math.floor(index / room.map.columns),
      column: index % room.map.columns,
      owner
    })),
    routes: room.routes,
    units: [...room.units.values()].map((unit) => ({
      id: unit.id,
      owner: unit.owner,
      x: unit.x,
      y: unit.y,
      facing: unit.facing === 'left' || unit.facing === 'right'
        ? unit.facing
        : unit.owner === 'player1' ? 'right' : 'left',
      hp: unit.hp,
      maxHp: unit.maxHp
    })),
    coins: [...room.coins.values()].map((coin) => ({
      id: coin.id,
      x: coin.x,
      y: coin.y,
      value: coin.value,
      remainingMs: coin.remainingMs,
      lifetimeMs: coin.lifetimeMs
    }))
  };
}

function sendState(socket, room) {
  safeSend(socket, publicState(room));
}

function broadcastState(room) {
  const message = publicState(room);
  broadcast(room, message);
  room.effects = [];
}

function makeRoomId() {
  let id;
  do {
    id = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(id));
  return id;
}

function log(event, details) {
  console.log(`[${new Date().toISOString()}] ${event} ${details}`);
}

function cellFor(map, row, column) {
  if (
    !Number.isInteger(row)
    || !Number.isInteger(column)
    || row < 0
    || row >= map.rows
    || column < 0
    || column >= map.columns
  ) return undefined;
  return map.cells[row * map.columns + column];
}

function createMap(mapDef) {
  const def = mapDef || MAPS[DEFAULT_MAP_ID];
  if (
    def.terrainRows.length !== MAP_CONFIG.rows
    || def.terrainRows.some((row) => row.length !== MAP_CONFIG.columns)
  ) throw new Error('Level terrain dimensions do not match MAP_CONFIG.');
  const cells = [];
  for (let row = 0; row < MAP_CONFIG.rows; row += 1) {
    for (let column = 0; column < MAP_CONFIG.columns; column += 1) {
      const symbol = def.terrainRows[row][column];
      const terrain = symbol === '#' ? 'cliff' : 'grass';
      cells.push({
        row,
        column,
        territory: 'neutral',
        terrain,
        buildable: false,
        blocked: terrain === 'cliff',
        buildingId: null,
        obstacleId: null
      });
    }
  }
  return { rows: MAP_CONFIG.rows, columns: MAP_CONFIG.columns, cells };
}

function addBuilding(room, building) {
  const cell = cellFor(room.map, building.row, building.column);
  const stats = GAME_CONFIG.buildingStats[building.type];
  if (!stats) throw new Error(`Missing stats for building type ${building.type}.`);
  const activeBuilding = {
    ...building,
    maxHp: building.maxHp ?? stats.maxHp,
    hp: building.hp ?? building.maxHp ?? stats.maxHp,
    claimOrder: building.claimOrder ?? room.nextClaimOrder++,
    spawnElapsedMs: building.spawnElapsedMs ?? 0,
    attackCooldownMs: building.attackCooldownMs ?? 0,
    constructedAt: building.constructedAt ?? Date.now(),
    constructionDurationMs: building.constructionDurationMs ?? GAME_CONFIG.constructionDurationMs
  };
  room.buildings.set(activeBuilding.id, activeBuilding);
  cell.buildingId = activeBuilding.id;
  cell.buildable = false;
  return activeBuilding;
}

// A building is "under construction" until (constructedAt + duration) elapses.
// While constructing it cannot spawn soldiers or fire — matching the 0.5s
// build animation the client renders over the official sprite.
function isConstructing(building) {
  if (!building || typeof building.constructedAt !== 'number') return false;
  const duration = building.constructionDurationMs ?? GAME_CONFIG.constructionDurationMs;
  return building.constructedAt + duration > Date.now();
}

function addObstacle(room, obstacle) {
  const cell = cellFor(room.map, obstacle.row, obstacle.column);
  if (!cell || cell.terrain !== 'grass' || cell.buildingId || cell.obstacleId) {
    throw new Error(`Invalid authored obstacle ${obstacle.id}.`);
  }
  const roomObstacle = { ...obstacle, width: 1, height: 1 };
  room.obstacles.set(roomObstacle.id, roomObstacle);
  cell.obstacleId = roomObstacle.id;
  cell.blocked = true;
}

function expandTerritory(room, playerId, row, column, radius) {
  let claimed = 0;
  for (let targetRow = row - radius; targetRow <= row + radius; targetRow += 1) {
    for (let targetColumn = column - radius; targetColumn <= column + radius; targetColumn += 1) {
      const cell = cellFor(room.map, targetRow, targetColumn);
      if (!cell || cell.terrain !== 'grass') continue;
      const occupyingBuilding = cell.buildingId && room.buildings.get(cell.buildingId);
      if (occupyingBuilding && occupyingBuilding.owner !== playerId) continue;
      if (cell.territory !== playerId) claimed += 1;
      cell.territory = playerId;
      cell.buildable = !cell.buildingId && !cell.obstacleId;
    }
  }
  return claimed;
}

function recomputeTerritory(room) {
  for (const cell of room.map.cells) {
    if (cell.terrain !== 'grass') continue;
    cell.territory = 'neutral';
    cell.buildable = false;
    cell.blocked = Boolean(cell.obstacleId);
  }
  const sources = [...room.buildings.values()]
    .sort((first, second) => first.claimOrder - second.claimOrder);
  const radii = room.mapDef || LEVEL_CONFIG;
  for (const building of sources) {
    const radius = building.type === 'castle'
      ? radii.initialTerritoryRadius
      : radii.buildingExpansionRadius;
    expandTerritory(room, building.owner, building.row, building.column, radius);
  }
}

function makeRoom(rawMapId) {
  const mapDef = MAPS[rawMapId] || MAPS[DEFAULT_MAP_ID];
  const room = {
    players: new Map(),
    playerState: {
      player1: { gold: GAME_CONFIG.startingGold, upgrades: zeroUpgrades() },
      player2: { gold: GAME_CONFIG.startingGold, upgrades: zeroUpgrades() }
    },
    effects: [],
    mapId: mapDef.id,
    mapDef,
    map: createMap(mapDef),
    buildings: new Map(),
    obstacles: new Map(),
    routes: [],
    units: new Map(),
    coins: new Map(),
    // Cell reservations backing the "grab a cell before it flips" mechanic.
    // Keyed by row * columns + column → owner playerId. A reservation lets the
    // owner build on the cell even after its territory flips to the opponent.
    reservations: new Map(),
    phase: 'waiting',
    winner: null,
    elapsedMs: 0,
    mineElapsedMs: 0,
    coinElapsedMs: 0,
    broadcastElapsedMs: 0,
    nextBuildingId: 1,
    nextRouteId: 1,
    nextUnitId: 1,
    nextCoinId: 1,
    nextClaimOrder: 1,
    rematchVotes: new Set()
  };
  for (const obstacle of mapDef.obstacles) addObstacle(room, obstacle);
  for (const playerId of ['player1', 'player2']) {
    const position = mapDef.castles[playerId];
    addBuilding(room, {
      id: `${playerId}_castle`,
      type: 'castle',
      owner: playerId,
      row: position.row,
      column: position.column,
      width: 1,
      height: 1
    });
  }
  recomputeTerritory(room);
  return room;
}

function buildingCenter(building) {
  return {
    x: (building.column + building.width / 2) / MAP_CONFIG.columns,
    y: (building.row + building.height / 2) / MAP_CONFIG.rows
  };
}

function pointDistance(first, second) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function pointInRect(point, rect) {
  return point.x >= rect.left
    && point.x <= rect.right
    && point.y >= rect.top
    && point.y <= rect.bottom;
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsIntersect(a, b, c, d) {
  const epsilon = 1e-10;
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (
    ((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon))
    && ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))
  ) return true;
  const onSegment = (p, q, r) => Math.abs(orientation(p, q, r)) <= epsilon
    && r.x >= Math.min(p.x, q.x) - epsilon
    && r.x <= Math.max(p.x, q.x) + epsilon
    && r.y >= Math.min(p.y, q.y) - epsilon
    && r.y <= Math.max(p.y, q.y) + epsilon;
  return onSegment(a, b, c)
    || onSegment(a, b, d)
    || onSegment(c, d, a)
    || onSegment(c, d, b);
}

function segmentIntersectsGridObject(a, b, object, inset = 0) {
  const rect = {
    left: object.column / MAP_CONFIG.columns + inset,
    right: (object.column + (object.width || 1)) / MAP_CONFIG.columns - inset,
    top: object.row / MAP_CONFIG.rows + inset,
    bottom: (object.row + (object.height || 1)) / MAP_CONFIG.rows - inset
  };
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const topLeft = { x: rect.left, y: rect.top };
  const topRight = { x: rect.right, y: rect.top };
  const bottomLeft = { x: rect.left, y: rect.bottom };
  const bottomRight = { x: rect.right, y: rect.bottom };
  return segmentsIntersect(a, b, topLeft, topRight)
    || segmentsIntersect(a, b, topRight, bottomRight)
    || segmentsIntersect(a, b, bottomRight, bottomLeft)
    || segmentsIntersect(a, b, bottomLeft, topLeft);
}

function segmentIntersectsBuilding(a, b, building) {
  return segmentIntersectsGridObject(a, b, building);
}

function leaveRoom(socket) {
  if (!socket.roomId) return;
  const roomId = socket.roomId;
  const playerId = socket.playerId;
  const room = rooms.get(roomId);
  if (room) {
    room.players.delete(playerId);
    for (const [index, owner] of [...room.reservations]) {
      if (owner === playerId) room.reservations.delete(index);
    }
    log('disconnect', `room=${roomId} player=${playerId}`);
    if (room.players.size === 0) {
      rooms.delete(roomId);
    } else {
      if (!room.winner) room.phase = 'waiting';
      broadcast(room, { type: 'opponent_left', playerId });
      broadcastState(room);
    }
  }
  socket.roomId = undefined;
  socket.playerId = undefined;
}

// Voluntary mid-match "return to lobby": the player steps back to the lobby
// view but the room and the live match stay alive on the server, and the
// opponent keeps playing. The socket remains a member of the room
// (roomId/playerId intact), so the player can resume the same match later.
function returnToLobby(socket) {
  if (!socket.roomId) return undefined;
  const room = rooms.get(socket.roomId);
  if (!room) return undefined;
  const player = room.players.get(socket.playerId);
  if (player) player.inLobby = true;
  log('return_to_lobby', `room=${socket.roomId} player=${socket.playerId}`);
  for (const [otherId, other] of room.players) {
    if (otherId !== socket.playerId && other.socket) {
      safeSend(other.socket, { type: 'opponent_in_lobby', playerId: socket.playerId });
    }
  }
  return true;
}

// Resume from the lobby back into the live match. The room never left, so this
// just flips the player's view flag and lets the opponent know they're back.
function returnToBoard(socket) {
  if (!socket.roomId) return undefined;
  const room = rooms.get(socket.roomId);
  if (!room) return undefined;
  const player = room.players.get(socket.playerId);
  if (player) player.inLobby = false;
  log('return_to_board', `room=${socket.roomId} player=${socket.playerId}`);
  for (const [otherId, other] of room.players) {
    if (otherId !== socket.playerId && other.socket) {
      safeSend(other.socket, { type: 'opponent_returned', playerId: socket.playerId });
    }
  }
  setImmediate(() => broadcastState(room));
  return true;
}

function createRoom(socket, rawMapId) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = makeRoomId();
  const room = makeRoom(rawMapId);
  room.players.set('player1', { socket });
  rooms.set(roomId, room);
  socket.roomId = roomId;
  socket.playerId = 'player1';
  log('room_created', `room=${roomId} player=player1 map=${room.mapId}`);
  safeSend(socket, {
    type: 'welcome',
    roomId,
    playerId: 'player1',
    mapId: room.mapId,
    mapName: room.mapDef.name,
    maps: Object.values(MAPS).map((map) => ({
      id: map.id,
      name: map.name,
      description: map.description
    }))
  });
  setImmediate(() => sendState(socket, room));
}

function joinRoom(socket, rawRoomId) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = String(rawRoomId || '').trim();
  const room = rooms.get(roomId);
  if (!room) return sendError(socket, 'Room not found. Check the room number.');
  const playerId = ['player1', 'player2'].find((candidate) => !room.players.has(candidate));
  if (!playerId) return sendError(socket, 'Room is full.');
  room.players.set(playerId, { socket });
  if (!room.winner && room.players.size === 2) room.phase = 'playing';
  socket.roomId = roomId;
  socket.playerId = playerId;
  log('room_joined', `room=${roomId} player=${playerId}`);
  safeSend(socket, {
    type: 'welcome',
    roomId,
    playerId,
    mapId: room.mapId,
    mapName: room.mapDef.name
  });
  for (const [otherPlayerId, player] of room.players) {
    if (otherPlayerId !== playerId) {
      safeSend(player.socket, { type: 'opponent_joined', playerId });
    }
  }
  setImmediate(() => broadcastState(room));
}

function rejoinRoom(socket, rawRoomId, preferredPlayerId) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = String(rawRoomId || '').trim();
  const room = rooms.get(roomId);
  if (!room) return sendError(socket, 'Room not found. It may have ended or the server restarted.');
  if (preferredPlayerId && room.players.has(preferredPlayerId)) {
    const stale = room.players.get(preferredPlayerId);
    if (!stale.socket || stale.socket.readyState !== WebSocket.OPEN) {
      room.players.delete(preferredPlayerId);
    }
  }
  const candidates = ['player1', 'player2'].filter((id) => !room.players.has(id));
  if (candidates.length === 0) return sendError(socket, 'Room is full.');
  const playerId = candidates.includes(preferredPlayerId) ? preferredPlayerId : candidates[0];
  room.players.set(playerId, { socket });
  if (!room.winner && room.players.size === 2) room.phase = 'playing';
  socket.roomId = roomId;
  socket.playerId = playerId;
  log('room_rejoined', `room=${roomId} player=${playerId}`);
  safeSend(socket, {
    type: 'welcome',
    roomId,
    playerId,
    mapId: room.mapId,
    mapName: room.mapDef.name
  });
  for (const [otherPlayerId, player] of room.players) {
    if (otherPlayerId !== playerId) {
      safeSend(player.socket, { type: 'opponent_joined', playerId });
    }
  }
  setImmediate(() => broadcastState(room));
}

function resetRoom(room) {
  // Remove every non-castle building; restore or recreate the two castles.
  for (const [id, building] of [...room.buildings]) {
    if (!id.endsWith('_castle')) {
      const cell = cellFor(room.map, building.row, building.column);
      if (cell) {
        cell.buildingId = null;
        cell.buildable = cell.terrain !== 'cliff' && !cell.obstacleId;
      }
      room.buildings.delete(id);
    }
  }
  for (const playerId of ['player1', 'player2']) {
    const castleId = `${playerId}_castle`;
    const position = room.mapDef.castles[playerId];
    let castle = room.buildings.get(castleId);
    if (!castle) {
      castle = addBuilding(room, {
        id: castleId,
        type: 'castle',
        owner: playerId,
        row: position.row,
        column: position.column,
        width: 1,
        height: 1,
        claimOrder: playerId === 'player1' ? 1 : 2
      });
    } else {
      const stats = GAME_CONFIG.buildingStats[castle.type];
      castle.hp = stats.maxHp;
      castle.maxHp = stats.maxHp;
    }
    const cell = cellFor(room.map, castle.row, castle.column);
    if (cell) cell.buildingId = castleId;
  }
  room.units.clear();
  room.coins.clear();
  room.routes = [];
  room.reservations.clear();
  room.effects = [];
  for (const playerId of ['player1', 'player2']) {
    room.playerState[playerId] = { gold: GAME_CONFIG.startingGold, upgrades: zeroUpgrades() };
  }
  room.phase = 'playing';
  room.winner = null;
  room.elapsedMs = 0;
  room.mineElapsedMs = 0;
  room.coinElapsedMs = 0;
  room.broadcastElapsedMs = 0;
  room.nextBuildingId = 1;
  room.nextRouteId = 1;
  room.nextUnitId = 1;
  room.nextCoinId = 1;
  room.rematchVotes = new Set();
  recomputeTerritory(room);
  return room;
}

function requestRematch(socket) {
  const roomId = socket.roomId;
  const playerId = socket.playerId;
  if (!roomId || !playerId) return sendError(socket, 'Create or join a room first.');
  const room = rooms.get(roomId);
  if (!room) return sendError(socket, 'Room not found.');
  if (!room.rematchVotes) room.rematchVotes = new Set();
  room.rematchVotes.add(playerId);
  if (room.players.size >= 2) {
    if (room.rematchVotes.size >= 2) {
      resetRoom(room);
      broadcast(room, { type: 'game_reset' });
      broadcastState(room);
      log('rematch', `room=${roomId} reset (both players)`);
    } else {
      broadcast(room, { type: 'rematch_pending', from: playerId });
    }
  } else {
    // Opponent absent: reset immediately so a fresh board waits for them.
    resetRoom(room);
    safeSend(socket, { type: 'game_reset' });
    broadcastState(room);
    log('rematch', `room=${roomId} reset (solo)`);
  }
}

function requireReadyRoom(socket, action) {
  if (!socket.roomId || !socket.playerId) {
    reject(socket, action, 'Create or join a room first.');
    return undefined;
  }
  const room = rooms.get(socket.roomId);
  if (!room || room.players.size !== 2) {
    reject(socket, action, 'Waiting for the other player.');
    return undefined;
  }
  if (room.winner) {
    reject(socket, action, 'The battle is already finished.');
    return undefined;
  }
  return room;
}

function reserveCell(socket, row, column) {
  const room = requireReadyRoom(socket, 'reserve_cell');
  if (!room) return undefined;
  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    return reject(socket, 'reserve_cell', 'Row and column must be integers.');
  }
  const cell = cellFor(room.map, row, column);
  if (!cell) return reject(socket, 'reserve_cell', 'Cell coordinates are outside the map.');
  const index = row * room.map.columns + column;
  // First click wins. If the cell is already reserved (by anyone) we leave the
  // existing reservation untouched rather than erroring.
  if (room.reservations.has(index)) return undefined;
  if (cell.territory !== socket.playerId) {
    return reject(socket, 'reserve_cell', '只能在自己的领土上预留。');
  }
  if (cell.terrain !== 'grass' || cell.blocked || cell.obstacleId || cell.buildingId) {
    return reject(socket, 'reserve_cell', '该格子无法预留。');
  }
  room.reservations.set(index, socket.playerId);
  broadcastState(room);
  return undefined;
}

function cancelReservation(socket, row, column) {
  const room = requireReadyRoom(socket, 'cancel_reservation');
  if (!room) return undefined;
  if (!Number.isInteger(row) || !Number.isInteger(column)) return undefined;
  const index = row * room.map.columns + column;
  if (room.reservations.get(index) === socket.playerId) {
    room.reservations.delete(index);
    broadcastState(room);
  }
  return undefined;
}

function build(socket, row, column, buildingType) {
  const room = requireReadyRoom(socket, 'build');
  if (!room) return undefined;
  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    return reject(socket, 'build', 'Row and column must be integers.');
  }
  const cell = cellFor(room.map, row, column);
  if (!cell) return reject(socket, 'build', 'Building coordinates are outside the map.');
  const index = row * room.map.columns + column;
  const reservedOwner = room.reservations.get(index);
  const reservedByMe = reservedOwner === socket.playerId;
  const reservedByOther = reservedOwner !== undefined && reservedOwner !== socket.playerId;
  if (reservedByOther) {
    return reject(socket, 'build', '该格子已被对方预留。');
  }
  if (cell.territory !== socket.playerId && !reservedByMe) {
    return reject(socket, 'build', 'You can only build on your own green land.');
  }
  if (cell.terrain !== 'grass') {
    return reject(socket, 'build', 'This terrain cannot be built on.');
  }
  if (cell.blocked || cell.obstacleId) {
    return reject(socket, 'build', 'Clear the tree or rock before building here.');
  }
  if (cell.buildingId) return reject(socket, 'build', 'This land already has a building.');
  if (
    typeof buildingType !== 'string'
    || !Object.hasOwn(GAME_CONFIG.buildingCosts, buildingType)
  ) return reject(socket, 'build', 'Unknown building type.');
  const player = room.playerState[socket.playerId];
  const cost = GAME_CONFIG.buildingCosts[buildingType];
  if (player.gold < cost) return reject(socket, 'build', 'Not enough gold.');
  const building = {
    id: `building_${room.nextBuildingId++}`,
    type: buildingType,
    owner: socket.playerId,
    row,
    column,
    width: 1,
    height: 1
  };
  player.gold -= cost;
  // A successful build consumes any reservation on this cell.
  room.reservations.delete(index);
  const activeBuilding = addBuilding(room, building);
  recomputeTerritory(room);
  log(
    'build',
    `room=${socket.roomId} player=${socket.playerId} cell=${row},${column} type=${buildingType} gold=${player.gold}`
  );
  broadcastState(room);
  return activeBuilding;
}

function clearObstacle(socket, obstacleId) {
  const room = requireReadyRoom(socket, 'clear_obstacle');
  if (!room) return undefined;
  if (typeof obstacleId !== 'string') {
    return reject(socket, 'clear_obstacle', 'Obstacle ID must be a string.');
  }
  const obstacle = room.obstacles.get(obstacleId);
  if (!obstacle) return reject(socket, 'clear_obstacle', 'Obstacle does not exist.');
  const cell = cellFor(room.map, obstacle.row, obstacle.column);
  if (cell.territory !== socket.playerId) {
    return reject(socket, 'clear_obstacle', 'You can only clear obstacles on your own land.');
  }
  const cost = GAME_CONFIG.clearCosts[obstacle.type];
  const player = room.playerState[socket.playerId];
  if (!Number.isFinite(cost)) return reject(socket, 'clear_obstacle', 'Unknown obstacle type.');
  if (player.gold < cost) return reject(socket, 'clear_obstacle', 'Not enough gold.');
  player.gold -= cost;
  room.obstacles.delete(obstacle.id);
  cell.obstacleId = null;
  cell.blocked = false;
  cell.buildable = cell.territory === socket.playerId && !cell.buildingId;
  log(
    'clear',
    `room=${socket.roomId} player=${socket.playerId} obstacle=${obstacle.id} gold=${player.gold}`
  );
  broadcastState(room);
  return obstacle;
}

function applyMineIncome(room, shouldBroadcast = true) {
  if (!room || room.players.size === 0) return 0;
  // Count each player's owned mines so per-player income can be computed.
  const mineCount = { player1: 0, player2: 0 };
  for (const building of room.buildings.values()) {
    if (building.type === 'mine' && mineCount[building.owner] !== undefined) {
      mineCount[building.owner] += 1;
    }
  }
  // Baseline income (保底): a fixed one-mine speed granted to every player,
  // independent of mine upgrades. A player with no mine — or one who bought mine
  // upgrades but owns no mine — still earns this steady, constant stream instead of
  // stalling at zero. The value is the raw GAME_CONFIG.mineIncome (never scaled by
  // the upgrade multiplier), so it is fully decoupled from mine logic. Mine income
  // (mineCount * effectiveMineIncome) is a separate, upgrade-aware stream layered on
  // top via Math.max.
  const baseline = GAME_CONFIG.mineIncome;
  let paidPlayers = 0;
  for (const owner of ['player1', 'player2']) {
    const mineIncome = mineCount[owner] * effectiveMineIncome(room, owner);
    const earned = Math.max(baseline, mineIncome);
    if (earned > 0) {
      room.playerState[owner].gold += Math.round(earned);
      paidPlayers += 1;
    }
  }
  if (paidPlayers > 0 && shouldBroadcast) broadcastState(room);
  return paidPlayers;
}

function cellCenterPoint(row, column) {
  return {
    x: (column + 0.5) / MAP_CONFIG.columns,
    y: (row + 0.5) / MAP_CONFIG.rows
  };
}

// Pick a random walkable tile that is free of cliffs, buildings, obstacles and
// existing coins — a fair, unobstructed spot for a neutral pickup.
function randomWalkableCell(room) {
  const occupiedCells = new Set();
  for (const coin of room.coins.values()) {
    occupiedCells.add(`${coin.row},${coin.column}`);
  }
  const candidates = [];
  for (const cell of room.map.cells) {
    if (
      cell.terrain === 'grass'
      && !cell.blocked
      && !cell.buildingId
      && !cell.obstacleId
      && !occupiedCells.has(`${cell.row},${cell.column}`)
    ) {
      candidates.push(cell);
    }
  }
  if (candidates.length === 0) return undefined;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function spawnCoin(room) {
  if (!room || room.coins.size >= PICKUP_CONFIG.maxActive) return undefined;
  const cell = randomWalkableCell(room);
  if (!cell) return undefined;
  const center = cellCenterPoint(cell.row, cell.column);
  const coin = {
    id: `coin_${room.nextCoinId++}`,
    row: cell.row,
    column: cell.column,
    x: center.x,
    y: center.y,
    value: PICKUP_CONFIG.value,
    lifetimeMs: PICKUP_CONFIG.lifetimeMs,
    remainingMs: PICKUP_CONFIG.lifetimeMs
  };
  room.coins.set(coin.id, coin);
  return coin;
}

// Neutral coins are contested: whoever clicks first claims the gold.
function collectCoin(socket, coinId) {
  const room = requireReadyRoom(socket, 'collect_coin');
  if (!room) return undefined;
  if (typeof coinId !== 'string') {
    return reject(socket, 'collect_coin', 'Coin ID must be a string.');
  }
  const coin = room.coins.get(coinId);
  if (!coin) {
    return reject(socket, 'collect_coin', '金币已消失或被对手抢先回收。');
  }
  room.coins.delete(coinId);
  room.playerState[socket.playerId].gold += coin.value;
  pushEffect(room, {
    type: 'coin_collect',
    owner: socket.playerId,
    x: coin.x,
    y: coin.y,
    value: coin.value
  });
  log(
    'coin_collect',
    `room=${socket.roomId} player=${socket.playerId} coin=${coinId} value=${coin.value} gold=${room.playerState[socket.playerId].gold}`
  );
  broadcastState(room);
  return coin.value;
}

function isPlainPoint(point) {
  return point !== null
    && typeof point === 'object'
    && !Array.isArray(point)
    && Number.isFinite(point.x)
    && Number.isFinite(point.y);
}

function routeCellAtPoint(point) {
  return {
    row: Math.min(MAP_CONFIG.rows - 1, Math.max(0, Math.floor(point.y * MAP_CONFIG.rows))),
    column: Math.min(MAP_CONFIG.columns - 1, Math.max(0, Math.floor(point.x * MAP_CONFIG.columns)))
  };
}

function routeCellCenter(cell) {
  return {
    x: (cell.column + 0.5) / MAP_CONFIG.columns,
    y: (cell.row + 0.5) / MAP_CONFIG.rows
  };
}

function appendCompressedRoutePoint(points, point) {
  const previous = points.at(-1);
  if (previous && pointDistance(previous, point) < 1e-10) return;
  if (points.length >= 2) {
    const beforePrevious = points.at(-2);
    const sameVertical = Math.abs(beforePrevious.x - previous.x) < 1e-10
      && Math.abs(previous.x - point.x) < 1e-10;
    const sameHorizontal = Math.abs(beforePrevious.y - previous.y) < 1e-10
      && Math.abs(previous.y - point.y) < 1e-10;
    const continuesForward = sameVertical
      ? (previous.y - beforePrevious.y) * (point.y - previous.y) >= 0
      : sameHorizontal
        ? (previous.x - beforePrevious.x) * (point.x - previous.x) >= 0
        : false;
    if (continuesForward) {
      points[points.length - 1] = point;
      return;
    }
  }
  points.push(point);
}

function orthogonalizeRouteSamples(points) {
  const routePoints = [];
  let currentCell = routeCellAtPoint(points[0]);
  appendCompressedRoutePoint(routePoints, routeCellCenter(currentCell));
  for (const sample of points.slice(1)) {
    const targetCell = routeCellAtPoint(sample);
    if (targetCell.row === currentCell.row && targetCell.column === currentCell.column) continue;
    if (targetCell.row !== currentCell.row && targetCell.column !== currentCell.column) {
      const columnDistance = Math.abs(targetCell.column - currentCell.column);
      const rowDistance = Math.abs(targetCell.row - currentCell.row);
      const corner = columnDistance >= rowDistance
        ? { row: currentCell.row, column: targetCell.column }
        : { row: targetCell.row, column: currentCell.column };
      appendCompressedRoutePoint(routePoints, routeCellCenter(corner));
    }
    appendCompressedRoutePoint(routePoints, routeCellCenter(targetCell));
    currentCell = targetCell;
  }
  return pruneRouteBacktracking(routePoints);
}

// Check intersection for axis-aligned (horizontal/vertical) line segments.
// Returns the intersection point, or null if they only meet at an endpoint.
function orthogonalSegmentIntersection(a, b, c, d) {
  const abHorizontal = a.y === b.y;
  const cdHorizontal = c.y === d.y;

  if (abHorizontal && cdHorizontal) {
    if (a.y !== c.y) return null;
    const minAb = Math.min(a.x, b.x);
    const maxAb = Math.max(a.x, b.x);
    const minCd = Math.min(c.x, d.x);
    const maxCd = Math.max(c.x, d.x);
    if (maxAb < minCd || maxCd < minAb) return null;
    // Collinear overlap: only count it as backtracking if the new segment
    // points opposite to the older one. Same-direction overlap is a shared
    // corridor and should be kept.
    const v1x = b.x - a.x;
    const v2x = d.x - c.x;
    if (v1x * v2x >= 0) return null;
    // Backtracking: drop to the point of the new segment that is closest to
    // the start of the older segment (a).
    return a.x <= b.x ? { x: minCd, y: a.y } : { x: maxCd, y: a.y };
  }

  if (!abHorizontal && !cdHorizontal) {
    if (a.x !== c.x) return null;
    const minAb = Math.min(a.y, b.y);
    const maxAb = Math.max(a.y, b.y);
    const minCd = Math.min(c.y, d.y);
    const maxCd = Math.max(c.y, d.y);
    if (maxAb < minCd || maxCd < minAb) return null;
    const v1y = b.y - a.y;
    const v2y = d.y - c.y;
    if (v1y * v2y >= 0) return null;
    return a.y <= b.y ? { y: minCd, x: a.x } : { y: maxCd, x: a.x };
  }

  const h = abHorizontal ? { a, b } : { a: c, b: d };
  const v = abHorizontal ? { a: c, b: d } : { a, b };
  const x = v.a.x;
  const y = h.a.y;
  if (
    x >= Math.min(h.a.x, h.b.x) - 1e-9
    && x <= Math.max(h.a.x, h.b.x) + 1e-9
    && y >= Math.min(v.a.y, v.b.y) - 1e-9
    && y <= Math.max(v.a.y, v.b.y) + 1e-9
  ) return { x, y };
  return null;
}

// Remove backtracking loops from an orthogonal polyline. Whenever a new segment
// intersects a previous non-adjacent segment, the route is truncated at the
// intersection so the resulting path never crosses or doubles back on itself.
function pruneRouteBacktracking(points) {
  if (points.length < 3) return points;
  const stack = [points[0]];
  for (let i = 1; i < points.length; i += 1) {
    const next = points[i];
    const current = stack[stack.length - 1];
    if (current.x === next.x && current.y === next.y) continue;

    let cutIndex = -1;
    let intersection = null;
    for (let j = 0; j < stack.length - 2; j += 1) {
      const hit = orthogonalSegmentIntersection(
        stack[j], stack[j + 1], current, next
      );
      if (hit) {
        cutIndex = j;
        intersection = hit;
        break;
      }
    }

    if (cutIndex !== -1) {
      stack.length = cutIndex + 1;
      const top = stack[stack.length - 1];
      if (intersection.x !== top.x || intersection.y !== top.y) {
        stack.push(intersection);
      }
      // Once the route loops back, the remainder is unwanted; stop here.
      break;
    }

    stack.push(next);
  }
  return stack;
}

function polylineLength(points) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += pointDistance(points[index - 1], points[index]);
  }
  return total;
}

function prepareRoute(room, playerId, barracksId, targetBuildingIds, rawPoints) {
  if (typeof barracksId !== 'string') return { reason: 'Barracks ID must be a string.' };
  const barracks = room.buildings.get(barracksId);
  if (!barracks || barracks.type !== 'barracks') {
    return { reason: 'Routes must start from a barracks.' };
  }
  if (barracks.owner !== playerId) {
    return { reason: 'You can only control your own barracks.' };
  }
  if (
    !Array.isArray(targetBuildingIds)
    || targetBuildingIds.length < 1
    || targetBuildingIds.length > ROUTE_CONFIG.maxTargets
  ) return { reason: `A route must target 1 to ${ROUTE_CONFIG.maxTargets} enemy buildings.` };
  if (!targetBuildingIds.every((id) => typeof id === 'string')) {
    return { reason: 'Every target building ID must be a string.' };
  }
  if (new Set(targetBuildingIds).size !== targetBuildingIds.length) {
    return { reason: 'A route cannot target the same building twice.' };
  }
  const targets = [];
  for (const targetId of targetBuildingIds) {
    const target = room.buildings.get(targetId);
    if (!target) return { reason: 'Target building does not exist.' };
    if (target.owner === playerId) {
      return { reason: 'Every route target must be an enemy building.' };
    }
    targets.push(target);
  }
  if (!Array.isArray(rawPoints)) return { reason: 'Route points must be an array.' };
  if (
    rawPoints.length < ROUTE_CONFIG.minRawPoints
    || rawPoints.length > ROUTE_CONFIG.maxRawPoints
  ) return { reason: `Route must contain ${ROUTE_CONFIG.minRawPoints} to ${ROUTE_CONFIG.maxRawPoints} sampled points.` };
  if (!rawPoints.every(isPlainPoint)) {
    return { reason: 'Every route point must contain finite numeric x and y coordinates.' };
  }
  if (!rawPoints.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) {
    return { reason: 'Route coordinates must stay between 0 and 1.' };
  }

  const cleanedPoints = [];
  for (const point of rawPoints) {
    const cleanPoint = { x: point.x, y: point.y };
    if (
      cleanedPoints.length === 0
      || pointDistance(cleanedPoints.at(-1), cleanPoint) >= ROUTE_CONFIG.minPointDistance
    ) cleanedPoints.push(cleanPoint);
  }
  if (cleanedPoints.length < ROUTE_CONFIG.minRawPoints) {
    return { reason: 'Route has too few distinct points.' };
  }

  const start = buildingCenter(barracks);
  if (pointDistance(cleanedPoints[0], start) > ROUTE_CONFIG.endpointTolerance) {
    return { reason: 'Route must start at the barracks.' };
  }
  const finalTargetCenter = buildingCenter(targets.at(-1));
  if (pointDistance(cleanedPoints.at(-1), finalTargetCenter) > ROUTE_CONFIG.endpointTolerance) {
    return { reason: 'Route must end on its final target.' };
  }
  cleanedPoints[0] = start;
  cleanedPoints[cleanedPoints.length - 1] = finalTargetCenter;

  const routePoints = [start];
  const targetPointIndices = [];
  let previousRawIndex = 0;
  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const center = buildingCenter(targets[targetIndex]);
    let checkpointIndex = targetIndex === targets.length - 1
      ? cleanedPoints.length - 1
      : -1;
    if (checkpointIndex === -1) {
      for (let index = previousRawIndex + 1; index < cleanedPoints.length - 1; index += 1) {
        if (pointDistance(cleanedPoints[index], center) <= ROUTE_CONFIG.endpointTolerance) {
          checkpointIndex = index;
          break;
        }
      }
    }
    if (checkpointIndex === -1) {
      return { reason: 'Route must touch every target in the declared order.' };
    }
    cleanedPoints[checkpointIndex] = center;
    const orthogonalSegment = orthogonalizeRouteSamples(
      cleanedPoints.slice(previousRawIndex, checkpointIndex + 1)
    );
    routePoints.push(...orthogonalSegment.slice(1));
    targetPointIndices.push(routePoints.length - 1);
    previousRawIndex = checkpointIndex;
  }
  if (routePoints.length > ROUTE_CONFIG.maxWaypoints) {
    return { reason: `Route may contain at most ${ROUTE_CONFIG.maxWaypoints} straight-line waypoints.` };
  }
  const length = polylineLength(routePoints);
  if (length < ROUTE_CONFIG.minLength) return { reason: 'Route is too short.' };
  if (length > ROUTE_CONFIG.maxLength) return { reason: 'Route is too long.' };

  for (let index = 1; index < routePoints.length; index += 1) {
    const first = routePoints[index - 1];
    const second = routePoints[index];
    for (const building of room.buildings.values()) {
      // The origin barracks is where the route begins. Enemy buildings may be
      // crossed freely — a route can pass through any number of them, and each
      // marching soldier self-destructs on the FIRST enemy building it reaches;
      // once that building falls, later soldiers continue on to the next one.
      // Only the player's OWN structures block a route, matching the original
      // rule "路线不能穿过障碍物或己方设施".
      if (building.id === barracks.id) continue;
      if (
        building.owner === playerId
        && segmentIntersectsGridObject(first, second, building)
      ) return { reason: 'Route cannot pass through your own building.' };
    }
    for (const obstacle of room.obstacles.values()) {
      if (segmentIntersectsGridObject(first, second, obstacle)) {
        return { reason: 'Route cannot pass through trees or rocks.' };
      }
    }
    for (const cell of room.map.cells) {
      if (
        cell.terrain === 'cliff'
        && segmentIntersectsGridObject(first, second, cell, 0.001)
      ) return { reason: 'Route cannot leave the playable land.' };
    }
  }
  return { points: routePoints, targetPointIndices, targets };
}

function validateRoute(room, playerId, barracksId, targetBuildingIds, points) {
  return prepareRoute(room, playerId, barracksId, targetBuildingIds, points).reason || null;
}

function createRoute(socket, barracksId, targetBuildingIds, points) {
  const room = requireReadyRoom(socket, 'create_route');
  if (!room) return undefined;
  const result = prepareRoute(room, socket.playerId, barracksId, targetBuildingIds, points);
  if (result.reason) return reject(socket, 'create_route', result.reason);
  const existing = room.routes.find((route) => route.barracksId === barracksId);
  const route = {
    id: existing ? existing.id : `route_${room.nextRouteId++}`,
    owner: socket.playerId,
    barracksId,
    targetBuildingIds: [...targetBuildingIds],
    targetPointIndices: result.targetPointIndices,
    points: result.points
  };
  room.routes = room.routes.filter((item) => item.barracksId !== barracksId);
  room.routes.push(route);
  const barracks = room.buildings.get(barracksId);
  barracks.spawnElapsedMs = 0;
  log(
    'route',
    `room=${socket.roomId} player=${socket.playerId} barracks=${barracksId} targets=${targetBuildingIds.join(',')} points=${route.points.length}`
  );
  broadcastState(room);
  return route;
}

function cancelRoute(socket, barracksId) {
  const room = requireReadyRoom(socket, 'cancel_route');
  if (!room) return false;
  if (typeof barracksId !== 'string') {
    reject(socket, 'cancel_route', 'Barracks ID must be a string.');
    return false;
  }
  const barracks = room.buildings.get(barracksId);
  if (!barracks || barracks.type !== 'barracks' || barracks.owner !== socket.playerId) {
    reject(socket, 'cancel_route', 'You can only cancel a route from your own barracks.');
    return false;
  }
  const before = room.routes.length;
  const existingRoute = room.routes.find((route) => route.barracksId === barracksId);
  room.routes = room.routes.filter((route) => route.barracksId !== barracksId);
  if (room.routes.length === before) {
    reject(socket, 'cancel_route', 'This barracks has no route to cancel.');
    return false;
  }
  // Remove all units still on the field that were spawned by this route.
  for (const [unitId, unit] of room.units) {
    if (unit.routeId === (existingRoute?.id)) {
      room.units.delete(unitId);
    }
  }
  log('route_cancel', `room=${socket.roomId} player=${socket.playerId} barracks=${barracksId}`);
  broadcastState(room);
  return true;
}

function upgrade(socket, trackId) {
  const room = requireReadyRoom(socket, 'upgrade');
  if (!room) return undefined;
  if (typeof trackId !== 'string' || !Object.hasOwn(UPGRADE_CONFIG.tracks, trackId)) {
    return reject(socket, 'upgrade', 'Unknown upgrade track.');
  }
  const player = room.playerState[socket.playerId];
  const current = player.upgrades[trackId] || 0;
  const track = UPGRADE_CONFIG.tracks[trackId];
  if (current >= track.maxLevel) {
    return reject(socket, 'upgrade', '该升级已满级。');
  }
  const cost = upgradeCost(trackId, current);
  if (player.gold < cost) {
    return reject(socket, 'upgrade', '金币不足，无法升级。');
  }
  player.gold -= cost;
  player.upgrades[trackId] = current + 1;
  if (trackId === 'castleArmor') {
    const castle = [...room.buildings.values()].find(
      (building) => building.owner === socket.playerId && building.type === 'castle'
    );
    if (castle) {
      const delta = GAME_CONFIG.buildingStats.castle.maxHp * track.mul;
      castle.maxHp += delta;
      castle.hp += delta;
    }
  }
  log(
    'upgrade',
    `room=${socket.roomId} player=${socket.playerId} track=${trackId} level=${current + 1} gold=${player.gold}`
  );
  broadcastState(room);
  return player.upgrades[trackId];
}

function spawnUnit(room, route) {
  const barracks = room.buildings.get(route.barracksId);
  if (!barracks || barracks.type !== 'barracks' || route.targetBuildingIds.length === 0) {
    return undefined;
  }
  const start = buildingCenter(barracks);
  const maxHp = effectiveUnitMaxHp(room, route.owner);
  const unit = {
    id: `unit_${room.nextUnitId++}`,
    owner: route.owner,
    barracksId: barracks.id,
    routeId: route.id,
    targetBuildingIds: [...route.targetBuildingIds],
    targetPointIndices: [...route.targetPointIndices],
    pathPoints: route.points.map((point) => ({ ...point })),
    currentPointIndex: 1,
    currentTargetIndex: 0,
    x: start.x,
    y: start.y,
    facing: route.owner === 'player1' ? 'right' : 'left',
    hp: maxHp,
    maxHp,
    speedMul: effectiveUnitSpeedMul(room, route.owner),
    explosionDamage: effectiveUnitExplosionDamage(room, route.owner),
    attackCooldownMs: 0
  };
  room.units.set(unit.id, unit);
  return unit;
}

function advanceUnit(unit, finalPointIndex, travel) {
  const visited = [{ x: unit.x, y: unit.y }];
  let remainingTravel = travel;
  while (unit.currentPointIndex <= finalPointIndex && remainingTravel > 0) {
    const destination = unit.pathPoints[unit.currentPointIndex];
    const distance = pointDistance(unit, destination);
    const horizontalDelta = destination.x - unit.x;
    if (Math.abs(horizontalDelta) > 1e-10) {
      unit.facing = horizontalDelta > 0 ? 'right' : 'left';
    }
    if (distance <= remainingTravel) {
      unit.x = destination.x;
      unit.y = destination.y;
      unit.currentPointIndex += 1;
      remainingTravel -= distance;
    } else {
      unit.x += (destination.x - unit.x) / distance * remainingTravel;
      unit.y += (destination.y - unit.y) / distance * remainingTravel;
      remainingTravel = 0;
    }
    visited.push({ x: unit.x, y: unit.y });
  }
  return visited;
}

function destroyBuilding(room, buildingId, attackerOwner) {
  const building = room.buildings.get(buildingId);
  if (!building) return undefined;
  const destroyedCenter = buildingCenter(building);
  room.buildings.delete(buildingId);
  pushEffect(room, {
    type: building.type === 'castle' ? 'castle_destroyed' : 'building_destroyed',
    owner: building.owner,
    x: destroyedCenter.x,
    y: destroyedCenter.y
  });
  const cell = cellFor(room.map, building.row, building.column);
  if (cell?.buildingId === buildingId) cell.buildingId = null;
  // A destroyed building frees any reservation held on its cell.
  room.reservations.delete(building.row * room.map.columns + building.column);

  // A route is only fully cancelled when its barracks or its FINAL target
  // is destroyed. If an INTERMEDIATE target is gone, just prune that
  // target from the route: the route stays alive and its soldiers keep
  // marching toward the remaining (final) target.
  const removedRouteIds = new Set();
  for (const route of room.routes) {
    if (route.barracksId === buildingId) {
      removedRouteIds.add(route.id);
      continue;
    }
    const targetIndex = route.targetBuildingIds.indexOf(buildingId);
    if (targetIndex === -1) continue;
    if (targetIndex === route.targetBuildingIds.length - 1) {
      // Final target destroyed -> the whole route is dead.
      removedRouteIds.add(route.id);
    } else {
      // Intermediate target: prune it, keep the route alive.
      route.targetBuildingIds.splice(targetIndex, 1);
      route.targetPointIndices.splice(targetIndex, 1);
    }
  }
  room.routes = room.routes.filter((route) => !removedRouteIds.has(route.id));
  // Units still marching on a cancelled route must disappear.
  for (const [unitId, unit] of room.units) {
    if (removedRouteIds.has(unit.routeId)) room.units.delete(unitId);
  }
  recomputeTerritory(room);
  if (building.type === 'castle') {
    room.winner = attackerOwner;
    room.phase = 'finished';
  }
  return building;
}

// Player-initiated demolition of their OWN non-castle building.
// Deliberately does NOT refund the build cost (matches the original game).
function demolishBuilding(socket, buildingId) {
  const room = requireReadyRoom(socket, 'demolish_building');
  if (!room) return undefined;
  if (typeof buildingId !== 'string') {
    return reject(socket, 'demolish_building', 'Building ID must be a string.');
  }
  const building = room.buildings.get(buildingId);
  if (!building) return reject(socket, 'demolish_building', '该建筑不存在。');
  if (building.owner !== socket.playerId) {
    return reject(socket, 'demolish_building', '只能拆除自己的建筑。');
  }
  if (building.type === 'castle') {
    return reject(socket, 'demolish_building', '主城堡不可拆除。');
  }
  destroyBuilding(room, buildingId, socket.playerId);
  // No gold refund by design — matches the original.
  broadcastState(room);
  log('demolish', `room=${room.id} player=${socket.playerId} building=${buildingId}`);
  return true;
}

function addDamage(damageMap, id, amount) {
  damageMap.set(id, (damageMap.get(id) || 0) + amount);
}

function addBuildingDamage(damageMap, id, amount, owner) {
  const existing = damageMap.get(id);
  damageMap.set(id, { amount: (existing?.amount || 0) + amount, owner });
}

function nearestEnemyUnit(room, source, maxDistance) {
  let nearest;
  let nearestDistance = maxDistance;
  for (const candidate of room.units.values()) {
    if (candidate.owner === source.owner || candidate.id === source.id) continue;
    const distance = pointDistance(source, candidate);
    if (distance <= nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function simulationStep(room, deltaMs = COMBAT_CONFIG.tickMs) {
  if (
    !room
    || room.phase !== 'playing'
    || room.players.size !== 2
    || room.winner
    || !Number.isFinite(deltaMs)
    || deltaMs <= 0
  ) return false;

  let changed = false;
  room.elapsedMs += deltaMs;
  room.mineElapsedMs += deltaMs;
  while (room.mineElapsedMs >= GAME_CONFIG.mineIncomeIntervalMs) {
    room.mineElapsedMs -= GAME_CONFIG.mineIncomeIntervalMs;
    if (applyMineIncome(room, false) > 0) changed = true;
  }

  // Neutral coin pickups: spawn on a timer (capped by maxActive) and expire.
  room.coinElapsedMs += deltaMs;
  while (room.coinElapsedMs >= PICKUP_CONFIG.spawnIntervalMs) {
    room.coinElapsedMs -= PICKUP_CONFIG.spawnIntervalMs;
    if (spawnCoin(room)) changed = true;
  }
  for (const [coinId, coin] of room.coins) {
    coin.remainingMs -= deltaMs;
    if (coin.remainingMs <= 0) {
      room.coins.delete(coinId);
      changed = true;
    }
  }

  for (const route of room.routes) {
    const barracks = room.buildings.get(route.barracksId);
    if (!barracks || isConstructing(barracks)) continue;
    const spawnInterval = effectiveSpawnInterval(room, barracks.owner);
    barracks.spawnElapsedMs += deltaMs;
    while (barracks.spawnElapsedMs >= spawnInterval) {
      barracks.spawnElapsedMs -= spawnInterval;
      if (spawnUnit(room, route)) changed = true;
    }
  }

  const unitDamage = new Map();
  const buildingDamage = new Map();
  for (const tower of room.buildings.values()) {
    if (tower.type !== 'tower' || isConstructing(tower)) continue;
    tower.attackCooldownMs = Math.max(0, tower.attackCooldownMs - deltaMs);
    const center = buildingCenter(tower);
    const range = effectiveTowerRange(room, tower.owner);
    const target = nearestEnemyUnit(room, { ...center, owner: tower.owner }, range);
    if (target && tower.attackCooldownMs <= 0) {
      addDamage(unitDamage, target.id, effectiveTowerDamage(room, tower.owner));
      tower.attackCooldownMs = COMBAT_CONFIG.towerAttackIntervalMs;
      pushEffect(room, {
        type: 'tower_fire',
        owner: tower.owner,
        from: center,
        to: { x: target.x, y: target.y }
      });
      changed = true;
    }
  }

  const exhaustedUnits = [];
  const explodingUnits = [];
  for (const unit of room.units.values()) {
    unit.attackCooldownMs = Math.max(0, unit.attackCooldownMs - deltaMs);

    if (unit.currentTargetIndex >= unit.targetBuildingIds.length) {
      exhaustedUnits.push(unit.id);
      continue;
    }

    // A self-destruct soldier explodes on the FIRST enemy building its march
    // crosses — whether that is a declared target or a structure the enemy
    // dropped onto the path after the route was drawn.
    const enemyBuildings = [...room.buildings.values()].filter((b) => b.owner !== unit.owner);

    const targetPointIndex = unit.targetPointIndices?.[unit.currentTargetIndex] ?? Number.MAX_SAFE_INTEGER;
    if (unit.currentPointIndex <= targetPointIndex) {
      const visited = advanceUnit(
        unit,
        targetPointIndex,
        unit.speedMul * COMBAT_CONFIG.unitSpeedPerSecond * deltaMs / 1000
      );
      changed = true;
      for (let index = 1; index < visited.length; index += 1) {
        const hit = enemyBuildings.find((building) => (
          segmentIntersectsGridObject(visited[index - 1], visited[index], building)
        ));
        if (hit) {
          addBuildingDamage(buildingDamage, hit.id, unit.explosionDamage ?? COMBAT_CONFIG.unitExplosionDamage, unit.owner);
          explodingUnits.push(unit.id);
          break;
        }
      }
      continue;
    }

    // Reached the current target's waypoint but the building is gone or turned
    // friendly — skip ahead to the next target instead of exploding.
    const target = room.buildings.get(unit.targetBuildingIds[unit.currentTargetIndex]);
    if (!target || target.owner === unit.owner) {
      unit.currentTargetIndex += 1;
      changed = true;
      continue;
    }
    // Only self-destruct once the march actually brought the unit into range of
    // the target building (a teleported/far unit must not blow up early).
    if (pointDistance(unit, buildingCenter(target)) <= COMBAT_CONFIG.unitAttackRange) {
      addBuildingDamage(buildingDamage, target.id, unit.explosionDamage ?? COMBAT_CONFIG.unitExplosionDamage, unit.owner);
      explodingUnits.push(unit.id);
      changed = true;
    }
  }

  for (const unitId of exhaustedUnits) room.units.delete(unitId);
  for (const unitId of explodingUnits) room.units.delete(unitId);
  for (const [unitId, damage] of unitDamage) {
    const unit = room.units.get(unitId);
    if (!unit) continue;
    unit.hp = Math.max(0, unit.hp - damage);
    if (unit.hp === 0) room.units.delete(unitId);
  }
  const destroyedCastles = [];
  for (const [buildingId, hit] of buildingDamage) {
    const building = room.buildings.get(buildingId);
    if (!building) continue;
    building.hp = Math.max(0, building.hp - hit.amount);
    if (building.hp === 0) {
      if (building.type === 'castle') destroyedCastles.push(building.id);
      destroyBuilding(room, buildingId, hit.owner);
    }
  }
  if (destroyedCastles.length > 1) {
    room.winner = 'draw';
    room.phase = 'finished';
  }

  room.broadcastElapsedMs += deltaMs;
  if (changed && room.broadcastElapsedMs >= COMBAT_CONFIG.broadcastIntervalMs) {
    room.broadcastElapsedMs = 0;
    broadcastState(room);
  }
  return changed;
}

function forwardPointer(socket, x, y) {
  if (!socket.roomId || !socket.playerId) {
    return sendError(socket, 'Create or join a room first.');
  }
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return sendError(socket, 'Pointer coordinates must be finite values from 0 to 1.');
  }
  const room = rooms.get(socket.roomId);
  if (!room || room.players.size !== 2) return sendError(socket, 'Waiting for the other player.');
  const opponentId = socket.playerId === 'player1' ? 'player2' : 'player1';
  const opponent = room.players.get(opponentId);
  if (opponent) {
    safeSend(opponent.socket, { type: 'opponent_pointer', playerId: socket.playerId, x, y });
  }
}

function handleMessage(socket, raw) {
  if (raw.length > NETWORK_CONFIG.maxMessageBytes) {
    return sendError(socket, 'Message is too large.');
  }
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return sendError(socket, 'Invalid JSON message.');
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return sendError(socket, 'Message must be a JSON object.');
  }
  if (typeof message.type !== 'string') return sendError(socket, 'Message type is required.');
  if (message.type === 'create_room') return createRoom(socket, message.mapId);
  if (message.type === 'join_room') return joinRoom(socket, message.roomId);
  if (message.type === 'rejoin_room') return rejoinRoom(socket, message.roomId, message.playerId);
  if (message.type === 'return_to_lobby') return returnToLobby(socket);
  if (message.type === 'return_to_board') return returnToBoard(socket);
  if (message.type === 'leave_room') return leaveRoom(socket);
  if (message.type === 'rematch') return requestRematch(socket);
  if (message.type === 'build') {
    return build(socket, message.row, message.column, message.buildingType);
  }
  if (message.type === 'reserve_cell') return reserveCell(socket, message.row, message.column);
  if (message.type === 'cancel_reservation') {
    return cancelReservation(socket, message.row, message.column);
  }
  if (message.type === 'clear_obstacle') {
    return clearObstacle(socket, message.obstacleId);
  }
  if (message.type === 'create_route') {
    return createRoute(
      socket,
      message.barracksId,
      message.targetBuildingIds,
      message.points
    );
  }
  if (message.type === 'cancel_route') return cancelRoute(socket, message.barracksId);
  if (message.type === 'upgrade') return upgrade(socket, message.track);
  if (message.type === 'demolish_building') return demolishBuilding(socket, message.buildingId);
  if (message.type === 'collect_coin') return collectCoin(socket, message.coinId);
  if (message.type === 'pointer_click') return forwardPointer(socket, message.x, message.y);
  return sendError(socket, 'Unsupported message type.');
}

function listLanUrls(port) {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && address.family === 'IPv4' && !address.internal)
    .map((address) => `http://${address.address}:${port}`);
}

function createAppServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  // Lightweight catalog so the lobby map picker stays in sync with the server.
  app.get('/maps', (_request, response) => {
    response.json({
      defaultMapId: DEFAULT_MAP_ID,
      maps: Object.values(MAPS).map((map) => ({
        id: map.id,
        name: map.name,
        description: map.description,
        terrainRows: map.terrainRows,
        obstacles: map.obstacles,
        castles: map.castles
      }))
    });
  });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, maxPayload: NETWORK_CONFIG.maxMessageBytes });
  wss.on('connection', (socket, request) => {
    log('connected', `ip=${request.socket.remoteAddress}`);
    socket.on('message', (raw) => {
      try {
        handleMessage(socket, raw);
      } catch (error) {
        log('message_error', `reason=${JSON.stringify(error.message)}`);
        sendError(socket, 'The server rejected an invalid operation.');
      }
    });
    socket.on('close', () => leaveRoom(socket));
  });
  return { server, wss };
}

if (require.main === module) {
  const { server } = createAppServer();
  setInterval(() => {
    for (const room of rooms.values()) simulationStep(room, COMBAT_CONFIG.tickMs);
  }, COMBAT_CONFIG.tickMs);
  server.listen(PORT, HOST, () => {
    console.log(`Server running: http://localhost:${PORT}`);
    const urls = listLanUrls(PORT);
    console.log(
      urls.length ? `LAN address(es):\n${urls.join('\n')}` : 'No LAN IPv4 address found.'
    );
  });
}

module.exports = {
  createAppServer,
  rooms,
  HOST,
  GAME_CONFIG,
  MAP_CONFIG,
  MAPS,
  DEFAULT_MAP_ID,
  LEVEL_CONFIG,
  ROUTE_CONFIG,
  COMBAT_CONFIG,
  UPGRADE_CONFIG,
  zeroUpgrades,
  PICKUP_CONFIG,
  NETWORK_CONFIG,
  upgradeCost,
  effectiveMineIncome,
  effectiveTowerDamage,
  effectiveTowerRange,
  effectiveSpawnInterval,
  effectiveUnitMaxHp,
  effectiveUnitSpeedMul,
  effectiveUnitExplosionDamage,
  createMap,
  cellFor,
  makeRoom,
  publicState,
  broadcastState,
  expandTerritory,
  recomputeTerritory,
  buildingCenter,
  segmentIntersectsGridObject,
  segmentIntersectsBuilding,
  build,
  reserveCell,
  cancelReservation,
  clearObstacle,
  applyMineIncome,
  spawnCoin,
  collectCoin,
  prepareRoute,
  validateRoute,
  createRoute,
  cancelRoute,
  upgrade,
  spawnUnit,
  destroyBuilding,
  demolishBuilding,
  simulationStep,
  leaveRoom,
  returnToLobby,
  returnToBoard,
  joinRoom,
  createRoom,
  rejoinRoom,
  resetRoom,
  requestRematch,
  handleMessage
};
