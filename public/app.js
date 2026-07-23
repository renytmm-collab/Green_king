import {
  initializeRenderer,
  preloadVisualAssets,
  resizeCanvas,
  eventToLogicalPoint,
  cellAtPoint,
  buildingAtPoint,
  obstacleAtPoint,
  coinAtPoint,
  buildingCenter,
  drawMap,
  drawEffects,
  drawSnapMarker,
  setServerTime,
  isConstructing
} from './renderer.js';
import { VISUAL_CONFIG } from './visual-config.js';
import Audio from './audio.js';

const TERRAIN_COLORS = VISUAL_CONFIG.terrainColors;

const board = document.querySelector('#board');
const status = document.querySelector('#connection-status');
const identity = document.querySelector('#identity');
const roomDisplay = document.querySelector('#room-display');
const goldDisplay = document.querySelector('#gold-display');
const battleDisplay = document.querySelector('#battle-display');
const notice = document.querySelector('#notice');
const buildMenu = document.querySelector('#build-menu');
const clearMenu = document.querySelector('#clear-menu');
const clearButton = document.querySelector('#clear-obstacle');
const createButton = document.querySelector('#create-room');
const joinButton = document.querySelector('#join-room');
const exitButton = document.querySelector('#exit-room');
const exitOverlay = document.querySelector('#exit-overlay');
const exitConfirm = document.querySelector('#exit-confirm');
const exitCancel = document.querySelector('#exit-cancel');
const exitRoomLabel = document.querySelector('#exit-room-label');
const lobbyOverlay = document.querySelector('#lobby-overlay');
const lobbyRoom = document.querySelector('#lobby-room');
const lobbyStatus = document.querySelector('#lobby-status');
const lobbyReturn = document.querySelector('#lobby-return');
const lobbyExit = document.querySelector('#lobby-exit');
const upgradeMenu = document.querySelector('#upgrade-menu');
const upgradeCards = document.querySelector('#upgrade-cards');
const upgradeMenuTitle = document.querySelector('#upgrade-menu-title');
const upgradeClose = document.querySelector('#upgrade-close');
const upgradeCancelRoute = document.querySelector('#upgrade-cancel-route');
const upgradeDemolish = document.querySelector('#upgrade-demolish');
const roomInput = document.querySelector('#room-id');
const reconnectBanner = document.querySelector('#reconnect-banner');
const reconnectText = document.querySelector('#reconnect-text');
const cancelReconnectButton = document.querySelector('#cancel-reconnect');
const rematchOverlay = document.querySelector('#rematch-overlay');
const rematchResult = document.querySelector('#rematch-result');
const rematchHint = document.querySelector('#rematch-hint');
const rematchButton = document.querySelector('#rematch-btn');
const mapCards = document.querySelector('#map-cards');
const mapNote = document.querySelector('#map-note');
const mapPicker = document.querySelector('.map-picker');
const soundToggle = document.querySelector('#sound-toggle');
const SOUND_LABEL_ON = '音效：开';
const SOUND_LABEL_OFF = '音效：关';
const MAP_PREF_KEY = 'green_king_map';
let selectedMapId = 'plain';
let mapsCatalog = [];

let rematchRequested = false;
let reconnectTimer = null;
let inLobby = false;

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
  reservations: [],
  routes: [],
  units: []
};
let drag;
let pendingBarracks;
let selectedCell;
let selectedObstacle;
let selectedBuilding;
let animationRequest;
let effects = [];
let lastWinnerAnnounced = null;
const upgradeButtons = new Map();

// Which upgrade tracks are reachable from each building type. Clicking a building
// opens a contextual menu limited to its own tracks.
const BUILDING_UPGRADE_TRACKS = Object.freeze({
  mine: ['mine'],
  tower: ['towerDamage', 'towerRange'],
  barracks: ['barracksRate', 'soldierHp', 'soldierSpeed', 'soldierDamage'],
  castle: ['castleArmor']
});

// How close the drag cursor must be to an existing friendly route to snap/merge.
// About 1.5 cells on a 12x8 board, so players can casually drag near a corridor.
const ROUTE_SNAP_DISTANCE = 0.12;

initializeRenderer(board);
preloadVisualAssets().then(() => render());

function selectMap(mapId) {
  selectedMapId = mapId;
  try { localStorage.setItem(MAP_PREF_KEY, mapId); } catch {}
  if (mapCards) {
    for (const card of mapCards.children) {
      card.classList.toggle('selected', card.dataset.mapId === mapId);
    }
  }
}

