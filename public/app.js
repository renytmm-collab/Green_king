import { initializeRenderer, resizeCanvas, eventToLogicalPoint, cellAtPoint, buildingAtPoint, buildingCenter, drawMap } from './renderer.js';

const board = document.querySelector('#board'); const status = document.querySelector('#connection-status'); const identity = document.querySelector('#identity'); const roomDisplay = document.querySelector('#room-display'); const goldDisplay = document.querySelector('#gold-display'); const notice = document.querySelector('#notice'); const buildMenu = document.querySelector('#build-menu'); const createButton = document.querySelector('#create-room'); const joinButton = document.querySelector('#join-room'); const roomInput = document.querySelector('#room-id');
let socket; let playerId; let state = { players: {}, map: null, buildings: [], routes: [] }; let drag; let selectedCell;
initializeRenderer(board);
function render() { drawMap(state, selectedCell, drag?.points); }
function setNotice(message) { notice.textContent = message; }
function send(message) { if (!socket || socket.readyState !== WebSocket.OPEN) return setNotice('服务器尚未连接。'); socket.send(JSON.stringify(message)); }
function hideBuildMenu() { selectedCell = undefined; buildMenu.hidden = true; render(); }
function showBuildMenu(cell) { selectedCell = cell; buildMenu.hidden = false; buildMenu.querySelector('strong').textContent = `建造：第 ${cell.row + 1} 行，第 ${cell.column + 1} 列`; render(); }
function roomReady() { return playerId && state.players.player1 && state.players.player2; }

board.addEventListener('pointerdown', (event) => {
  if (drag || !state.map || !roomReady()) return;
  const point = eventToLogicalPoint(event); const building = buildingAtPoint(state, point); const cell = cellAtPoint(state.map, point);
  if (building && building.owner === playerId && building.type === 'barracks') { hideBuildMenu(); drag = { pointerId: event.pointerId, barracks: building, points: [buildingCenter(building, state.map)] }; board.setPointerCapture(event.pointerId); render(); return; }
  if (cell && cell.territory === playerId && cell.buildable && !cell.blocked && !cell.buildingId) return showBuildMenu(cell);
  hideBuildMenu(); setNotice('请选择自己的空地建造，或从自己的兵营拖拽路线。');
});
board.addEventListener('pointermove', (event) => { if (!drag || drag.pointerId !== event.pointerId) return; const point = eventToLogicalPoint(event); const previous = drag.points.at(-1); if (Math.hypot(point.x - previous.x, point.y - previous.y) >= .012 && drag.points.length < 99) { drag.points.push({ x: Math.max(0, Math.min(1, point.x)), y: Math.max(0, Math.min(1, point.y)) }); render(); } });
function finishDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return; const current = drag; const point = eventToLogicalPoint(event); const target = buildingAtPoint(state, point); drag = undefined; render();
  if (!target || target.owner === playerId) return setNotice('路线已取消：请在敌方建筑上松开。');
  const end = buildingCenter(target, state.map); if (current.points.length === 1 || Math.hypot(end.x - current.points.at(-1).x, end.y - current.points.at(-1).y) > .002) current.points.push(end); else current.points[current.points.length - 1] = end;
  send({ type: 'create_route', barracksId: current.barracks.id, targetBuildingId: target.id, points: current.points });
}
board.addEventListener('pointerup', finishDrag); board.addEventListener('pointercancel', (event) => { if (drag?.pointerId === event.pointerId) { drag = undefined; render(); } });
buildMenu.addEventListener('click', (event) => { const button = event.target.closest('button[data-building]'); if (!button || !selectedCell) return; send({ type: 'build', row: selectedCell.row, column: selectedCell.column, buildingType: button.dataset.building }); hideBuildMenu(); });
window.addEventListener('resize', () => { resizeCanvas(); render(); });
function connect() { const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'; socket = new WebSocket(`${protocol}//${location.host}`); socket.addEventListener('open', () => { status.textContent = '已连接服务器'; status.className = 'status connected'; }); socket.addEventListener('close', () => { status.textContent = '连接已断开，请刷新页面重试'; status.className = 'status'; drag = undefined; }); socket.addEventListener('message', ({ data }) => { let message; try { message = JSON.parse(data); } catch { return; } if (message.type === 'welcome') { playerId = message.playerId; identity.textContent = playerId === 'player1' ? '左方（player1）' : '右方（player2）'; roomDisplay.textContent = message.roomId; } else if (message.type === 'game_state') { state = message; goldDisplay.textContent = state.players[playerId]?.gold ?? '--'; render(); } else if (message.type === 'opponent_joined') setNotice('对方已加入。'); else if (message.type === 'opponent_left') { setNotice('对方已离开房间。'); drag = undefined; render(); } else if (message.type === 'action_rejected' || message.type === 'error') setNotice(message.reason || message.message); }); }
createButton.addEventListener('click', () => send({ type: 'create_room' })); joinButton.addEventListener('click', () => send({ type: 'join_room', roomId: roomInput.value })); render(); connect();
