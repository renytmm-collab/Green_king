const board = document.querySelector('#board');
const context = board.getContext('2d');
const status = document.querySelector('#connection-status');
const identity = document.querySelector('#identity');
const roomDisplay = document.querySelector('#room-display');
const notice = document.querySelector('#notice');
const createButton = document.querySelector('#create-room');
const joinButton = document.querySelector('#join-room');
const roomInput = document.querySelector('#room-id');
let socket; let playerId; let map = { nodes: [], edges: [], routes: [] }; let drag;
function setNotice(message) { notice.textContent = message; }
function send(message) { if (!socket || socket.readyState !== WebSocket.OPEN) return setNotice('服务器尚未连接。'); socket.send(JSON.stringify(message)); }
function point(node) { return { x: node.x * board.width, y: node.y * board.height }; }
function nodeById(id) { return map.nodes.find((node) => node.id === id); }
function drawLine(a, b, color, width, dashed) { context.save(); context.strokeStyle = color; context.lineWidth = width; if (dashed) context.setLineDash([10, 8]); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke(); context.restore(); }
function drawNode(node) { const p = point(node); const mine = node.owner === playerId; context.save(); context.fillStyle = node.owner === 'player1' ? '#3978c6' : node.owner === 'player2' ? '#d66e3b' : '#d5ba62'; context.strokeStyle = mine && node.type === 'barracks' ? '#fff5ae' : '#263828'; context.lineWidth = mine && node.type === 'barracks' ? 6 : 2;
  if (node.type === 'castle') context.fillRect(p.x - 25, p.y - 21, 50, 42); else if (node.type === 'barracks') { context.beginPath(); context.roundRect(p.x - 22, p.y - 16, 44, 32, 7); context.fill(); context.stroke(); } else { context.beginPath(); context.arc(p.x, p.y, 16, 0, Math.PI * 2); context.fill(); context.stroke(); }
  if (node.type === 'castle') context.strokeRect(p.x - 25, p.y - 21, 50, 42); context.fillStyle = '#1c2a1e'; context.font = '14px system-ui'; context.textAlign = 'center'; context.fillText(node.id.replace(/_/g, ' '), p.x, p.y + 40); context.restore(); }
function render() { context.clearRect(0, 0, board.width, board.height); context.fillStyle = '#d8ead4'; context.fillRect(0, 0, board.width, board.height); for (const [from, to] of map.edges) drawLine(point(nodeById(from)), point(nodeById(to)), '#90aa8b', 3); for (const route of map.routes) drawLine(point(nodeById(route.fromNodeId)), point(nodeById(route.toNodeId)), route.owner === 'player1' ? '#235eaa' : '#b64f25', 7); if (drag) drawLine(point(drag.from), drag.current, '#365f86', 5, true); for (const node of map.nodes) drawNode(node); }
function hitNode(event) { const rect = board.getBoundingClientRect(); const x = (event.clientX - rect.left) / rect.width * board.width; const y = (event.clientY - rect.top) / rect.height * board.height; return map.nodes.find((node) => { const p = point(node); return Math.hypot(p.x - x, p.y - y) <= 30; }); }
function canStart(node) { return node && node.type === 'barracks' && node.owner === playerId; }
function canvasPoint(event) { const rect = board.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width * board.width, y: (event.clientY - rect.top) / rect.height * board.height }; }
board.addEventListener('pointerdown', (event) => { const node = hitNode(event); if (!canStart(node)) return setNotice('请从自己的兵营开始拖拽。'); drag = { from: node, current: canvasPoint(event) }; board.setPointerCapture(event.pointerId); render(); });
board.addEventListener('pointermove', (event) => { if (!drag) return; drag.current = canvasPoint(event); render(); });
function finishDrag(event) { if (!drag) return; const from = drag.from; const target = hitNode(event); drag = undefined; render(); if (!target || target.id === from.id) return setNotice('路线已取消。'); send({ type: 'create_route', fromNodeId: from.id, toNodeId: target.id }); }
board.addEventListener('pointerup', finishDrag); board.addEventListener('pointercancel', () => { drag = undefined; render(); setNotice('路线已取消。'); });
function connect() { const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; socket = new WebSocket(`${protocol}//${location.host}`); socket.addEventListener('open', () => { status.textContent = '已连接服务器'; status.className = 'status connected'; }); socket.addEventListener('close', () => { status.textContent = '连接已断开，请刷新页面重试'; status.className = 'status'; }); socket.addEventListener('message', ({ data }) => { let message; try { message = JSON.parse(data); } catch { return; } if (message.type === 'welcome') { playerId = message.playerId; identity.textContent = playerId === 'player1' ? '左方（player1）' : '右方（player2）'; roomDisplay.textContent = message.roomId; setNotice('已加入房间，等待另一名玩家。'); } else if (message.type === 'game_map') { map = message; render(); } else if (message.type === 'route_created') { map.routes = map.routes.filter((route) => route.fromNodeId !== message.route.fromNodeId); map.routes.push(message.route); render(); setNotice('服务器已确认路线。'); } else if (message.type === 'opponent_joined') setNotice('对方已加入，现在可以建立路线。'); else if (message.type === 'opponent_left') setNotice('对方已离开房间。'); else if (message.type === 'action_rejected' || message.type === 'error') setNotice(message.reason || message.message); }); }
createButton.addEventListener('click', () => send({ type: 'create_room' })); joinButton.addEventListener('click', () => send({ type: 'join_room', roomId: roomInput.value })); render(); connect();