function drawMapThumb(canvas, map) {
  if (!canvas || !map || !Array.isArray(map.terrainRows)) return;
  const rows = map.terrainRows.length;
  const cols = map.terrainRows[0].length;
  const cell = 9;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cols * cell * dpr;
  canvas.height = rows * cell * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  // Terrain: '#' = cliff (brown), '.' = neutral grass (yellow).
  for (let r = 0; r < rows; r++) {
    const line = map.terrainRows[r];
    for (let c = 0; c < cols; c++) {
      ctx.fillStyle = line[c] === '#' ? TERRAIN_COLORS.cliff : TERRAIN_COLORS.neutral;
      ctx.fillRect(c * cell, r * cell, cell, cell);
    }
  }

  // Faint grid so the 18×9 lattice reads clearly at small size.
  ctx.strokeStyle = 'rgba(48, 70, 30, 0.18)';
  ctx.lineWidth = 0.5;
  for (let c = 0; c <= cols; c++) {
    ctx.beginPath();
    ctx.moveTo(c * cell, 0);
    ctx.lineTo(c * cell, rows * cell);
    ctx.stroke();
  }
  for (let r = 0; r <= rows; r++) {
    ctx.beginPath();
    ctx.moveTo(0, r * cell);
    ctx.lineTo(cols * cell, r * cell);
    ctx.stroke();
  }

  // Obstacles: trees (green circle) and rocks (gray square).
  if (Array.isArray(map.obstacles)) {
    for (const ob of map.obstacles) {
      const cx = ob.column * cell + cell / 2;
      const cy = ob.row * cell + cell / 2;
      if (ob.type === 'tree') {
        ctx.fillStyle = '#3f6b2f';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = '#8a8a8a';
        ctx.fillRect(cx - cell * 0.32, cy - cell * 0.32, cell * 0.64, cell * 0.64);
      }
    }
  }

  // Castles: player1 (green) and player2 (dark green) markers show the 1v1 mirror.
  const castles = map.castles || {};
  const drawCastle = (pos, color) => {
    if (!pos) return;
    const x = pos.column * cell;
    const y = pos.row * cell;
    ctx.fillStyle = color;
    ctx.fillRect(x + cell * 0.15, y + cell * 0.15, cell * 0.7, cell * 0.7);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + cell * 0.15, y + cell * 0.15, cell * 0.7, cell * 0.7);
  };
  drawCastle(castles.player1, TERRAIN_COLORS.player1);
  drawCastle(castles.player2, TERRAIN_COLORS.player2);
}

function renderMapCards() {
  if (!mapCards) return;
  mapCards.innerHTML = '';
  const preferred = selectedMapId;
  for (const map of mapsCatalog) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'map-card';
    card.dataset.mapId = map.id;
    card.innerHTML = `<canvas class="map-thumb"></canvas><span class="map-name">${map.name}</span><span class="map-desc">${map.description}</span>`;
    card.addEventListener('click', () => selectMap(map.id));
    if (map.id === preferred) card.classList.add('selected');
    mapCards.appendChild(card);
    drawMapThumb(card.querySelector('.map-thumb'), map);
  }
}

function loadMapCatalog() {
  try {
    const saved = localStorage.getItem(MAP_PREF_KEY);
    if (saved) selectedMapId = saved;
  } catch {}
  fetch('/maps')
    .then((response) => (response.ok ? response.json() : null))
    .then((catalog) => {
      if (!catalog || !Array.isArray(catalog.maps) || catalog.maps.length === 0) return;
      mapsCatalog = catalog.maps;
      if (!mapsCatalog.some((map) => map.id === selectedMapId)) {
        selectedMapId = catalog.defaultMapId || mapsCatalog[0].id;
      }
      renderMapCards();
    })
    .catch(() => {});
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
  return pruneRouteBacktracking(points);
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
    const v1x = b.x - a.x;
    const v2x = d.x - c.x;
    if (v1x * v2x >= 0) return null;
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
      break;
    }

    stack.push(next);
  }
  return stack;
}

function scheduleAnimationFrame() {
  if (animationRequest !== undefined) return;
  if (
    !state.ready
    || state.phase !== 'playing'
    || (!state.units?.length && !effects.length && !state.coins?.length
      && !state.buildings.some((building) => isConstructing(building)))
  ) return;
  animationRequest = requestAnimationFrame((animationNow) => {
    animationRequest = undefined;
    render(animationNow);
  });
}

