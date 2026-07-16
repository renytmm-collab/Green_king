import { VISUAL_CONFIG, ASSET_MANIFEST } from './visual-config.js';

let canvas;
let context;
const imageCache = new Map();

function manifestEntries() {
  const entries = [];
  for (const owners of Object.values(ASSET_MANIFEST.buildings)) {
    entries.push(...Object.values(owners));
  }
  entries.push(...Object.values(ASSET_MANIFEST.obstacles));
  for (const directions of Object.values(ASSET_MANIFEST.units)) {
    entries.push(...Object.values(directions));
  }
  return entries;
}

function preloadAsset(config) {
  const existing = imageCache.get(config.src);
  if (existing) return existing.promise;
  const image = new Image();
  const record = { image, status: 'loading', promise: undefined };
  record.promise = new Promise((resolve) => {
    image.addEventListener('load', () => {
      record.status = 'loaded';
      resolve(record);
    }, { once: true });
    image.addEventListener('error', () => {
      record.status = 'failed';
      resolve(record);
    }, { once: true });
  });
  imageCache.set(config.src, record);
  image.src = config.src;
  return record.promise;
}

export function preloadVisualAssets() {
  if (typeof Image === 'undefined') return Promise.resolve([]);
  return Promise.all(manifestEntries().map(preloadAsset));
}

export function initializeRenderer(target) {
  canvas = target;
  context = canvas.getContext('2d');
  context.imageSmoothingEnabled = true;
  resizeCanvas();
}

export function resizeCanvas() {
  if (!canvas) return undefined;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = width * 9 / 16;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { width, height };
}

function size() {
  return { width: canvas.clientWidth, height: canvas.clientHeight };
}

export function eventToLogicalPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height
  };
}

