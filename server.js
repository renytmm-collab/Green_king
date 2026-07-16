const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { GAME_CONFIG, MAP_CONFIG, ROUTE_CONFIG } = require('./server/config');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const rooms = new Map();

function safeSend(socket, message) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function sendError(socket, message) { safeSend(socket, { type: 'error', message }); }
function reject(socket, action, reason) { safeSend(socket, { type: 'action_rejected', action, reason }); }
function broadcast(room, message) { for (const player of room.players.values()) safeSend(player.socket, message); }
function publicState(room) { return { type: 'game_state', players: room.playerState, map: room.map, buildings: [...room.buildings.values()], routes: room.routes }; }
function sendState(socket, room) { safeSend(socket, publicState(room)); }
function broadcastState(room) { broadcast(room, publicState(room)); }
function makeRoomId() { let id; do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(id)); return id; }
function log(event, details) { console.log(`[${new Date().toISOString()}] ${event} ${details}`); }

function territoryFor(column) {
  if (column < MAP_CONFIG.homeColumns) return 'player1';
  if (column >= MAP_CONFIG.columns - MAP_CONFIG.homeColumns) return 'player2';
  return 'neutral';
}

function createMap() {
  const cells = [];
  for (let row = 0; row < MAP_CONFIG.rows; row += 1) {
    for (let column = 0; column < MAP_CONFIG.columns; column += 1) {
      const territory = territoryFor(column);
      cells.push({ row, column, territory, terrain: 'grass', buildable: territory !== 'neutral', blocked: false, buildingId: null });
    }
  }
  return { rows: MAP_CONFIG.rows, columns: MAP_CONFIG.columns, cells };
}

function cellFor(map, row, column) {
  if (!Number.isInteger(row) || !Number.isInteger(column) || row < 0 || row >= map.rows || column < 0 || column >= map.columns) return undefined;
  return map.cells[row * map.columns + column];
}

function addBuilding(room, building) {
  room.buildings.set(building.id, building);
  cellFor(room.map, building.row, building.column).buildingId = building.id;
}

function makeRoom() {
  const room = {
    players: new Map(),
    playerState: { player1: { gold: GAME_CONFIG.startingGold }, player2: { gold: GAME_CONFIG.startingGold } },
    map: createMap(), buildings: new Map(), routes: [], nextBuildingId: 1, nextRouteId: 1
  };
  const castleRow = Math.floor(MAP_CONFIG.rows / 2);
  addBuilding(room, { id: 'player1_castle', type: 'castle', owner: 'player1', row: castleRow, column: 1, width: 1, height: 1 });
  addBuilding(room, { id: 'player2_castle', type: 'castle', owner: 'player2', row: castleRow, column: MAP_CONFIG.columns - 2, width: 1, height: 1 });
  return room;
}

function buildingCenter(building) {
  return { x: (building.column + building.width / 2) / MAP_CONFIG.columns, y: (building.row + building.height / 2) / MAP_CONFIG.rows };
}
function distance(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function routeLength(points) { let total = 0; for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]); return total; }
function pointInRect(point, rect) { return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom; }
function orientation(a, b, c) { return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x); }
function segmentsIntersect(a, b, c, d) {
  const epsilon = 1e-10;
  const o1 = orientation(a, b, c); const o2 = orientation(a, b, d); const o3 = orientation(c, d, a); const o4 = orientation(c, d, b);
  if (((o1 > epsilon && o2 < -epsilon) || (o1 < -epsilon && o2 > epsilon)) && ((o3 > epsilon && o4 < -epsilon) || (o3 < -epsilon && o4 > epsilon))) return true;
  const onSegment = (p, q, r) => Math.abs(orientation(p, q, r)) <= epsilon && r.x >= Math.min(p.x, q.x) - epsilon && r.x <= Math.max(p.x, q.x) + epsilon && r.y >= Math.min(p.y, q.y) - epsilon && r.y <= Math.max(p.y, q.y) + epsilon;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}
function segmentIntersectsBuilding(a, b, building) {
  const rect = { left: building.column / MAP_CONFIG.columns, right: (building.column + building.width) / MAP_CONFIG.columns, top: building.row / MAP_CONFIG.rows, bottom: (building.row + building.height) / MAP_CONFIG.rows };
  if (pointInRect(a, rect) || pointInRect(b, rect)) return true;
  const tl = { x: rect.left, y: rect.top }; const tr = { x: rect.right, y: rect.top }; const bl = { x: rect.left, y: rect.bottom }; const br = { x: rect.right, y: rect.bottom };
  return segmentsIntersect(a, b, tl, tr) || segmentsIntersect(a, b, tr, br) || segmentsIntersect(a, b, br, bl) || segmentsIntersect(a, b, bl, tl);
}

