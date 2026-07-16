const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { GAME_CONFIG } = require('./server/config');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const rooms = new Map();
const MAP_NODES = Object.freeze([
  { id: 'p1_castle', owner: 'player1', nodeType: 'castle', buildingType: 'castle', x: .10, y: .50 },
  { id: 'p1_barracks', owner: 'player1', nodeType: 'building', buildingType: 'barracks', x: .28, y: .50 },
  { id: 'p1_slot_top', owner: 'player1', nodeType: 'build_slot', buildingType: null, x: .24, y: .24 },
  { id: 'p1_slot_middle', owner: 'player1', nodeType: 'build_slot', buildingType: null, x: .38, y: .50 },
  { id: 'p1_slot_bottom', owner: 'player1', nodeType: 'build_slot', buildingType: null, x: .24, y: .76 },
  { id: 'neutral_top', owner: null, nodeType: 'neutral', buildingType: null, x: .50, y: .30 },
  { id: 'neutral_bottom', owner: null, nodeType: 'neutral', buildingType: null, x: .50, y: .70 },
  { id: 'p2_slot_top', owner: 'player2', nodeType: 'build_slot', buildingType: null, x: .76, y: .24 },
  { id: 'p2_slot_middle', owner: 'player2', nodeType: 'build_slot', buildingType: null, x: .62, y: .50 },
  { id: 'p2_slot_bottom', owner: 'player2', nodeType: 'build_slot', buildingType: null, x: .76, y: .76 },
  { id: 'p2_barracks', owner: 'player2', nodeType: 'building', buildingType: 'barracks', x: .72, y: .50 },
  { id: 'p2_castle', owner: 'player2', nodeType: 'castle', buildingType: 'castle', x: .90, y: .50 }
]);
const MAP_EDGES = Object.freeze([
  ['p1_castle', 'p1_barracks'], ['p1_barracks', 'neutral_top'], ['p1_barracks', 'neutral_bottom'],
  ['p1_barracks', 'p1_slot_top'], ['p1_barracks', 'p1_slot_middle'], ['p1_barracks', 'p1_slot_bottom'],
  ['p1_slot_top', 'neutral_top'], ['p1_slot_middle', 'neutral_top'], ['p1_slot_middle', 'neutral_bottom'], ['p1_slot_bottom', 'neutral_bottom'],
  ['neutral_top', 'p2_slot_top'], ['neutral_top', 'p2_slot_middle'], ['neutral_bottom', 'p2_slot_middle'], ['neutral_bottom', 'p2_slot_bottom'],
  ['p2_slot_top', 'p2_barracks'], ['p2_slot_middle', 'p2_barracks'], ['p2_slot_bottom', 'p2_barracks'],
  ['neutral_top', 'p2_barracks'], ['neutral_bottom', 'p2_barracks'], ['p2_barracks', 'p2_castle']
]);

