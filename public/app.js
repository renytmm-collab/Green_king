import {
  initializeRenderer,
  preloadVisualAssets,
  resizeCanvas,
  eventToLogicalPoint,
  cellAtPoint,
  buildingAtPoint,
  obstacleAtPoint,
  buildingCenter,
  drawMap
} from './renderer.js';

const board = document.querySelector('#board');
const status = document.querySelector('#connection-status');
const identity = document.querySelector('#identity');
const roomDisplay = document.querySelector('#room-display');
const goldDisplay = document.querySelector('#gold-display');
const battleDisplay = document.querySelector('#battle-display');
const notice = document.querySelector('#notice');
const buildMenu = document.querySelector('#build-menu');
const clearMenu = document.querySelector('#clear-menu');
const routeMenu = document.querySelector('#route-menu');
const clearButton = document.querySelector('#clear-obstacle');
const cancelRouteButton = document.querySelector('#cancel-route');
const createButton = document.querySelector('#create-room');
const joinButton = document.querySelector('#join-room');
const roomInput = document.querySelector('#room-id');

let socket;
let playerId;
let state = {
  ready: false,
  phase: 'waiting',
  winner: null,
  rules: { buildingCosts: {}, clearCosts: {}, maxRouteTargets: 3, maxRouteSamples: 160 },
  players: {},
  map: null,
  buildings: [],
  obstacles: [],
  routes: [],
  units: []
};
let drag;
let selectedCell;
let selectedObstacle;
let selectedBarracks;
let animationRequest;

initializeRenderer(board);
preloadVisualAssets().then(() => render());

const ROUTE_SAMPLE_DISTANCE = 0.009;
function routeCellAtPoint(point, map) {
  return {
    row: Math.min(map.rows - 1, Math.max(0, Math.floor(point.y * map.rows))),
    column: Math.min(map.columns - 1, Math.max(0, Math.floor(point.x * map.columns)))
  };
}

function routeCellCenter(cell, map) {
  return {
    x: (cell.column + 0.5) / map.columns,
    y: (cell.row + 0.5) / map.rows
  };
}