function leaveRoom(socket) {
  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  if (room) { room.players.delete(socket.playerId); log('disconnect', `room=${socket.roomId} player=${socket.playerId}`); broadcast(room, { type: 'opponent_left' }); if (room.players.size === 0) rooms.delete(socket.roomId); }
  socket.roomId = undefined; socket.playerId = undefined;
}
function createRoom(socket) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = makeRoomId(); const room = makeRoom(); room.players.set('player1', { socket }); rooms.set(roomId, room);
  socket.roomId = roomId; socket.playerId = 'player1'; log('room_created', `room=${roomId} player=player1`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player1' }); setImmediate(() => sendState(socket, room));
}
function joinRoom(socket, rawRoomId) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = String(rawRoomId || '').trim(); const room = rooms.get(roomId);
  if (!room) return sendError(socket, 'Room not found. Check the room number.');
  if (room.players.size >= 2) return sendError(socket, 'Room is full.');
  room.players.set('player2', { socket }); socket.roomId = roomId; socket.playerId = 'player2'; log('room_joined', `room=${roomId} player=player2`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player2' }); setImmediate(() => sendState(socket, room)); safeSend(room.players.get('player1').socket, { type: 'opponent_joined', playerId: 'player2' });
}

function build(socket, row, column, buildingType) {
  if (!socket.roomId || !socket.playerId) return reject(socket, 'build', 'Create or join a room first.');
  const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return reject(socket, 'build', 'Waiting for the other player.');
  if (!Number.isInteger(row) || !Number.isInteger(column)) return reject(socket, 'build', 'Row and column must be integers.');
  const cell = cellFor(room.map, row, column); const cost = GAME_CONFIG.buildingCosts[buildingType]; const player = room.playerState[socket.playerId];
  if (!cell) return reject(socket, 'build', 'Building coordinates are outside the map.');
  if (cell.territory !== socket.playerId) return reject(socket, 'build', 'You can only build in your own territory.');
  if (!cell.buildable || cell.blocked) return reject(socket, 'build', 'This cell cannot be built on.');
  if (cell.buildingId) return reject(socket, 'build', 'This cell already has a building.');
  if (!Object.hasOwn(GAME_CONFIG.buildingCosts, buildingType)) return reject(socket, 'build', 'Unknown building type.');
  if (player.gold < cost) return reject(socket, 'build', 'Not enough gold.');
  const building = { id: `building_${room.nextBuildingId++}`, type: buildingType, owner: socket.playerId, row, column, width: 1, height: 1 };
  player.gold -= cost; addBuilding(room, building);
  log('build', `room=${socket.roomId} player=${socket.playerId} cell=${row},${column} type=${buildingType} gold=${player.gold}`); broadcastState(room); return building;
}

function validateRoute(room, playerId, barracksId, targetBuildingId, points) {
  const barracks = room.buildings.get(barracksId); const target = room.buildings.get(targetBuildingId);
  if (!barracks || barracks.type !== 'barracks') return 'Routes must start from a barracks.';
  if (barracks.owner !== playerId) return 'You can only control your own barracks.';
  if (!target) return 'Target building does not exist.';
  if (target.owner === playerId) return 'Route target must be an enemy building.';
  if (barracks.id === target.id) return 'Route start and target must differ.';
  if (!Array.isArray(points)) return 'Route points must be an array.';
  if (points.length < ROUTE_CONFIG.minPoints || points.length > ROUTE_CONFIG.maxPoints) return `Route must contain ${ROUTE_CONFIG.minPoints} to ${ROUTE_CONFIG.maxPoints} points.`;
  if (!points.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)) return 'Route coordinates must be finite numbers from 0 to 1.';
  const start = buildingCenter(barracks); const end = buildingCenter(target);
  if (distance(points[0], start) > ROUTE_CONFIG.endpointTolerance) return 'Route must start at the barracks.';
  if (distance(points.at(-1), end) > ROUTE_CONFIG.endpointTolerance) return 'Route must end at the target building.';
  const length = routeLength(points);
  if (length < ROUTE_CONFIG.minLength) return 'Route is too short.';
  if (length > ROUTE_CONFIG.maxLength) return 'Route is too long.';
  for (let i = 1; i < points.length; i += 1) {
    for (const building of room.buildings.values()) {
      if (building.id !== barracks.id && building.id !== target.id && segmentIntersectsBuilding(points[i - 1], points[i], building)) return 'Route cannot pass through another building.';
    }
  }
  return null;
}

