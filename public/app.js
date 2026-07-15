const board = document.querySelector('#board');
const context = board.getContext('2d');
const status = document.querySelector('#connection-status');
const identity = document.querySelector('#identity');
const roomDisplay = document.querySelector('#room-display');
const notice = document.querySelector('#notice');
const createButton = document.querySelector('#create-room');
const joinButton = document.querySelector('#join-room');
const roomInput = document.querySelector('#room-id');

let socket;
let selfMarker;
let opponentMarker;

function setNotice(message) { notice.textContent = message; }
function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return setNotice('服务器尚未连接。');
  socket.send(JSON.stringify(message));
}

function drawMarker(marker, color, label) {
  if (!marker) return;
  const x = marker.x * board.width;
  const y = marker.y * board.height;
  context.beginPath();
  context.arc(x, y, 12, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
  context.fillStyle = '#102016';
  context.font = '16px system-ui';
  context.fillText(label, x + 18, y - 16);
}

function render() {
  context.clearRect(0, 0, board.width, board.height);
  context.fillStyle = '#d8ead4';
  context.fillRect(0, 0, board.width, board.height);
  context.strokeStyle = '#9bbd95';
  context.lineWidth = 2;
  for (let x = 0; x <= board.width; x += 80) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, board.height); context.stroke(); }
  for (let y = 0; y <= board.height; y += 80) { context.beginPath(); context.moveTo(0, y); context.lineTo(board.width, y); context.stroke(); }
  drawMarker(selfMarker, '#2b75c9', '我');
  drawMarker(opponentMarker, '#df782f', '对方');
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener('open', () => { status.textContent = '已连接服务器'; status.className = 'status connected'; });
  socket.addEventListener('close', () => { status.textContent = '连接已断开，请刷新页面重试'; status.className = 'status'; });
  socket.addEventListener('error', () => setNotice('WebSocket 连接错误。'));
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'welcome') {
      identity.textContent = message.playerId === 'player1' ? '左方（player1）' : '右方（player2）';
      roomDisplay.textContent = message.roomId;
      setNotice(message.playerId === 'player1' ? `房间已创建：${message.roomId}。请将房间号告诉另一位玩家。` : '已加入房间，等待对方点击。');
    } else if (message.type === 'opponent_joined') {
      setNotice('对方已加入，可以互相同步点击标记。');
    } else if (message.type === 'opponent_left') {
      setNotice('对方已离开房间。');
    } else if (message.type === 'opponent_pointer') {
      opponentMarker = { x: message.x, y: message.y };
      render();
    } else if (message.type === 'error') {
      setNotice(message.message);
    }
  });
}

createButton.addEventListener('click', () => send({ type: 'create_room' }));
joinButton.addEventListener('click', () => send({ type: 'join_room', roomId: roomInput.value }));
board.addEventListener('click', (event) => {
  const rect = board.getBoundingClientRect();
  selfMarker = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  render();
  send({ type: 'pointer_click', x: selfMarker.x, y: selfMarker.y });
});

render();
connect();
