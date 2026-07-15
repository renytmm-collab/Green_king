const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const rooms = new Map();
const MAP_NODES = Object.freeze([
  { id: 'p1_castle', owner: 'player1', type: 'castle', x: 0.10, y: 0.50 },
  { id: 'p1_barracks', owner: 'player1', type: 'barracks', x: 0.28, y: 0.50 },
  { id: 'neutral_top', owner: null, type: 'empty', x: 0.50, y: 0.30 },
  { id: 'neutral_bottom', owner: null, type: 'empty', x: 0.50, y: 0.70 },
  { id: 'p2_barracks', owner: 'player2', type: 'barracks', x: 0.72, y: 0.50 },
  { id: 'p2_castle', owner: 'player2', type: 'castle', x: 0.90, y: 0.50 }
]);
const MAP_EDGES = Object.freeze([
  ['p1_castle', 'p1_barracks'], ['p1_barracks', 'neutral_top'], ['p1_barracks', 'neutral_bottom'],
  ['neutral_top', 'p2_barracks'], ['neutral_bottom', 'p2_barracks'], ['p2_barracks', 'p2_castle']
]);

function safeSend(socket, message) { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function sendError(socket, message) { safeSend(socket, { type: 'error', message }); }
function sendMap(socket, room) { safeSend(socket, { type: 'game_map', nodes: MAP_NODES, edges: MAP_EDGES, routes: room.routes }); }
function broadcast(room, message) { for (const player of room.players.values()) safeSend(player.socket, message); }
function makeRoomId() { let id; do { id = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(id)); return id; }
function log(event, details) { console.log(`[${new Date().toISOString()}] ${event} ${details}`); }

function leaveRoom(socket) {
  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  if (room) {
    room.players.delete(socket.playerId);
    log('disconnect', `room=${socket.roomId} player=${socket.playerId}`);
    broadcast(room, { type: 'opponent_left' });
    if (room.players.size === 0) rooms.delete(socket.roomId);
  }
  socket.roomId = undefined; socket.playerId = undefined;
}

function createRoom(socket) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = makeRoomId();
  const room = { players: new Map(), routes: [] };
  room.players.set('player1', { socket }); rooms.set(roomId, room);
  socket.roomId = roomId; socket.playerId = 'player1';
  log('room_created', `room=${roomId} player=player1`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player1' }); setImmediate(() => sendMap(socket, room));
}

function joinRoom(socket, rawRoomId) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = String(rawRoomId || '').trim(); const room = rooms.get(roomId);
  if (!room) return sendError(socket, 'Room not found. Check the room number.');
  if (room.players.size >= 2) return sendError(socket, 'Room is full.');
  room.players.set('player2', { socket }); socket.roomId = roomId; socket.playerId = 'player2';
  log('room_joined', `room=${roomId} player=player2`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player2' }); setImmediate(() => sendMap(socket, room));
  safeSend(room.players.get('player1').socket, { type: 'opponent_joined', playerId: 'player2' });
}

function rejectRoute(socket, reason) { safeSend(socket, { type: 'action_rejected', action: 'create_route', reason }); }
function isConnected(fromNodeId, toNodeId) { return MAP_EDGES.some(([a, b]) => (a === fromNodeId && b === toNodeId) || (a === toNodeId && b === fromNodeId)); }
function createRoute(socket, fromNodeId, toNodeId) {
  if (!socket.roomId || !socket.playerId) return rejectRoute(socket, 'Create or join a room first.');
  if (typeof fromNodeId !== 'string' || typeof toNodeId !== 'string') return rejectRoute(socket, 'Route node IDs are required.');
  const room = rooms.get(socket.roomId);
  if (!room || room.players.size !== 2) return rejectRoute(socket, 'Waiting for the other player.');
  const from = MAP_NODES.find((node) => node.id === fromNodeId);
  const to = MAP_NODES.find((node) => node.id === toNodeId);
  if (!from) return rejectRoute(socket, 'Starting node does not exist.');
  if (!to) return rejectRoute(socket, 'Target node does not exist.');
  if (from.type !== 'barracks') return rejectRoute(socket, 'Routes must start from a barracks.');
  if (from.owner !== socket.playerId) return rejectRoute(socket, 'You can only control your own barracks.');
  if (from.id === to.id) return rejectRoute(socket, 'Choose a different target.');
  if (to.id === `${socket.playerId === 'player1' ? 'p1' : 'p2'}_barracks`) return rejectRoute(socket, 'You cannot target your own barracks.');
  if (!isConnected(from.id, to.id)) return rejectRoute(socket, 'Those nodes are not connected by a road.');
  const route = { owner: socket.playerId, fromNodeId: from.id, toNodeId: to.id };
  room.routes = room.routes.filter((item) => item.fromNodeId !== from.id); room.routes.push(route);
  log('route', `room=${socket.roomId} player=${socket.playerId} ${from.id} -> ${to.id}`);
  broadcast(room, { type: 'route_created', route });
}

function forwardPointer(socket, x, y) {
  if (!socket.roomId || !socket.playerId) return sendError(socket, 'Create or join a room first.');
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return sendError(socket, 'Pointer coordinates must be finite values from 0 to 1.');
  const room = rooms.get(socket.roomId); if (!room || room.players.size !== 2) return sendError(socket, 'Waiting for the other player.');
  const opponent = room.players.get(socket.playerId === 'player1' ? 'player2' : 'player1');
  if (opponent) safeSend(opponent.socket, { type: 'opponent_pointer', playerId: socket.playerId, x, y });
}
function handleMessage(socket, raw) {
  let message; try { message = JSON.parse(raw.toString()); } catch { return sendError(socket, 'Invalid JSON message.'); }
  if (!message || typeof message.type !== 'string') return sendError(socket, 'Message type is required.');
  if (message.type === 'create_room') return createRoom(socket);
  if (message.type === 'join_room') return joinRoom(socket, message.roomId);
  if (message.type === 'create_route') return createRoute(socket, message.fromNodeId, message.toNodeId);
  if (message.type === 'pointer_click') return forwardPointer(socket, message.x, message.y);
  return sendError(socket, 'Unsupported message type.');
}
function listLanUrls(port) { return Object.values(os.networkInterfaces()).flat().filter((address) => address && address.family === 'IPv4' && !address.internal).map((address) => `http://${address.address}:${port}`); }
function createAppServer() {
  const app = express(); app.use(express.static(path.join(__dirname, 'public')));
  const server = http.createServer(app); const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => { log('connected', `ip=${request.socket.remoteAddress}`); socket.on('message', (raw) => handleMessage(socket, raw)); socket.on('close', () => leaveRoom(socket)); });
  return { server, wss };
}
if (require.main === module) { const { server } = createAppServer(); server.listen(PORT, '0.0.0.0', () => { console.log(`Server running: http://localhost:${PORT}`); const urls = listLanUrls(PORT); console.log(urls.length ? `LAN address(es):\n${urls.join('\n')}` : 'No LAN IPv4 address found.'); }); }
module.exports = { createAppServer, rooms, MAP_NODES, MAP_EDGES };