function appendPreviewPoint(points, point) {
  const previous = points.at(-1);
  if (previous && Math.hypot(previous.x - point.x, previous.y - point.y) < 1e-10) return;
  if (points.length >= 2) {
    const beforePrevious = points.at(-2);
    const sameVertical = beforePrevious.x === previous.x && previous.x === point.x;
    const sameHorizontal = beforePrevious.y === previous.y && previous.y === point.y;
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

function orthogonalizePreview(samples, map) {
  if (!map || samples.length === 0) return samples;
  const points = [];
  let currentCell = routeCellAtPoint(samples[0], map);
  appendPreviewPoint(points, routeCellCenter(currentCell, map));
  for (const sample of samples.slice(1)) {
    const targetCell = routeCellAtPoint(sample, map);
    if (targetCell.row === currentCell.row && targetCell.column === currentCell.column) continue;
    if (targetCell.row !== currentCell.row && targetCell.column !== currentCell.column) {
      const columnDistance = Math.abs(targetCell.column - currentCell.column);
      const rowDistance = Math.abs(targetCell.row - currentCell.row);
      const corner = columnDistance >= rowDistance
        ? { row: currentCell.row, column: targetCell.column }
        : { row: targetCell.row, column: currentCell.column };
      appendPreviewPoint(points, routeCellCenter(corner, map));
    }
    appendPreviewPoint(points, routeCellCenter(targetCell, map));
    currentCell = targetCell;
  }
  return points;
}

function scheduleAnimationFrame() {
  if (
    animationRequest !== undefined
    || !state.ready
    || state.phase !== 'playing'
    || !state.units?.length
  ) return;
  animationRequest = requestAnimationFrame((animationNow) => {
    animationRequest = undefined;
    render(animationNow);
  });
}

function render(animationNow = performance.now()) {
  const draftPoints = drag
    ? [...drag.points, ...(drag.previewPoint ? [drag.previewPoint] : [])]
    : undefined;
  const temporaryPoints = draftPoints ? orthogonalizePreview(draftPoints, state.map) : undefined;
  drawMap(state, selectedCell, temporaryPoints, animationNow);
  scheduleAnimationFrame();
}

function applyUnitFacing(nextState) {
  const previousUnits = new Map((state.units || []).map((unit) => [unit.id, unit]));
  nextState.units = (nextState.units || []).map((unit) => {
    const previous = previousUnits.get(unit.id);
    const deltaX = previous ? unit.x - previous.x : 0;
    const inferredFacing = Math.abs(deltaX) > 0.000001
      ? (deltaX > 0 ? 'right' : 'left')
      : previous?.facing || (unit.owner === 'player1' ? 'right' : 'left');
    const authoritativeFacing = unit.facing === 'left' || unit.facing === 'right'
      ? unit.facing
      : undefined;
    return { ...unit, facing: authoritativeFacing ?? inferredFacing };
  });
  return nextState;
}

function setNotice(message) {
  notice.textContent = message;
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    setNotice('服务器尚未连接。');
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function closeMenus() {
  selectedCell = undefined;
  selectedObstacle = undefined;
  selectedBarracks = undefined;
  buildMenu.hidden = true;
  clearMenu.hidden = true;
  routeMenu.hidden = true;
}

function showBuildMenu(cell) {
  closeMenus();
  selectedCell = cell;
  buildMenu.hidden = false;
  buildMenu.querySelector('strong').textContent = `建造：第 ${cell.row + 1} 行，第 ${cell.column + 1} 列`;
  render();
}

function showClearMenu(obstacle) {
  closeMenus();
  selectedObstacle = obstacle;
  selectedCell = cellAtPoint(state.map, {
    x: (obstacle.column + 0.5) / state.map.columns,
    y: (obstacle.row + 0.5) / state.map.rows
  });
  const cost = state.rules.clearCosts[obstacle.type];
  clearMenu.querySelector('strong').textContent = obstacle.type === 'tree' ? '清除树木' : '清除岩石';
  clearButton.textContent = `Clear：${cost ?? '--'}`;
  clearMenu.hidden = false;
  render();
}

function showRouteMenu(barracks) {
  closeMenus();
  selectedBarracks = barracks;
  routeMenu.hidden = false;
  render();
}

function roomReady() {
  return Boolean(playerId && state.ready && state.phase === 'playing' && !state.winner);
}

function cancelDrag(pointerId) {
  if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
  const capturedPointerId = drag.pointerId;
  drag = undefined;
  if (board.hasPointerCapture?.(capturedPointerId)) {
    board.releasePointerCapture(capturedPointerId);
  }
  render();
}

function addTarget(currentDrag, building) {
  if (!building || building.owner === playerId) return false;
  if (currentDrag.targetBuildingIds.includes(building.id)) return true;
  if (currentDrag.targetBuildingIds.length >= state.rules.maxRouteTargets) {
    setNotice(`一条路线最多指定 ${state.rules.maxRouteTargets} 个敌方建筑。`);
    return false;
  }
  currentDrag.targetBuildingIds.push(building.id);
  const center = buildingCenter(building, state.map);
  currentDrag.points.push(center);
  currentDrag.previewPoint = undefined;
  setNotice(`路线目标：${currentDrag.targetBuildingIds.length}/${state.rules.maxRouteTargets}`);
  return true;
}

board.addEventListener('pointerdown', (event) => {
  if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if (drag || !state.map || !roomReady()) {
    if (!roomReady()) setNotice('等待另一名玩家加入后才能操作。');
    return;
  }
  const point = eventToLogicalPoint(event);
  const obstacle = obstacleAtPoint(state, point);
  if (obstacle) {
    if (cellAtPoint(state.map, point)?.territory === playerId) showClearMenu(obstacle);
    else setNotice('只能清除自己土地上的障碍。');
    return;
  }
  const building = buildingAtPoint(state, point);
  const cell = cellAtPoint(state.map, point);
  if (building && building.owner === playerId && building.type === 'barracks') {
    event.preventDefault();
    closeMenus();
    const start = buildingCenter(building, state.map);
    drag = {
      pointerId: event.pointerId,
      barracks: building,
      points: [start],
      targetBuildingIds: [],
      moved: false
    };
    board.setPointerCapture(event.pointerId);
    render();
    return;
  }
  if (
    cell
    && cell.territory === playerId
    && cell.terrain === 'grass'
    && cell.buildable
    && !cell.blocked
    && !cell.buildingId
    && !cell.obstacleId
  ) {
    showBuildMenu(cell);
    return;
  }
  closeMenus();
  render();
  setNotice('请选择己方绿色空地、已进入领土的障碍，或从自己的兵营拖拽路线。');
});

board.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const point = eventToLogicalPoint(event);
  const clampedPoint = {
    x: Math.max(0, Math.min(1, point.x)),
    y: Math.max(0, Math.min(1, point.y))
  };
  const start = drag.points[0];
  if (Math.hypot(clampedPoint.x - start.x, clampedPoint.y - start.y) >= ROUTE_SAMPLE_DISTANCE) {
    drag.moved = true;
  }
  const target = buildingAtPoint(state, clampedPoint);
  if (target && target.owner !== playerId) {
    if (!drag.targetBuildingIds.includes(target.id)) addTarget(drag, target);
    drag.previewPoint = undefined;
    render();
    return;
  }
  const previous = drag.points.at(-1);
  if (
    Math.hypot(clampedPoint.x - previous.x, clampedPoint.y - previous.y) >= ROUTE_SAMPLE_DISTANCE
    && drag.points.length < state.rules.maxRouteSamples - 1
  ) {
    drag.points.push(clampedPoint);
    drag.previewPoint = undefined;
  } else {
    drag.previewPoint = clampedPoint;
  }
  render();
});

function finishDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const current = drag;
  const point = eventToLogicalPoint(event);
  const finalTarget = buildingAtPoint(state, point);
  if (finalTarget && finalTarget.owner !== playerId) addTarget(current, finalTarget);
  const existingRoute = state.routes.find((route) => route.barracksId === current.barracks.id);
  cancelDrag(event.pointerId);

  if (current.targetBuildingIds.length === 0) {
    if (!current.moved && existingRoute) {
      showRouteMenu(current.barracks);
      setNotice('选择 Cancel 可删除这座兵营的路线，或重新拖拽覆盖。');
    } else {
      setNotice('路线已取消：至少经过一个敌方建筑。');
    }
    return;
  }
  if (!finalTarget || finalTarget.id !== current.targetBuildingIds.at(-1)) {
    setNotice('路线已取消：请在最后一个敌方目标上松开。');
    return;
  }
  send({
    type: 'create_route',
    barracksId: current.barracks.id,
    targetBuildingIds: current.targetBuildingIds,
    points: current.points
  });
}