function render(animationNow = performance.now()) {
  let draftPoints;
  if (drag) {
    if (drag.snap) {
      // When snapping to an existing friendly route, preview the full merged
      // corridor so the player sees the shared path before releasing.
      const aRoute = state.routes.find((route) => route.id === drag.snap.routeId);
      if (aRoute) {
        const merged = [...drag.points];
        merged[merged.length - 1] = drag.snap.point;
        merged.push(...aRoute.points.slice(drag.snap.index + 1));
        draftPoints = merged;
      } else {
        draftPoints = [...drag.points, ...(drag.previewPoint ? [drag.previewPoint] : [])];
      }
    } else {
      draftPoints = [...drag.points, ...(drag.previewPoint ? [drag.previewPoint] : [])];
    }
  }
  const temporaryPoints = draftPoints ? orthogonalizePreview(draftPoints, state.map) : undefined;
  drawMap(state, selectedCell, temporaryPoints, animationNow);
  if (drag?.snap) drawSnapMarker(drag.snap.point);
  if (effects.length) {
    drawEffects(effects, state.map, animationNow);
    effects = effects.filter((effect) => animationNow - effect.born < effect.duration + 60);
  }
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
  const priorCell = selectedCell;
  selectedCell = undefined;
  selectedObstacle = undefined;
  selectedBuilding = undefined;
  buildMenu.hidden = true;
  clearMenu.hidden = true;
  upgradeMenu.hidden = true;
  // Releasing the reservation for the cell we were building on. First-click
  // wins, so if another player reserved this cell nothing happens here.
  if (priorCell) send({ type: 'cancel_reservation', row: priorCell.row, column: priorCell.column });
}

function showBuildMenu(cell) {
  closeMenus();
  selectedCell = cell;
  // Reserve this cell the moment the build menu opens, so even if its territory
  // flips to the opponent before we confirm, the build still goes through.
  send({ type: 'reserve_cell', row: cell.row, column: cell.column });
  buildMenu.hidden = false;
  buildMenu.querySelectorAll('button[data-building]').forEach((button) => {
    const type = button.dataset.building;
    const icon = button.querySelector('.build-icon-lg');
    if (icon) icon.src = `/assets/original/buildings/${type}_${playerId}.png`;
    const cost = button.querySelector('.build-cost');
    if (cost) cost.textContent = state.rules.buildingCosts[type] ?? '--';
  });
  placeMenu(buildMenu, cellCenterPoint(cell));
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
  placeMenu(clearMenu, cellCenterPoint(obstacle));
  render();
}

function roomReady() {
  return Boolean(playerId && state.ready && state.phase === 'playing' && !state.winner);
}