function createRoute(socket, barracksId, targetBuildingId, points) {
  if (!socket.roomId || !socket.playerId) return reject(socket, 'create_route', 'Create or join a room first.');
  const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return reject(socket, 'create_route', 'Waiting for the other player.');
  const reason = validateRoute(room, socket.playerId, barracksId, targetBuildingId, points); if (reason) return reject(socket, 'create_route', reason);
  const barracks = room.buildings.get(barracksId); const target = room.buildings.get(targetBuildingId);
  const canonicalPoints = points.map(({ x, y }) => ({ x, y })); canonicalPoints[0] = buildingCenter(barracks); canonicalPoints[canonicalPoints.length - 1] = buildingCenter(target);
  const existing = room.routes.find((route) => route.barracksId === barracksId);
  const route = { id: existing ? existing.id : `route_${room.nextRouteId++}`, owner: socket.playerId, barracksId, targetBuildingId, points: canonicalPoints };
  room.routes = room.routes.filter((item) => item.barracksId !== barracksId); room.routes.push(route);
  log('route', `room=${socket.roomId} player=${socket.playerId} ${barracksId} -> ${targetBuildingId}`); broadcastState(room); return route;
}

function applyMineIncome(room) {
  if (!room || room.players.size === 0) return false;
  let changed = false;
  for (const playerId of ['player1', 'player2']) { const mines = [...room.buildings.values()].filter((building) => building.owner === playerId && building.type === 'mine').length; if (mines) { room.playerState[playerId].gold += mines * GAME_CONFIG.mineIncome; changed = true; } }
  if (changed) broadcastState(room); return changed;
}
function forwardPointer(socket, x, y) { if (!socket.roomId || !socket.playerId) return sendError(socket, 'Create or join a room first.'); if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return sendError(socket, 'Pointer coordinates must be finite values from 0 to 1.'); const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return sendError(socket, 'Waiting for the other player.'); const opponent = room.players.get(socket.playerId === 'player1' ? 'player2' : 'player1'); if (opponent) safeSend(opponent.socket, { type: 'opponent_pointer', playerId: socket.playerId, x, y }); }
function handleMessage(socket, raw) { let message; try { message = JSON.parse(raw.toString()); } catch { return sendError(socket, 'Invalid JSON message.'); } if (!message || typeof message.type !== 'string') return sendError(socket, 'Message type is required.'); if (message.type === 'create_room') return createRoom(socket); if (message.type === 'join_room') return joinRoom(socket, message.roomId); if (message.type === 'build') return build(socket, message.row, message.column, message.buildingType); if (message.type === 'create_route') return createRoute(socket, message.barracksId, message.targetBuildingId, message.points); if (message.type === 'pointer_click') return forwardPointer(socket, message.x, message.y); return sendError(socket, 'Unsupported message type.'); }
function listLanUrls(port) { return Object.values(os.networkInterfaces()).flat().filter((address) => address && address.family === 'IPv4' && !address.internal).map((address) => `http://${address.address}:${port}`); }
function createAppServer() { const app = express(); app.use(express.static(path.join(__dirname, 'public'))); const server = http.createServer(app); const wss = new WebSocketServer({ server }); wss.on('connection', (socket, request) => { log('connected', `ip=${request.socket.remoteAddress}`); socket.on('message', (raw) => handleMessage(socket, raw)); socket.on('close', () => leaveRoom(socket)); }); return { server, wss }; }
if (require.main === module) { const { server } = createAppServer(); setInterval(() => { for (const room of rooms.values()) applyMineIncome(room); }, GAME_CONFIG.mineIncomeIntervalMs); server.listen(PORT, '0.0.0.0', () => { console.log(`Server running: http://localhost:${PORT}`); const urls = listLanUrls(PORT); console.log(urls.length ? `LAN address(es):\n${urls.join('\n')}` : 'No LAN IPv4 address found.'); }); }
module.exports = { createAppServer, rooms, GAME_CONFIG, MAP_CONFIG, ROUTE_CONFIG, createMap, cellFor, makeRoom, buildingCenter, segmentIntersectsBuilding, applyMineIncome, build, validateRoute, createRoute };
