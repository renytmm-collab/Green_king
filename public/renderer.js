import { VISUAL_CONFIG } from './visual-config.js';

let canvas;
let context;

export function initializeRenderer(target) { canvas = target; context = canvas.getContext('2d'); resizeCanvas(); }
export function resizeCanvas() {
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1; const width = canvas.clientWidth; const height = width * 9 / 16;
  canvas.style.height = `${height}px`; canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); context.setTransform(ratio, 0, 0, ratio, 0, 0); return { width, height };
}
function size() { return { width: canvas.clientWidth, height: canvas.clientHeight }; }
export function eventToLogicalPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; }
export function cellAtPoint(map, point) { if (!map || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null; const column = Math.min(map.columns - 1, Math.floor(point.x * map.columns)); const row = Math.min(map.rows - 1, Math.floor(point.y * map.rows)); return map.cells[row * map.columns + column]; }
export function buildingAtPoint(state, point) { const cell = cellAtPoint(state.map, point); return cell && cell.buildingId ? state.buildings.find((building) => building.id === cell.buildingId) : null; }
export function buildingCenter(building, map) { return { x: (building.column + building.width / 2) / map.columns, y: (building.row + building.height / 2) / map.rows }; }
function pixels(point) { const { width, height } = size(); return { x: point.x * width, y: point.y * height }; }

export function drawTerritories(map) {
  const { width, height } = size(); const cellWidth = width / map.columns;
  context.save(); context.globalAlpha = VISUAL_CONFIG.territoryAlpha;
  context.fillStyle = '#3283d1'; context.fillRect(0, 0, cellWidth * 6, height);
  context.fillStyle = '#d36a3a'; context.fillRect(width - cellWidth * 6, 0, cellWidth * 6, height);
  context.fillStyle = '#d7c26c'; context.fillRect(cellWidth * 6, 0, cellWidth * (map.columns - 12), height); context.restore();
}
export function drawGrid(map) {
  const { width, height } = size(); context.save(); context.strokeStyle = VISUAL_CONFIG.gridColor; context.lineWidth = 1; context.beginPath();
  for (let column = 0; column <= map.columns; column += 1) { const x = column * width / map.columns; context.moveTo(x, 0); context.lineTo(x, height); }
  for (let row = 0; row <= map.rows; row += 1) { const y = row * height / map.rows; context.moveTo(0, y); context.lineTo(width, y); }
  context.stroke(); context.restore();
}
function buildingRect(building, map) { const { width, height } = size(); return { x: building.column * width / map.columns, y: building.row * height / map.rows, width: building.width * width / map.columns, height: building.height * height / map.rows }; }
function drawLabel(building, map, label, shape = 'rect') {
  const rect = buildingRect(building, map); const ownColor = building.owner === 'player1' ? '#3978c6' : '#d66e3b'; context.save(); context.fillStyle = ownColor; context.strokeStyle = '#263828'; context.lineWidth = 2;
  if (shape === 'circle') { context.beginPath(); context.arc(rect.x + rect.width / 2, rect.y + rect.height / 2, Math.min(rect.width, rect.height) * .34, 0, Math.PI * 2); context.fill(); context.stroke(); } else { const margin = Math.min(rect.width, rect.height) * .13; context.fillRect(rect.x + margin, rect.y + margin, rect.width - margin * 2, rect.height - margin * 2); context.strokeRect(rect.x + margin, rect.y + margin, rect.width - margin * 2, rect.height - margin * 2); }
  context.fillStyle = '#142016'; context.font = VISUAL_CONFIG.font; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2); context.restore();
}
export function drawCastle(building, map) { drawLabel(building, map, '城'); }
export function drawMine(building, map) { drawLabel(building, map, '矿', 'circle'); }
export function drawTower(building, map) { drawLabel(building, map, '塔'); }
export function drawBarracks(building, map) { drawLabel(building, map, '兵'); }
export function drawBuilding(building, map) { ({ castle: drawCastle, mine: drawMine, tower: drawTower, barracks: drawBarracks }[building.type] || drawTower)(building, map); }
function drawPolyline(points, color, dashed = false) { if (!points || points.length < 2) return; context.save(); context.strokeStyle = color; context.lineWidth = VISUAL_CONFIG.routeWidth; context.lineCap = 'round'; context.lineJoin = 'round'; if (dashed) context.setLineDash(VISUAL_CONFIG.routeDash); context.beginPath(); const first = pixels(points[0]); context.moveTo(first.x, first.y); for (const point of points.slice(1)) { const p = pixels(point); context.lineTo(p.x, p.y); } context.stroke(); context.restore(); }
export function drawRoute(route) { drawPolyline(route.points, route.owner === 'player1' ? '#235eaa' : '#b64f25'); }
export function drawTemporaryRoute(points) { drawPolyline(points, '#2f8d55', true); }
export function drawSelection(cell, map) { if (!cell) return; const { width, height } = size(); context.save(); context.strokeStyle = VISUAL_CONFIG.selectionColor; context.lineWidth = 4; context.strokeRect(cell.column * width / map.columns + 2, cell.row * height / map.rows + 2, width / map.columns - 4, height / map.rows - 4); context.restore(); }
export function drawMap(state, selectedCell, temporaryPoints) { const { width, height } = size(); context.clearRect(0, 0, width, height); context.fillStyle = '#d8ead4'; context.fillRect(0, 0, width, height); if (!state.map) return; drawTerritories(state.map); drawGrid(state.map); for (const route of state.routes) drawRoute(route); if (temporaryPoints) drawTemporaryRoute(temporaryPoints); for (const building of state.buildings) drawBuilding(building, state.map); drawSelection(selectedCell, state.map); }
