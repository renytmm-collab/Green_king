const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const {
  GAME_CONFIG,
  MAP_CONFIG,
  LEVEL_CONFIG,
  ROUTE_CONFIG,
  COMBAT_CONFIG,
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

function publicState(room) {
  return {
    type: 'game_state',
    ready: room.players.size === 2,
    phase: room.phase,
    winner: room.winner,
    rules: {
      buildingCosts: GAME_CONFIG.buildingCosts,
      clearCosts: GAME_CONFIG.clearCosts,
      maxRouteTargets: ROUTE_CONFIG.maxTargets,
      maxRouteSamples: ROUTE_CONFIG.maxRawPoints,
      combat: COMBAT_CONFIG
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
      maxHp: building.maxHp
    })),
    obstacles: [...room.obstacles.values()],
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
    }))
  };
}

function sendState(socket, room) {
  safeSend(socket, publicState(room));
}

function broadcastState(room) {
  broadcast(room, publicState(room));
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

function createMap() {
  if (
    LEVEL_CONFIG.terrainRows.length !== MAP_CONFIG.rows
    || LEVEL_CONFIG.terrainRows.some((row) => row.length !== MAP_CONFIG.columns)
  ) throw new Error('Level terrain dimensions do not match MAP_CONFIG.');
  const cells = [];
  for (let row = 0; row < MAP_CONFIG.rows; row += 1) {
    for (let column = 0; column < MAP_CONFIG.columns; column += 1) {
      const symbol = LEVEL_CONFIG.terrainRows[row][column];
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
    attackCooldownMs: building.attackCooldownMs ?? 0
  };
  room.buildings.set(activeBuilding.id, activeBuilding);
  cell.buildingId = activeBuilding.id;
  cell.buildable = false;
  return activeBuilding;
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
  for (const building of sources) {
    const radius = building.type === 'castle'
      ? LEVEL_CONFIG.initialTerritoryRadius
      : LEVEL_CONFIG.buildingExpansionRadius;
    expandTerritory(room, building.owner, building.row, building.column, radius);
  }
}

function makeRoom() {
  const room = {
    players: new Map(),
    playerState: {
      player1: { gold: GAME_CONFIG.startingGold },
      player2: { gold: GAME_CONFIG.startingGold }
    },
    map: createMap(),
    buildings: new Map(),
    obstacles: new Map(),
    routes: [],
    units: new Map(),
    phase: 'waiting',
    winner: null,
    elapsedMs: 0,
    mineElapsedMs: 0,
    broadcastElapsedMs: 0,
    nextBuildingId: 1,
    nextRouteId: 1,
    nextUnitId: 1,
    nextClaimOrder: 1
  };
  for (const obstacle of LEVEL_CONFIG.obstacles) addObstacle(room, obstacle);
  for (const playerId of ['player1', 'player2']) {
    const position = LEVEL_CONFIG.castles[playerId];
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

function createRoom(socket) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = makeRoomId();
  const room = makeRoom();
  room.players.set('player1', { socket });
  rooms.set(roomId, room);
  socket.roomId = roomId;
  socket.playerId = 'player1';
  log('room_created', `room=${roomId} player=player1`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player1' });
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
  safeSend(socket, { type: 'welcome', roomId, playerId });
  for (const [otherPlayerId, player] of room.players) {
    if (otherPlayerId !== playerId) {
      safeSend(player.socket, { type: 'opponent_joined', playerId });
    }
  }
  setImmediate(() => broadcastState(room));
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

function build(socket, row, column, buildingType) {
  const room = requireReadyRoom(socket, 'build');
  if (!room) return undefined;
  if (!Number.isInteger(row) || !Number.isInteger(column)) {
    return reject(socket, 'build', 'Row and column must be integers.');
  }
  const cell = cellFor(room.map, row, column);
  if (!cell) return reject(socket, 'build', 'Building coordinates are outside the map.');
  if (cell.territory !== socket.playerId) {
    return reject(socket, 'build', 'You can only build on your own green land.');
  }
  if (!cell.buildable || cell.terrain !== 'grass') {
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
  let paidMines = 0;
  for (const mine of room.buildings.values()) {
    if (mine.type !== 'mine') continue;
    room.playerState[mine.owner].gold += GAME_CONFIG.mineIncome;
    paidMines += 1;
  }
  if (paidMines > 0 && shouldBroadcast) broadcastState(room);
  return paidMines;
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
  return routePoints;
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

  const allowedBuildingIds = new Set([barracks.id, ...targetBuildingIds]);
  for (let index = 1; index < routePoints.length; index += 1) {
    const first = routePoints[index - 1];
    const second = routePoints[index];
    for (const building of room.buildings.values()) {
      if (
        !allowedBuildingIds.has(building.id)
        && segmentIntersectsGridObject(first, second, building)
      ) return { reason: 'Route cannot pass through a non-target building.' };
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
  room.routes = room.routes.filter((route) => route.barracksId !== barracksId);
  if (room.routes.length === before) {
    reject(socket, 'cancel_route', 'This barracks has no route to cancel.');
    return false;
  }
  log('route_cancel', `room=${socket.roomId} player=${socket.playerId} barracks=${barracksId}`);
  broadcastState(room);
  return true;
}

function spawnUnit(room, route) {
  const barracks = room.buildings.get(route.barracksId);
  if (!barracks || barracks.type !== 'barracks' || route.targetBuildingIds.length === 0) {
    return undefined;
  }
  const start = buildingCenter(barracks);
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
    hp: COMBAT_CONFIG.unitMaxHp,
    maxHp: COMBAT_CONFIG.unitMaxHp,
    attackCooldownMs: 0
  };
  room.units.set(unit.id, unit);
  return unit;
}

function advanceUnit(unit, finalPointIndex, travel) {
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
  }
}

function destroyBuilding(room, buildingId, attackerOwner) {
  const building = room.buildings.get(buildingId);
  if (!building) return undefined;
  room.buildings.delete(buildingId);
  const cell = cellFor(room.map, building.row, building.column);
  if (cell?.buildingId === buildingId) cell.buildingId = null;
  room.routes = room.routes.filter((route) => (
    route.barracksId !== buildingId && !route.targetBuildingIds.includes(buildingId)
  ));
  recomputeTerritory(room);
  if (building.type === 'castle') {
    room.winner = attackerOwner;
    room.phase = 'finished';
  }
  return building;
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

  for (const route of room.routes) {
    const barracks = room.buildings.get(route.barracksId);
    if (!barracks) continue;
    barracks.spawnElapsedMs += deltaMs;
    while (barracks.spawnElapsedMs >= COMBAT_CONFIG.barracksSpawnIntervalMs) {
      barracks.spawnElapsedMs -= COMBAT_CONFIG.barracksSpawnIntervalMs;
      if (spawnUnit(room, route)) changed = true;
    }
  }

  const unitDamage = new Map();
  const buildingDamage = new Map();
  for (const tower of room.buildings.values()) {
    if (tower.type !== 'tower') continue;
    tower.attackCooldownMs = Math.max(0, tower.attackCooldownMs - deltaMs);
    const center = buildingCenter(tower);
    const target = nearestEnemyUnit(room, { ...center, owner: tower.owner }, COMBAT_CONFIG.towerRange);
    if (target && tower.attackCooldownMs <= 0) {
      addDamage(unitDamage, target.id, COMBAT_CONFIG.towerDamage);
      tower.attackCooldownMs = COMBAT_CONFIG.towerAttackIntervalMs;
      changed = true;
    }
  }

  const exhaustedUnits = [];
  for (const unit of room.units.values()) {
    unit.attackCooldownMs = Math.max(0, unit.attackCooldownMs - deltaMs);
    const enemyUnit = nearestEnemyUnit(room, unit, COMBAT_CONFIG.unitAggroRange);
    if (enemyUnit) {
      if (unit.attackCooldownMs <= 0) {
        addDamage(unitDamage, enemyUnit.id, COMBAT_CONFIG.unitDamage);
        unit.attackCooldownMs = COMBAT_CONFIG.unitAttackIntervalMs;
        changed = true;
      }
      continue;
    }

    if (unit.currentTargetIndex >= unit.targetBuildingIds.length) {
      exhaustedUnits.push(unit.id);
      continue;
    }
    const targetPointIndex = unit.targetPointIndices?.[unit.currentTargetIndex] ?? -1;
    if (unit.currentPointIndex <= targetPointIndex) {
      advanceUnit(
        unit,
        targetPointIndex,
        COMBAT_CONFIG.unitSpeedPerSecond * deltaMs / 1000
      );
      changed = true;
      continue;
    }

    const target = room.buildings.get(unit.targetBuildingIds[unit.currentTargetIndex]);
    if (!target || target.owner === unit.owner) {
      unit.currentTargetIndex += 1;
      changed = true;
      continue;
    }
    const distance = pointDistance(unit, buildingCenter(target));
    if (distance <= COMBAT_CONFIG.unitAttackRange) {
      if (unit.attackCooldownMs <= 0) {
        addBuildingDamage(buildingDamage, target.id, COMBAT_CONFIG.unitDamage, unit.owner);
        unit.attackCooldownMs = COMBAT_CONFIG.unitAttackIntervalMs;
        changed = true;
      }
      continue;
    }
    unit.currentTargetIndex += 1;
  }

  for (const unitId of exhaustedUnits) room.units.delete(unitId);
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
  if (message.type === 'create_room') return createRoom(socket);
  if (message.type === 'join_room') return joinRoom(socket, message.roomId);
  if (message.type === 'build') {
    return build(socket, message.row, message.column, message.buildingType);
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
  LEVEL_CONFIG,
  ROUTE_CONFIG,
  COMBAT_CONFIG,
  NETWORK_CONFIG,
  createMap,
  cellFor,
  makeRoom,
  publicState,
  expandTerritory,
  recomputeTerritory,
  buildingCenter,
  segmentIntersectsGridObject,
  segmentIntersectsBuilding,
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
};