function safeSend(socket, message) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function sendError(socket, message) { safeSend(socket, { type: 'error', message }); }
function broadcast(room, message) { for (const player of room.players.values()) safeSend(player.socket, message); }
function sendState(socket, room) { safeSend(socket, { type: 'game_state', players: room.playerState, nodes: room.nodes, edges: MAP_EDGES, routes: room.routes }); }
function broadcastState(room) { broadcast(room, { type: 'game_state', players: room.playerState, nodes: room.nodes, edges: MAP_EDGES, routes: room.routes }); }
function makeRoomId() { let id; do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(id)); return id; }
function log(event, details) { console.log(`[${new Date().toISOString()}] ${event} ${details}`); }
function makeRoom() { return { players: new Map(), playerState: { player1: { gold: GAME_CONFIG.startingGold }, player2: { gold: GAME_CONFIG.startingGold } }, nodes: MAP_NODES.map((node) => ({ ...node })), routes: [] }; }
function nodeFor(room, id) { return room.nodes.find((node) => node.id === id); }
function isConnected(from, to) { return MAP_EDGES.some(([a, b]) => (a === from && b === to) || (a === to && b === from)); }

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
function reject(socket, action, reason) { safeSend(socket, { type: 'action_rejected', action, reason }); }
function build(socket, nodeId, buildingType) {
  if (!socket.roomId || !socket.playerId) return reject(socket, 'build', 'Create or join a room first.');
  if (typeof nodeId !== 'string' || typeof buildingType !== 'string') return reject(socket, 'build', 'Building node and type are required.');
  const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return reject(socket, 'build', 'Waiting for the other player.');
  const node = nodeFor(room, nodeId); const cost = GAME_CONFIG.buildingCosts[buildingType]; const player = room.playerState[socket.playerId];
  if (!node) return reject(socket, 'build', 'Building node does not exist.');
  if (node.owner !== socket.playerId) return reject(socket, 'build', 'You can only build on your own slot.');
  if (node.nodeType !== 'build_slot') return reject(socket, 'build', 'This node is not a building slot.');
  if (node.buildingType) return reject(socket, 'build', 'This slot already has a building.');
  if (!cost) return reject(socket, 'build', 'Unknown building type.');
  if (player.gold < cost) return reject(socket, 'build', 'Not enough gold.');
  player.gold -= cost; node.buildingType = buildingType; node.nodeType = 'building';
  log('build', `room=${socket.roomId} player=${socket.playerId} node=${nodeId} type=${buildingType} gold=${player.gold}`); broadcastState(room);
}
function createRoute(socket, fromNodeId, toNodeId) {
  if (!socket.roomId || !socket.playerId) return reject(socket, 'create_route', 'Create or join a room first.');
  if (typeof fromNodeId !== 'string' || typeof toNodeId !== 'string') return reject(socket, 'create_route', 'Route node IDs are required.');
  const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return reject(socket, 'create_route', 'Waiting for the other player.');
  const from = nodeFor(room, fromNodeId); const to = nodeFor(room, toNodeId);
  if (!from || !to) return reject(socket, 'create_route', 'Route node does not exist.');
  if (from.buildingType !== 'barracks') return reject(socket, 'create_route', 'Routes must start from a barracks.');
  if (from.owner !== socket.playerId) return reject(socket, 'create_route', 'You can only control your own barracks.');
  if (from.id === to.id || !isConnected(from.id, to.id)) return reject(socket, 'create_route', 'Those nodes cannot be connected by a route.');
  const route = { owner: socket.playerId, fromNodeId: from.id, toNodeId: to.id }; room.routes = room.routes.filter((item) => item.fromNodeId !== from.id); room.routes.push(route);
  log('route', `room=${socket.roomId} player=${socket.playerId} ${from.id} -> ${to.id}`); broadcastState(room);
}
function applyMineIncome(room) {
  if (!room || room.players.size === 0) return false;
  let changed = false;
  for (const playerId of ['player1', 'player2']) { const mines = room.nodes.filter((node) => node.owner === playerId && node.buildingType === 'mine').length; if (mines) { room.playerState[playerId].gold += mines * GAME_CONFIG.mineIncome; changed = true; } }
  if (changed) broadcastState(room); return changed;
}
function forwardPointer(socket, x, y) { if (!socket.roomId || !socket.playerId) return sendError(socket, 'Create or join a room first.'); if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return sendError(socket, 'Pointer coordinates must be finite values from 0 to 1.'); const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return sendError(socket, 'Waiting for the other player.'); const opponent = room.players.get(socket.playerId === 'player1' ? 'player2' : 'player1'); if (opponent) safeSend(opponent.socket, { type: 'opponent_pointer', playerId: socket.playerId, x, y }); }
function handleMessage(socket, raw) { let message; try { message = JSON.parse(raw.toString()); } catch { return sendError(socket, 'Invalid JSON message.'); } if (!message || typeof message.type !== 'string') return sendError(socket, 'Message type is required.'); if (message.type === 'create_room') return createRoom(socket); if (message.type === 'join_room') return joinRoom(socket, message.roomId); if (message.type === 'build') return build(socket, message.nodeId, message.buildingType); if (message.type === 'create_route') return createRoute(socket, message.fromNodeId, message.toNodeId); if (message.type === 'pointer_click') return forwardPointer(socket, message.x, message.y); return sendError(socket, 'Unsupported message type.'); }
function listLanUrls(port) { return Object.values(os.networkInterfaces()).flat().filter((address) => address && address.family === 'IPv4' && !address.internal).map((address) => `http://${address.address}:${port}`); }
function createAppServer() { const app = express(); app.use(express.static(path.join(__dirname, 'public'))); const server = http.createServer(app); const wss = new WebSocketServer({ server }); wss.on('connection', (socket, request) => { log('connected', `ip=${request.socket.remoteAddress}`); socket.on('message', (raw) => handleMessage(socket, raw)); socket.on('close', () => leaveRoom(socket)); }); return { server, wss }; }
if (require.main === module) { const { server } = createAppServer(); setInterval(() => { for (const room of rooms.values()) applyMineIncome(room); }, GAME_CONFIG.mineIncomeIntervalMs); server.listen(PORT, '0.0.0.0', () => { console.log(`Server running: http://localhost:${PORT}`); const urls = listLanUrls(PORT); console.log(urls.length ? `LAN address(es):\n${urls.join('\n')}` : 'No LAN IPv4 address found.'); }); }
module.exports = { createAppServer, rooms, MAP_NODES, MAP_EDGES, GAME_CONFIG, makeRoom, applyMineIncome, build, createRoute };