export function cellAtPoint(map, point) {
  if (!map || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  const column = Math.min(map.columns - 1, Math.floor(point.x * map.columns));
  const row = Math.min(map.rows - 1, Math.floor(point.y * map.rows));
  return map.cells[row * map.columns + column];
}

export function buildingAtPoint(state, point) {
  const cell = cellAtPoint(state.map, point);
  return cell?.buildingId
    ? state.buildings.find((building) => building.id === cell.buildingId) || null
    : null;
}

export function obstacleAtPoint(state, point) {
  const cell = cellAtPoint(state.map, point);
  return cell?.obstacleId
    ? state.obstacles.find((obstacle) => obstacle.id === cell.obstacleId) || null
    : null;
}

export function buildingCenter(building, map) {
  return {
    x: (building.column + building.width / 2) / map.columns,
    y: (building.row + building.height / 2) / map.rows
  };
}

function pixels(point) {
  const { width, height } = size();
  return { x: point.x * width, y: point.y * height };
}

function cellRect(cell, map) {
  const { width, height } = size();
  return {
    x: cell.column * width / map.columns,
    y: cell.row * height / map.rows,
    width: width / map.columns,
    height: height / map.rows
  };
}

export function drawTerrain(map) {
  const { width, height } = size();
  context.fillStyle = VISUAL_CONFIG.terrainColors.cliff;
  context.fillRect(0, 0, width, height);
  for (const cell of map.cells) {
    if (cell.terrain === 'cliff') continue;
    const rect = cellRect(cell, map);
    context.fillStyle = VISUAL_CONFIG.terrainColors[cell.territory];
    context.fillRect(rect.x, rect.y, rect.width + 0.5, rect.height + 0.5);
    context.fillStyle = (cell.row + cell.column) % 2 === 0
      ? VISUAL_CONFIG.tileLightOverlay
      : VISUAL_CONFIG.tileDarkOverlay;
    context.fillRect(rect.x, rect.y, rect.width + 0.5, rect.height + 0.5);
    context.strokeStyle = VISUAL_CONFIG.tileGridColor;
    context.lineWidth = 1;
    context.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
  }
  context.save();
  context.strokeStyle = VISUAL_CONFIG.terrainEdgeColor;
  context.lineWidth = 7;
  context.strokeRect(3.5, 3.5, width - 7, height - 7);
  context.strokeStyle = 'rgba(255, 218, 151, 0.24)';
  context.lineWidth = 2;
  context.strokeRect(8, 8, width - 16, height - 16);
  context.restore();
}

function objectRect(object, map) {
  const cell = { row: object.row, column: object.column };
  return cellRect(cell, map);
}

function resolveAssetFrame(config, rect, frameIndex = 0) {
  const record = config ? imageCache.get(config.src) : undefined;
  if (record?.status !== 'loaded' || record.image.naturalWidth === 0) return undefined;
  const image = record.image;
  const frameWidth = config.frameWidth || image.naturalWidth;
  const frameHeight = config.frameHeight || image.naturalHeight;
  const columns = config.columns || 1;
  const frameCount = config.frameCount || 1;
  const safeFrame = ((frameIndex % frameCount) + frameCount) % frameCount;
  const sourceX = (safeFrame % columns) * frameWidth;
  const sourceY = Math.floor(safeFrame / columns) * frameHeight;
  let width = rect.width * (config.scale || 1);
  let height = width * frameHeight / frameWidth;
  const maxHeight = rect.height * (config.maxHeightCells || Number.POSITIVE_INFINITY);
  if (height > maxHeight) {
    width *= maxHeight / height;
    height = maxHeight;
  }
  const x = rect.x + rect.width / 2 - width * (config.anchorX ?? 0.5);
  const y = rect.y + rect.height * (config.baselineY ?? 1) - height * (config.anchorY ?? 1);
  return {
    image,
    sourceX,
    sourceY,
    frameWidth,
    frameHeight,
    x,
    y,
    width,
    height
  };
}

function drawAsset(config, rect, frameIndex = 0) {
  const frame = resolveAssetFrame(config, rect, frameIndex);
  if (!frame) return false;
  context.drawImage(
    frame.image,
    frame.sourceX,
    frame.sourceY,
    frame.frameWidth,
    frame.frameHeight,
    frame.x,
    frame.y,
    frame.width,
    frame.height
  );
  return true;
}

function drawLabel(building, map, label, shape = 'rect') {
  const rect = objectRect(building, map);
  const asset = ASSET_MANIFEST.buildings[building.type]?.[building.owner];
  if (drawAsset(asset, rect)) return;
  const ownColor = building.owner === 'player1' ? '#3f8f4c' : '#9b7640';
  const scale = VISUAL_CONFIG.buildingScale;
  const marginX = rect.width * (1 - scale) / 2;
  const marginY = rect.height * (1 - scale) / 2;
  context.save();
  context.fillStyle = ownColor;
  context.strokeStyle = '#273526';
  context.lineWidth = 2;
  if (shape === 'circle') {
    context.beginPath();
    context.arc(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
      Math.min(rect.width, rect.height) * scale / 2,
      0,
      Math.PI * 2
    );
    context.fill();
    context.stroke();
  } else {
    context.fillRect(
      rect.x + marginX,
      rect.y + marginY,
      rect.width - marginX * 2,
      rect.height - marginY * 2
    );
    context.strokeRect(
      rect.x + marginX,
      rect.y + marginY,
      rect.width - marginX * 2,
      rect.height - marginY * 2
    );
  }
  context.fillStyle = '#f5f1d8';
  context.font = `bold ${Math.max(10, Math.min(rect.width, rect.height) * VISUAL_CONFIG.fontScale)}px system-ui`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(label, rect.x + rect.width / 2, rect.y + rect.height / 2);
  context.restore();
}

export function drawCastle(building, map) {
  drawLabel(building, map, '城');
}

export function drawMine(building, map) {
  drawLabel(building, map, '矿', 'circle');
}

export function drawTower(building, map) {
  drawLabel(building, map, '塔');
}

export function drawBarracks(building, map) {
  drawLabel(building, map, '兵');
}

function drawBuildingBody(building, map) {
  const drawingFunction = {
    castle: drawCastle,
    mine: drawMine,
    tower: drawTower,
    barracks: drawBarracks
  }[building.type];
  if (drawingFunction) drawingFunction(building, map);
}

function drawBuildingHealth(building, map) {
  const rect = objectRect(building, map);
  const asset = ASSET_MANIFEST.buildings[building.type]?.[building.owner];
  const bounds = resolveAssetFrame(asset, rect);
  const fallbackY = rect.y + rect.height * 0.06;
  const healthY = bounds
    ? Math.max(2, bounds.y - VISUAL_CONFIG.healthBarGap - VISUAL_CONFIG.healthBarHeight)
    : fallbackY;
  drawHealthBar(
    rect.x + rect.width * 0.12,
    healthY,
    rect.width * 0.76,
    building.hp / building.maxHp
  );
}

export function drawBuilding(building, map, includeHealth = true) {
  drawBuildingBody(building, map);
  if (includeHealth) drawBuildingHealth(building, map);
}

function drawHealthBar(x, y, width, ratio) {
  const clampedRatio = Math.max(0, Math.min(1, ratio || 0));
  context.save();
  context.fillStyle = 'rgba(32, 25, 20, 0.72)';
  context.fillRect(x - 1, y - 1, width + 2, VISUAL_CONFIG.healthBarHeight + 2);
  context.fillStyle = '#de3d35';
  context.fillRect(x, y, width * clampedRatio, VISUAL_CONFIG.healthBarHeight);
  context.restore();
}

function stableAnimationOffset(id, frameCount) {
  let hash = 0;
  for (const character of String(id)) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % frameCount;
}

function unitFrame(unit, asset, animationNow) {
  const elapsedFrame = Math.floor(animationNow * asset.fps / 1000);
  return (elapsedFrame + stableAnimationOffset(unit.id, asset.frameCount)) % asset.frameCount;
}

export function drawUnit(unit, map, animationNow = performance.now()) {
  const point = pixels(unit);
  const { width, height } = size();
  const cellWidth = width / map.columns;
  const cellHeight = height / map.rows;
  const cellSize = Math.min(cellWidth, cellHeight);
  const radius = cellSize * VISUAL_CONFIG.unitRadius;
  const direction = unit.facing === 'left' || unit.facing === 'right'
    ? unit.facing
    : unit.owner === 'player1' ? 'right' : 'left';
  const asset = ASSET_MANIFEST.units[unit.owner]?.[direction];
  const spriteRect = {
    x: point.x - cellWidth / 2,
    y: point.y - cellHeight / 2,
    width: cellWidth,
    height: cellHeight
  };
  const drewSprite = asset
    ? drawAsset(asset, spriteRect, unitFrame(unit, asset, animationNow))
    : false;
  if (!drewSprite) {
    context.save();
    const facing = unit.owner === 'player1' ? 1 : -1;
    context.fillStyle = 'rgba(35, 30, 20, 0.28)';
    context.beginPath();
    context.ellipse(point.x, point.y + radius * 0.75, radius * 0.9, radius * 0.42, 0, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = VISUAL_CONFIG.unitColors[unit.owner];
    context.strokeStyle = '#26351f';
    context.lineWidth = 1.4;
    context.beginPath();
    context.ellipse(point.x, point.y + radius * 0.2, radius * 0.78, radius, 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = '#e9bd82';
    context.beginPath();
    context.arc(point.x + facing * radius * 0.25, point.y - radius * 0.65, radius * 0.45, 0, Math.PI * 2);
    context.fill();
    context.stroke();
    context.fillStyle = VISUAL_CONFIG.unitColors[unit.owner];
    context.beginPath();
    context.ellipse(
      point.x + facing * radius * 0.1,
      point.y - radius * 0.98,
      radius * 0.64,
      radius * 0.3,
      -facing * 0.12,
      0,
      Math.PI * 2
    );
    context.fill();
    context.stroke();
    context.strokeStyle = '#68492f';
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(point.x + facing * radius * 0.55, point.y);
    context.lineTo(point.x + facing * radius * 1.55, point.y - radius * 0.35);
    context.stroke();
    context.restore();
  }
}

function drawUnitHealth(unit, map) {
  const point = pixels(unit);
  const { width, height } = size();
  const cellWidth = width / map.columns;
  const cellHeight = height / map.rows;
  const direction = unit.facing === 'left' || unit.facing === 'right'
    ? unit.facing
    : unit.owner === 'player1' ? 'right' : 'left';
  const asset = ASSET_MANIFEST.units[unit.owner]?.[direction];
  const spriteRect = {
    x: point.x - cellWidth / 2,
    y: point.y - cellHeight / 2,
    width: cellWidth,
    height: cellHeight
  };
  const bounds = resolveAssetFrame(asset, spriteRect);
  const fallbackY = point.y - cellHeight * 0.36;
  const healthY = bounds
    ? Math.max(2, bounds.y - VISUAL_CONFIG.healthBarGap - VISUAL_CONFIG.healthBarHeight)
    : fallbackY;
  drawHealthBar(
    point.x - cellWidth * 0.24,
    healthY,
    cellWidth * 0.48,
    unit.hp / unit.maxHp
  );
}

export function drawObstacle(obstacle, map) {
  const rect = objectRect(obstacle, map);
  if (drawAsset(ASSET_MANIFEST.obstacles[obstacle.type], rect)) return;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  context.save();
  if (obstacle.type === 'tree') {
    context.fillStyle = '#65462d';
    context.fillRect(centerX - rect.width * 0.08, centerY, rect.width * 0.16, rect.height * 0.3);
    context.fillStyle = '#2f6f35';
    context.beginPath();
    context.arc(centerX, centerY - rect.height * 0.08, Math.min(rect.width, rect.height) * 0.32, 0, Math.PI * 2);
    context.fill();
  } else {
    context.fillStyle = '#77786f';
    context.strokeStyle = '#494b46';
    context.lineWidth = 2;
    context.beginPath();
    context.ellipse(centerX, centerY, rect.width * 0.3, rect.height * 0.24, -0.2, 0, Math.PI * 2);
    context.fill();
    context.stroke();
  }
  context.restore();
}

function drawPolyline(points, color, dash, glow = false) {
  if (!points || points.length < 2) return;
  context.save();
  context.strokeStyle = color;
  context.lineWidth = VISUAL_CONFIG.routeLineWidth;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.setLineDash(dash);
  if (glow) {
    context.shadowColor = color;
    context.shadowBlur = 4;
  }
  context.beginPath();
  const first = pixels(points[0]);
  context.moveTo(first.x, first.y);
  for (const point of points.slice(1)) {
    const pixel = pixels(point);
    context.lineTo(pixel.x, pixel.y);
  }
  context.stroke();
  context.restore();
}

export function drawRoute(route) {
  drawPolyline(
    route.points,
    VISUAL_CONFIG.routeColor,
    VISUAL_CONFIG.routeDash,
    true
  );
}

export function drawTemporaryRoute(points) {
  drawPolyline(
    points,
    VISUAL_CONFIG.temporaryRouteColor,
    VISUAL_CONFIG.temporaryRouteDash,
    true
  );
}

export function drawSelection(cell, map) {
  if (!cell) return;
  const rect = cellRect(cell, map);
  context.save();
  context.strokeStyle = VISUAL_CONFIG.selectionColor;
  context.lineWidth = 4;
  context.strokeRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
  context.restore();
}

function drawBattleResult(winner) {
  const { width, height } = size();
  context.save();
  context.fillStyle = 'rgba(20, 24, 17, 0.68)';
  context.fillRect(0, 0, width, height);
  context.fillStyle = '#fff7cf';
  context.font = `bold ${Math.max(28, width * 0.055)}px system-ui`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(winner === 'draw' ? '平局' : `${winner} 胜利`, width / 2, height / 2);
  context.restore();
}

export function drawMap(state, selectedCell, temporaryPoints, animationNow = performance.now()) {
  if (!state.map) {
    const { width, height } = size();
    context.clearRect(0, 0, width, height);
    context.fillStyle = VISUAL_CONFIG.terrainColors.cliff;
    context.fillRect(0, 0, width, height);
    return;
  }
  drawTerrain(state.map);
  for (const route of state.routes) drawRoute(route);
  if (temporaryPoints) drawTemporaryRoute(temporaryPoints);
  const sceneItems = [
    ...state.obstacles.map((value) => ({ kind: 'obstacle', value })),
    ...state.buildings.map((value) => ({ kind: 'building', value })),
    ...(state.units || []).map((value) => ({ kind: 'unit', value }))
  ];
  const sceneDepth = (item) => {
    if (item.kind === 'unit') {
      const direction = item.value.facing === 'left' || item.value.facing === 'right'
        ? item.value.facing
        : item.value.owner === 'player1' ? 'right' : 'left';
      const asset = ASSET_MANIFEST.units[item.value.owner]?.[direction];
      return item.value.y * state.map.rows - 0.5 + (asset?.baselineY ?? 0.5);
    }
    const asset = item.kind === 'building'
      ? ASSET_MANIFEST.buildings[item.value.type]?.[item.value.owner]
      : ASSET_MANIFEST.obstacles[item.value.type];
    return item.value.row + (asset?.baselineY ?? 1);
  };
  sceneItems.sort((left, right) => sceneDepth(left) - sceneDepth(right));
  for (const item of sceneItems) {
    if (item.kind === 'obstacle') drawObstacle(item.value, state.map);
    if (item.kind === 'building') drawBuilding(item.value, state.map, false);
    if (item.kind === 'unit') drawUnit(item.value, state.map, animationNow);
  }
  for (const building of state.buildings) drawBuildingHealth(building, state.map);
  for (const unit of state.units || []) drawUnitHealth(unit, state.map);
  drawSelection(selectedCell, state.map);
  if (state.winner) drawBattleResult(state.winner);
}