board.addEventListener('pointerup', finishDrag);
board.addEventListener('pointercancel', (event) => cancelDrag(event.pointerId));
board.addEventListener('lostpointercapture', (event) => cancelDrag(event.pointerId));

buildMenu.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-building]');
  if (!button || !selectedCell || !roomReady()) return;
  send({
    type: 'build',
    row: selectedCell.row,
    column: selectedCell.column,
    buildingType: button.dataset.building
  });
  closeMenus();
  render();
});

clearButton.addEventListener('click', () => {
  if (!selectedObstacle || !roomReady()) return;
  send({ type: 'clear_obstacle', obstacleId: selectedObstacle.id });
  closeMenus();
  render();
});

cancelRouteButton.addEventListener('click', () => {
  if (!selectedBarracks || !roomReady()) return;
  send({ type: 'cancel_route', barracksId: selectedBarracks.id });
  closeMenus();
  render();
});

window.addEventListener('resize', () => {
  resizeCanvas();
  render();
});

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener('open', () => {
    status.textContent = '已连接服务器';
    status.className = 'status connected';
  });
  socket.addEventListener('close', () => {
    status.textContent = '连接已断开，请刷新页面重试';
    status.className = 'status';
    state.ready = false;
    cancelDrag();
    closeMenus();
    render();
  });
  socket.addEventListener('message', ({ data }) => {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === 'welcome') {
      playerId = message.playerId;
      identity.textContent = playerId === 'player1' ? '绿色王国（player1）' : '紫色王国（player2）';
      roomDisplay.textContent = message.roomId;
      return;
    }
    if (message.type === 'game_state') {
      state = applyUnitFacing(message);
      goldDisplay.textContent = state.players[playerId]?.gold ?? '--';
      if (state.winner) {
        battleDisplay.textContent = state.winner === 'draw' ? '平局' : `${state.winner} 胜利`;
        setNotice(state.winner === 'draw'
          ? '双方城堡同时被摧毁，本局平局。'
          : state.winner === playerId
            ? '你摧毁了敌方城堡，获得胜利！'
            : '你的城堡已被摧毁，本局失败。');
        cancelDrag();
        closeMenus();
      } else if (!state.ready || state.phase !== 'playing') {
        battleDisplay.textContent = '等待对手';
        cancelDrag();
      } else {
        const ownUnits = state.units.filter((unit) => unit.owner === playerId).length;
        const enemyUnits = state.units.length - ownUnits;
        battleDisplay.textContent = `交战中 · 我方 ${ownUnits} / 敌方 ${enemyUnits}`;
      }
      render();
      return;
    }
    if (message.type === 'opponent_joined') {
      setNotice('对方已加入。');
    } else if (message.type === 'opponent_left') {
      setNotice('对方已离开房间。');
      state.ready = false;
      cancelDrag();
      closeMenus();
      render();
    } else if (message.type === 'action_rejected' || message.type === 'error') {
      setNotice(message.reason || message.message);
    }
  });
}

createButton.addEventListener('click', () => send({ type: 'create_room' }));
joinButton.addEventListener('click', () => send({ type: 'join_room', roomId: roomInput.value }));
render();
connect();
