const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const rooms = new Map();

function safeSend(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function makeRoomId() {
  let roomId;
  do {
    roomId = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms.has(roomId));
  return roomId;
}

function log(event, details) {
  console.log(`[${new Date().toISOString()}] ${event} ${details}`);
}

function sendError(socket, message) {
  safeSend(socket, { type: 'error', message });
}

function leaveRoom(socket) {
  if (!socket.roomId) return;
  const room = rooms.get(socket.roomId);
  if (room) {
    room.players.delete(socket.playerId);
    log('disconnect', `room=${socket.roomId} player=${socket.playerId}`);
    for (const player of room.players.values()) {
      safeSend(player.socket, { type: 'opponent_left' });
    }
    if (room.players.size === 0) rooms.delete(socket.roomId);
  }
  socket.roomId = undefined;
  socket.playerId = undefined;
}

function createRoom(socket) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = makeRoomId();
  const room = { players: new Map() };
  room.players.set('player1', { socket });
  rooms.set(roomId, room);
  socket.roomId = roomId;
  socket.playerId = 'player1';
  log('room_created', `room=${roomId} player=player1`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player1' });
}

function joinRoom(socket, rawRoomId) {
  if (socket.roomId) return sendError(socket, 'You are already in a room.');
  const roomId = String(rawRoomId || '').trim();
  const room = rooms.get(roomId);
  if (!room) return sendError(socket, 'Room not found. Check the room number.');
  if (room.players.size >= 2) return sendError(socket, 'Room is full.');
  room.players.set('player2', { socket });
  socket.roomId = roomId;
  socket.playerId = 'player2';
  log('room_joined', `room=${roomId} player=player2`);
  safeSend(socket, { type: 'welcome', roomId, playerId: 'player2' });
  const player1 = room.players.get('player1');
  safeSend(player1.socket, { type: 'opponent_joined', playerId: 'player2' });
}

function forwardPointer(socket, x, y) {
  if (!socket.roomId || !socket.playerId) return sendError(socket, 'Create or join a room first.');
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
    return sendError(socket, 'Pointer coordinates must be finite values from 0 to 1.');
  }
  const room = rooms.get(socket.roomId);
  if (!room || room.players.size !== 2) return sendError(socket, 'Waiting for the other player.');
  const opponentId = socket.playerId === 'player1' ? 'player2' : 'player1';
  const opponent = room.players.get(opponentId);
  if (!opponent) return sendError(socket, 'Waiting for the other player.');
  log('pointer_click', `room=${socket.roomId} player=${socket.playerId} x=${x.toFixed(3)} y=${y.toFixed(3)}`);
  safeSend(opponent.socket, { type: 'opponent_pointer', playerId: socket.playerId, x, y });
}

function handleMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return sendError(socket, 'Invalid JSON message.');
  }
  if (!message || typeof message.type !== 'string') return sendError(socket, 'Message type is required.');
  if (message.type === 'create_room') return createRoom(socket);
  if (message.type === 'join_room') return joinRoom(socket, message.roomId);
  if (message.type === 'pointer_click') return forwardPointer(socket, message.x, message.y);
  return sendError(socket, 'Unsupported message type.');
}

function listLanUrls(port) {
  const addresses = [];
  for (const group of Object.values(os.networkInterfaces())) {
    for (const address of group || []) {
      if (address.family === 'IPv4' && !address.internal) addresses.push(`http://${address.address}:${port}`);
    }
  }
  return addresses;
}

function createAppServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  wss.on('connection', (socket, request) => {
    log('connected', `ip=${request.socket.remoteAddress}`);
    socket.on('message', (raw) => handleMessage(socket, raw));
    socket.on('close', () => leaveRoom(socket));
  });
  return { server, wss };
}

if (require.main === module) {
  const { server } = createAppServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running: http://localhost:${PORT}`);
    const lanUrls = listLanUrls(PORT);
    console.log(lanUrls.length ? `LAN address(es):\n${lanUrls.join('\n')}` : 'No LAN IPv4 address found.');
  });
}

module.exports = { createAppServer, rooms };