function cancelDrag(pointerId) {
  if (drag && (pointerId === undefined || drag.pointerId === pointerId)) {
    const capturedPointerId = drag.pointerId;
    drag = undefined;
    if (board.hasPointerCapture?.(capturedPointerId)) {
      board.releasePointerCapture(capturedPointerId);
    }
  }
  if (pendingBarracks && (pointerId === undefined || pendingBarracks.pointerId === pointerId)) {
    pendingBarracks = undefined;
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

// Position a floating action menu (absolute inside the board wrapper) next to
// the given normalized board point so it never reflows the page.
function placeMenu(menu, point) {
  const boardRect = board.getBoundingClientRect();
  const wrap = board.parentElement;
  if (!wrap) return;
  const wrapRect = wrap.getBoundingClientRect();
  const x = boardRect.left - wrapRect.left + point.x * boardRect.width;
  const y = boardRect.top - wrapRect.top + point.y * boardRect.height;
  const left = Math.max(
    4,
    Math.min(x - menu.offsetWidth / 2, wrapRect.width - menu.offsetWidth - 4)
  );
  const top = Math.max(4, y - menu.offsetHeight - 10);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function cellCenterPoint(cell) {
  return {
    x: (cell.column + 0.5) / state.map.columns,
    y: (cell.row + 0.5) / state.map.rows
  };
}

board.addEventListener('pointerdown', (event) => {
  if (event.isPrimary === false || (event.pointerType === 'mouse' && event.button !== 0)) return;
  if (drag || !state.map || !roomReady()) {
    if (!roomReady()) setNotice('等待另一名玩家加入后才能操作。');
    return;
  }
  const point = eventToLogicalPoint(event);
  // Neutral gold pickups are contested — clicking one claims it before any
  // build / route interaction is considered.
  const coin = coinAtPoint(state, point);
  if (coin) {
    Audio.resume();
    send({ type: 'collect_coin', coinId: coin.id });
    return;
  }
  const obstacle = obstacleAtPoint(state, point);
  if (obstacle) {
    if (cellAtPoint(state.map, point)?.territory === playerId) showClearMenu(obstacle);
    else setNotice('只能清除自己土地上的障碍。');
    return;
  }
  const building = buildingAtPoint(state, point);
  const cell = cellAtPoint(state.map, point);
  // Re-clicking the cell we already have a build menu (and reservation) open on
  // keeps the menu and the reservation intact, even after its territory flips.
  if (
    selectedCell
    && cell
    && cell.row === selectedCell.row
    && cell.column === selectedCell.column
  ) return;
  if (building && building.owner === playerId) {
    if (building.type === 'barracks') {
      // A press on a barracks is ambiguous: a drag draws a route, a tap opens
      // the contextual upgrade menu. We defer the decision until pointermove
      // crosses the drag threshold (see the pointermove handler).
      event.preventDefault();
      pendingBarracks = { building, pointerId: event.pointerId, start: point };
      return;
    }
    if (BUILDING_UPGRADE_TRACKS[building.type]) {
      event.preventDefault();
      showUpgradeMenu(building);
      return;
    }
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
    // A cell the opponent grabbed first cannot be claimed by us, even if it is
    // still (or has become) our territory.
    const reservation = state.reservations
      ?.find((entry) => entry.row === cell.row && entry.column === cell.column);
    if (reservation && reservation.owner !== playerId) {
      setNotice('该格子已被对方预留。');
      render();
      return;
    }
    showBuildMenu(cell);
    return;
  }
  closeMenus();
  render();
  setNotice('请选择己方绿色空地、已进入领土的障碍，或从自己的兵营拖拽路线。');
});

board.addEventListener('pointermove', (event) => {
  if (pendingBarracks && pendingBarracks.pointerId === event.pointerId) {
    const point = eventToLogicalPoint(event);
    const start = pendingBarracks.start;
    if (Math.hypot(point.x - start.x, point.y - start.y) >= ROUTE_SAMPLE_DISTANCE) {
      const building = pendingBarracks.building;
      pendingBarracks = undefined;
      drag = {
        pointerId: event.pointerId,
        barracks: building,
        points: [buildingCenter(building, state.map)],
        targetBuildingIds: [],
        moved: true,
        snap: undefined
      };
      board.setPointerCapture(event.pointerId);
      render();
    } else {
      return;
    }
  }
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
  computeDragSnap(clampedPoint);
  render();
});

// Project `point` onto the line segment from `a` to `b` and return the closest
// point on that segment together with its squared distance.
function projectPointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return { projection: a, distance: Math.hypot(point.x - a.x, point.y - a.y) };
  let t = ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared;
  t = Math.max(0, Math.min(1, t));
  const projection = { x: a.x + t * dx, y: a.y + t * dy };
  return { projection, distance: Math.hypot(point.x - projection.x, point.y - projection.y) };
}

// Detect whether the in-progress route drag is close enough to an existing
// friendly route to snap onto it. If so, the drag "merges" into that route at
// the nearest point on the corridor (true shared corridor), inheriting its targets.
function computeDragSnap(point) {
  drag.snap = undefined;
  if (!drag.barracks) return;
  let best;
  for (const route of state.routes) {
    if (route.owner !== playerId || route.barracksId === drag.barracks.id) continue;
    if (!route.points || route.points.length < 2) continue;
    for (let index = 0; index < route.points.length - 1; index += 1) {
      const a = route.points[index];
      const b = route.points[index + 1];
      const { projection, distance } = projectPointToSegment(point, a, b);
      if (distance <= ROUTE_SNAP_DISTANCE && (!best || distance < best.distance)) {
        best = { routeId: route.id, index, point: projection, distance };
      }
    }
  }
  if (best) {
    drag.snap = best;
    drag.previewPoint = best.point;
  }
}

function finishDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const current = drag;
  const point = eventToLogicalPoint(event);
  const finalTarget = buildingAtPoint(state, point);
  if (finalTarget && finalTarget.owner !== playerId) addTarget(current, finalTarget);
  const existingRoute = state.routes.find((route) => route.barracksId === current.barracks.id);
  cancelDrag(event.pointerId);

  // Merged route: the drag snapped onto an existing friendly route, so the new
  // route reuses that route's tail and targets (a shared corridor).
  if (current.snap) {
    const aRoute = state.routes.find((route) => route.id === current.snap.routeId);
    if (!aRoute) {
      setNotice('合并失败：原路线已不存在，请重新拖拽。');
      return;
    }
    const combined = current.points.slice();
    combined[combined.length - 1] = current.snap.point;
    combined.push(...aRoute.points.slice(current.snap.index + 1));
    send({
      type: 'create_route',
      barracksId: current.barracks.id,
      targetBuildingIds: [...aRoute.targetBuildingIds],
      points: combined
    });
    Audio.play('route');
    setNotice('已并入原有路线，两侧士兵将共用该通道。');
    return;
  }

  if (current.targetBuildingIds.length === 0) {
    if (!current.moved && existingRoute) {
      showUpgradeMenu(current.barracks);
      setNotice('可在建筑旁升级；重新拖拽可覆盖原路线。');
    } else {
      setNotice('路线已取消：至少经过一个敌方建筑，或靠近另一条己方路线并入。');
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
  Audio.play('route');
}

board.addEventListener('pointerup', (event) => {
  if (pendingBarracks && pendingBarracks.pointerId === event.pointerId) {
    const building = pendingBarracks.building;
    pendingBarracks = undefined;
    showUpgradeMenu(building);
  }
});
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
  Audio.play('build');
  closeMenus();
  render();
});

clearButton.addEventListener('click', () => {
  if (!selectedObstacle || !roomReady()) return;
  send({ type: 'clear_obstacle', obstacleId: selectedObstacle.id });
  Audio.play('clear');
  closeMenus();
  render();
});

upgradeClose.addEventListener('click', () => { closeMenus(); render(); });
upgradeCancelRoute.addEventListener('click', () => {
  if (!selectedBuilding || selectedBuilding.type !== 'barracks' || !roomReady()) return;
  send({ type: 'cancel_route', barracksId: selectedBuilding.id });
  closeMenus();
  render();
});
upgradeDemolish.addEventListener('click', () => {
  if (!selectedBuilding || selectedBuilding.type === 'castle' || !roomReady()) return;
  Audio.resume();
  Audio.play('building_destroyed');
  send({ type: 'demolish_building', buildingId: selectedBuilding.id });
  closeMenus();
  render();
});

window.addEventListener('resize', () => {
  resizeCanvas();
  if (!buildMenu.hidden && selectedCell) {
    placeMenu(buildMenu, cellCenterPoint(selectedCell));
  }
  if (!clearMenu.hidden && selectedObstacle) {
    placeMenu(clearMenu, cellCenterPoint(selectedObstacle));
  }
  if (!upgradeMenu.hidden && selectedBuilding) {
    placeMenu(upgradeMenu, buildingCenter(selectedBuilding, state.map));
  }
  render();
});

const SAVE_KEY = 'green_king_room';
function saveRoom(roomId, pid) {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify({ roomId, playerId: pid })); } catch {}
}
function loadSavedRoom() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return null; }
}
function clearSavedRoom() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
}
function showReconnectBanner(roomId) {
  if (!reconnectBanner) return;
  if (reconnectText) reconnectText.textContent = `正在重连房间 ${roomId}…`;
  reconnectBanner.hidden = false;
}
function hideReconnectBanner() {
  if (reconnectBanner) reconnectBanner.hidden = true;
}
function updateRematchOverlay() {
  if (!rematchOverlay) return;
  if (state.winner) {
    rematchOverlay.hidden = false;
    const won = state.winner === playerId;
    if (rematchResult) rematchResult.textContent = state.winner === 'draw' ? '平局' : (won ? '你胜利了！' : '你失败了');
    if (rematchHint) rematchHint.textContent = rematchRequested
      ? '已请求再来一局，等待对方确认…'
      : '点击「再来一局」，双方确认后重开。';
    if (rematchButton) rematchButton.disabled = rematchRequested;
  } else {
    rematchOverlay.hidden = true;
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}`);
  socket.addEventListener('open', () => {
    status.textContent = '已连接服务器';
    status.className = 'status connected';
    const saved = loadSavedRoom();
    if (saved && saved.roomId) {
      showReconnectBanner(saved.roomId);
      send({ type: 'rejoin_room', roomId: saved.roomId, playerId: saved.playerId });
    }
  });
  socket.addEventListener('close', () => {
    status.textContent = '连接已断开，正在重连…';
    status.className = 'status';
    state.ready = false;
    cancelDrag();
    closeMenus();
    render();
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 1500);
    }
  });
  socket.addEventListener('message', onMessage);
}

function handleGameEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return;
  const now = performance.now();
  for (const ev of events) {
    if (ev.type === 'tower_fire') {
      effects.push({ kind: 'projectile', from: ev.from, to: ev.to, owner: ev.owner, born: now, duration: 220 });
      Audio.play('tower_fire');
    } else if (ev.type === 'explosion') {
      effects.push({ kind: 'explosion', x: ev.x, y: ev.y, owner: ev.owner, born: now, duration: 450 });
      Audio.play('explosion');
    } else if (ev.type === 'building_destroyed') {
      effects.push({ kind: 'building_destroyed', x: ev.x, y: ev.y, owner: ev.owner, born: now, duration: 550 });
      Audio.play('building_destroyed');
    } else if (ev.type === 'castle_destroyed') {
      effects.push({ kind: 'castle_destroyed', x: ev.x, y: ev.y, owner: ev.owner, born: now, duration: 800 });
      Audio.play('castle_destroyed');
    } else if (ev.type === 'coin_collect') {
      effects.push({ kind: 'explosion', x: ev.x, y: ev.y, owner: ev.owner, born: now, duration: 320 });
      Audio.play('coin');
    }
  }
  if (effects.length) render(now);
}

const BUILDING_LABELS = { mine: '矿场', tower: '防御塔', barracks: '兵营', castle: '城堡' };

function showUpgradeMenu(building) {
  if (!roomReady()) {
    setNotice('等待另一名玩家加入后才能升级。');
    return;
  }
  closeMenus();
  selectedBuilding = building;
  const tracks = BUILDING_UPGRADE_TRACKS[building.type] || [];
  upgradeMenuTitle.textContent = `${BUILDING_LABELS[building.type] || '建筑'}升级`;
  upgradeCards.innerHTML = '';
  upgradeButtons.clear();
  for (const trackId of tracks) {
    const track = state.rules.upgrades?.[trackId];
    if (!track) continue;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'upg-card';
    card.dataset.track = trackId;
    card.title = track.hint || '';
    card.innerHTML = `<span class="upg-name">${track.name}</span><span class="upg-lv">Lv 0/${track.maxLevel}</span><span class="upg-cost">${track.baseCost}</span>`;
    card.addEventListener('click', () => {
      if (!roomReady()) return;
      Audio.resume();
      Audio.play('upgrade');
      send({ type: 'upgrade', track: trackId });
    });
    upgradeCards.appendChild(card);
    upgradeButtons.set(trackId, card);
  }
  const existingRoute = state.routes.find((route) => route.barracksId === building.id);
  upgradeCancelRoute.hidden = building.type !== 'barracks';
  upgradeCancelRoute.disabled = !existingRoute;
  upgradeCancelRoute.querySelector('.route-label').textContent = existingRoute ? '取消路线' : '无路线';
  upgradeDemolish.hidden = building.type === 'castle';
  upgradeMenu.hidden = false;
  placeMenu(upgradeMenu, buildingCenter(building, state.map));
  updateUpgradeMenu();
  render();
}

function updateUpgradeMenu() {
  if (upgradeMenu.hidden || !playerId || !state.rules?.upgrades) return;
  const myUpgrades = state.players[playerId]?.upgrades || {};
  const gold = state.players[playerId]?.gold ?? 0;
  for (const [trackId, button] of upgradeButtons) {
    const track = state.rules.upgrades[trackId];
    const level = myUpgrades[trackId] || 0;
    const maxed = level >= track.maxLevel;
    const cost = maxed ? 0 : track.baseCost + track.costStep * level;
    button.querySelector('.upg-lv').textContent = `Lv ${level}/${track.maxLevel}`;
    button.querySelector('.upg-cost').textContent = maxed ? '满级' : `${cost}`;
    button.classList.toggle('maxed', maxed);
    const affordable = !maxed && gold >= cost;
    button.disabled = !affordable;
    button.classList.toggle('affordable', affordable);
  }
}

function onMessage({ data }) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }
  if (message.type === 'welcome') {
    playerId = message.playerId;
    saveRoom(message.roomId, message.playerId);
    hideReconnectBanner();
    lastWinnerAnnounced = null;
    identity.textContent = playerId === 'player1' ? '绿色王国（player1）' : '紫色王国（player2）';
    const mapLabel = message.mapName ? ` · ${message.mapName}` : '';
    roomDisplay.textContent = `${message.roomId}${mapLabel}`;
    // The map is fixed by the host at creation time; hide the picker once in a room.
    if (mapPicker) mapPicker.hidden = true;
    if (exitButton) exitButton.hidden = false;
    return;
  }
  if (message.type === 'game_state') {
    state = applyUnitFacing(message);
    if (typeof state.serverTime === 'number') setServerTime(state.serverTime);
    if (selectedBuilding && !state.buildings.some((building) => building.id === selectedBuilding.id)) {
      closeMenus();
    }
    handleGameEvents(message.events);
    if (!state.winner) rematchRequested = false;
    goldDisplay.textContent = state.players[playerId]?.gold ?? '--';
    if (state.winner) {
      battleDisplay.textContent = state.winner === 'draw' ? '平局' : `${state.winner} 胜利`;
      setNotice(state.winner === 'draw'
        ? '双方城堡同时被摧毁，本局平局。'
        : state.winner === playerId
          ? '你摧毁了敌方城堡，获得胜利！'
          : '你的城堡已被摧毁，本局失败。');
      if (lastWinnerAnnounced !== state.winner) {
        lastWinnerAnnounced = state.winner;
        Audio.play(state.winner === 'draw' ? 'lose' : (state.winner === playerId ? 'win' : 'lose'));
      }
      cancelDrag();
      closeMenus();
    } else {
      lastWinnerAnnounced = null;
      if (!state.ready || state.phase !== 'playing') {
        battleDisplay.textContent = '等待对手';
        cancelDrag();
      } else {
        const ownUnits = state.units.filter((unit) => unit.owner === playerId).length;
        const enemyUnits = state.units.length - ownUnits;
        battleDisplay.textContent = `交战中 · 我方 ${ownUnits} / 敌方 ${enemyUnits}`;
      }
    }
    updateUpgradeMenu();
    updateRematchOverlay();
    if (inLobby) updateLobbyStatus();
    render();
    return;
  }
  if (message.type === 'game_reset') {
    rematchRequested = false;
    hideReconnectBanner();
    lastWinnerAnnounced = null;
    setNotice('新一局已开始！');
    closeMenus();
    cancelDrag();
    updateRematchOverlay();
    return;
  }
  if (message.type === 'rematch_pending') {
    setNotice('对方请求再来一局，点击「再来一局」确认。');
    updateRematchOverlay();
    return;
  }
  if (message.type === 'opponent_joined') {
    setNotice('对方已加入 / 重连。');
  } else if (message.type === 'room_closed') {
    returnToLobby();
  } else if (message.type === 'opponent_in_lobby') {
    setNotice('对手已返回大厅，对局仍在继续。');
  } else if (message.type === 'opponent_returned') {
    setNotice('对手已返回对局。');
  } else if (message.type === 'opponent_left') {
    setNotice('对方已断开，等待其重连…');
    state.ready = false;
    cancelDrag();
    closeMenus();
    if (inLobby) updateLobbyStatus();
    render();
  } else if (message.type === 'error') {
    if (typeof message.message === 'string' && message.message.startsWith('Room not found')) {
      clearSavedRoom();
      hideReconnectBanner();
      setNotice('原房间已不存在（可能已结束或服务端重启），请创建或加入新房间。');
    } else {
      setNotice(message.message || message.reason);
    }
  } else if (message.type === 'action_rejected') {
    setNotice(message.reason || message.message);
  }
}

createButton.addEventListener('click', () => { Audio.resume(); send({ type: 'create_room', mapId: selectedMapId }); });
joinButton.addEventListener('click', () => { Audio.resume(); send({ type: 'join_room', roomId: roomInput.value }); });
if (soundToggle) {
  soundToggle.textContent = Audio.isMuted() ? SOUND_LABEL_OFF : SOUND_LABEL_ON;
  soundToggle.addEventListener('click', () => {
    const muted = Audio.toggleMute();
    soundToggle.textContent = muted ? SOUND_LABEL_OFF : SOUND_LABEL_ON;
    soundToggle.classList.toggle('off', muted);
    if (!muted) Audio.play('upgrade');
  });
}
if (rematchButton) {
  rematchButton.addEventListener('click', () => {
    rematchRequested = true;
    send({ type: 'rematch' });
    updateRematchOverlay();
  });
}
if (cancelReconnectButton) {
  cancelReconnectButton.addEventListener('click', () => {
    clearSavedRoom();
    hideReconnectBanner();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    setNotice('已取消重连，可创建或加入新房间。');
  });
}

function returnToLobby() {
  playerId = undefined;
  inLobby = false;
  state = {
    ready: false,
    phase: 'waiting',
    winner: null,
    rules: { buildingCosts: {}, clearCosts: {}, maxRouteTargets: 3, maxRouteSamples: 160 },
    players: {},
    map: null,
    buildings: [],
    obstacles: [],
    reservations: [],
    routes: [],
    units: [],
    coins: []
  };
  cancelDrag();
  closeMenus();
  if (rematchOverlay) rematchOverlay.hidden = true;
  if (exitOverlay) exitOverlay.hidden = true;
  if (lobbyOverlay) lobbyOverlay.hidden = true;
  hideReconnectBanner();
  identity.textContent = '未分配';
  roomDisplay.textContent = '未加入';
  goldDisplay.textContent = '--';
  battleDisplay.textContent = '等待对手';
  if (mapPicker) mapPicker.hidden = false;
  if (exitButton) exitButton.hidden = true;
  setNotice('已返回大厅。');
  render();
}

// Soft "return to lobby": keep the room and live match on the server, just move
// this client's view to the lobby panel. The player can resume any time.
function enterLobbyView() {
  inLobby = true;
  cancelDrag();
  closeMenus();
  if (rematchOverlay) rematchOverlay.hidden = true;
  if (exitOverlay) exitOverlay.hidden = true;
  if (lobbyRoom) lobbyRoom.textContent = roomDisplay.textContent || '—';
  if (lobbyOverlay) lobbyOverlay.hidden = false;
  if (exitButton) exitButton.hidden = true;
  updateLobbyStatus();
  setNotice('已返回大厅，房间保留（对手继续对局）。');
  render();
}

// Resume from the lobby back into the live match.
function returnToBoard() {
  inLobby = false;
  if (lobbyOverlay) lobbyOverlay.hidden = true;
  if (exitButton) exitButton.hidden = false;
  send({ type: 'return_to_board' });
  setNotice('已返回对局。');
  render();
}

function updateLobbyStatus() {
  if (!lobbyStatus) return;
  if (state.winner) {
    lobbyStatus.textContent = state.winner === 'draw'
      ? '本局已平局。'
      : (state.winner === playerId ? '你已获胜！' : '你的城堡已被摧毁，本局失败。');
  } else if (!state.ready || state.phase !== 'playing') {
    lobbyStatus.textContent = '等待对手加入…';
  } else {
    const ownUnits = (state.units || []).filter((unit) => unit.owner === playerId).length;
    const enemyUnits = (state.units || []).length - ownUnits;
    lobbyStatus.textContent = `交战中 · 我方 ${ownUnits} / 敌方 ${enemyUnits}`;
  }
}

if (exitButton) {
  exitButton.addEventListener('click', () => {
    if (exitRoomLabel) exitRoomLabel.textContent = roomDisplay.textContent || '—';
    if (exitOverlay) exitOverlay.hidden = false;
  });
}
if (exitConfirm) {
  exitConfirm.addEventListener('click', () => {
    if (exitOverlay) exitOverlay.hidden = true;
    send({ type: 'return_to_lobby' });
    enterLobbyView();
  });
}
if (exitCancel) {
  exitCancel.addEventListener('click', () => { if (exitOverlay) exitOverlay.hidden = true; });
}
if (lobbyReturn) {
  lobbyReturn.addEventListener('click', () => returnToBoard());
}
if (lobbyExit) {
  lobbyExit.addEventListener('click', () => {
    if (lobbyOverlay) lobbyOverlay.hidden = true;
    send({ type: 'leave_room' });
    returnToLobby();
  });
}

render();
loadMapCatalog();
connect();
