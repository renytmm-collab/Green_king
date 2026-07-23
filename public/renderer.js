import { VISUAL_CONFIG, ASSET_MANIFEST } from './visual-config.js';

let canvas;
let context;
const imageCache = new Map();

// The server stamps each broadcast with `serverTime` (epoch ms) so both clients
// can animate time-based effects (like the 0.5s build animation) in lockstep
// despite latency. We record a local snapshot at each broadcast and interpolate.
let serverClockServer = 0;
let serverClockLocal = 0;
export function setServerTime(serverTime) {
  serverClockServer = typeof serverTime === 'number' ? serverTime : 0;
  serverClockLocal = Date.now();
}
function serverNow() {
  if (!serverClockServer) return Date.now();
  return serverClockServer + (Date.now() - serverClockLocal);
}

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
  if (!cell) return null;
  if (cell.buildingId) {
    return state.buildings.find((building) => building.id === cell.buildingId) || null;
  }
  // Obstacles keep their logical cell even when a nearby sprite overlaps it.
  if (cell.obstacleId || !canvas) return null;

  const pointInPixels = pixels(point);
  const candidates = state.buildings
    .map((building) => ({
      building,
      asset: ASSET_MANIFEST.buildings[building.type]?.[building.owner]
    }))
    .filter(({ building, asset }) => (
      asset && pointHitsVisibleAsset(asset, objectRect(building, state.map), pointInPixels)
    ))
    .sort((left, right) => (
      right.building.row - left.building.row
      || right.building.column - left.building.column
    ));
  return candidates[0]?.building || null;
}

export function obstacleAtPoint(state, point) {
  const cell = cellAtPoint(state.map, point);
  return cell?.obstacleId
    ? state.obstacles.find((obstacle) => obstacle.id === cell.obstacleId) || null
    : null;
}

// Generous circular tap target so coins are easy to grab (esp. on touch).
export function coinAtPoint(state, point) {
  if (!state.map || !state.coins?.length) return null;
  const { width, height } = size();
  const cell = Math.min(width / state.map.columns, height / state.map.rows);
  const hitRadius = cell * 0.6;
  const pointInPixels = pixels(point);
  let nearest = null;
  let nearestDistance = hitRadius;
  for (const coin of state.coins) {
    const center = pixels({ x: coin.x, y: coin.y });
    const distance = Math.hypot(center.x - pointInPixels.x, center.y - pointInPixels.y);
    if (distance <= nearestDistance) {
      nearest = coin;
      nearestDistance = distance;
    }
  }
  return nearest;
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

function pointHitsVisibleAsset(config, rect, point) {
  const frame = resolveAssetFrame(config, rect);
  if (
    !frame
    || point.x < frame.x
    || point.x > frame.x + frame.width
    || point.y < frame.y
    || point.y > frame.y + frame.height
  ) return false;

  const sourceX = Math.min(
    frame.frameWidth - 1,
    Math.max(0, Math.floor((point.x - frame.x) / frame.width * frame.frameWidth))
  );
  const sourceY = Math.min(
    frame.frameHeight - 1,
    Math.max(0, Math.floor((point.y - frame.y) / frame.height * frame.frameHeight))
  );
  const record = imageCache.get(config.src);
  if (!record) return true;
  if (!record.alphaData) {
    try {
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = record.image.naturalWidth;
      maskCanvas.height = record.image.naturalHeight;
      const maskContext = maskCanvas.getContext('2d', { willReadFrequently: true });
      maskContext.drawImage(record.image, 0, 0);
      record.alphaData = maskContext.getImageData(
        0,
        0,
        maskCanvas.width,
        maskCanvas.height
      ).data;
      record.alphaWidth = maskCanvas.width;
    } catch {
      record.alphaData = 'unavailable';
    }
  }
  if (record.alphaData === 'unavailable') return true;
  const alphaIndex = ((frame.sourceY + sourceY) * record.alphaWidth
    + frame.sourceX + sourceX) * 4 + 3;
  return record.alphaData[alphaIndex] > 16;
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

// Which upgrade tracks belong to each building type. Mirrors the client mapping
// so the badge can show how many levels a building has been upgraded.
const BUILDING_UPGRADE_TRACKS = Object.freeze({
  mine: ['mine'],
  tower: ['towerDamage', 'towerRange'],
  barracks: ['barracksRate', 'soldierHp', 'soldierSpeed', 'soldierDamage'],
  castle: ['castleArmor']
});

function roundRectPath(ctx, x, y, w, h, r) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Returns a progress object (0..1) while the building is still under
// construction, or false once the 0.5s build animation has finished.
export function isConstructing(building, state) {
  if (!building || typeof building.constructedAt !== 'number') return false;
  const duration = building.constructionDurationMs || 500;
  const end = building.constructedAt + duration;
  const now = state ? serverNow() : Date.now();
  const remaining = end - now;
  if (remaining <= 0) return false;
  return { progress: Math.max(0, Math.min(1, 1 - remaining / duration)) };
}

// 0.5s build animation rendered over the building's official sprite: the sprite
// rises out of the ground, a blueprint glass tint + pulsing outline marks it as
// "under construction", and a ring shows the remaining build progress.
function drawConstruction(building, map, progress) {
  const rect = objectRect(building, map);
  const asset = ASSET_MANIFEST.buildings[building.type]?.[building.owner];
  const ownerColor = VISUAL_CONFIG.terrainColors[building.owner] || '#ffffff';
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;

  context.save();

  // Ground shadow.
  context.fillStyle = 'rgba(0,0,0,0.18)';
  context.beginPath();
  context.ellipse(cx, rect.y + rect.height * 0.92, rect.width * 0.42, rect.height * 0.12, 0, 0, Math.PI * 2);
  context.fill();

  // The official sprite reveals from the bottom up as it "rises".
  const frame = resolveAssetFrame(asset, rect);
  context.save();
  if (frame) {
    const revealBottom = frame.y + frame.height;
    const revealTop = revealBottom - frame.height * progress;
    context.beginPath();
    context.rect(rect.x, revealTop, rect.width, frame.y + frame.height - revealTop);
    context.clip();
    context.globalAlpha = 0.92;
    drawAsset(asset, rect);
  } else {
    const blockH = rect.height * 0.82 * progress;
    const blockY = rect.y + rect.height * 0.91 - blockH;
    context.globalAlpha = 0.9;
    context.fillStyle = ownerColor;
    context.fillRect(rect.x + rect.width * 0.18, blockY, rect.width * 0.64, blockH);
  }
  context.restore();

  // Blueprint glass tint over the footprint.
  context.save();
  context.globalAlpha = 0.2 + 0.12 * Math.sin(Date.now() / 120);
  context.fillStyle = '#39d6ff';
  context.fillRect(rect.x + 2, rect.y + 2, rect.width - 4, rect.height - 4);
  context.restore();

  // Pulsing dashed construction outline.
  context.save();
  context.strokeStyle = '#bfefff';
  context.lineWidth = 2;
  context.setLineDash([5, 4]);
  context.lineDashOffset = -(Date.now() / 40) % 9;
  context.strokeRect(rect.x + 3, rect.y + 3, rect.width - 6, rect.height - 6);
  context.restore();

  // Progress ring around the building centre.
  const ringR = Math.min(rect.width, rect.height) * 0.62;
  context.save();
  context.lineWidth = 3;
  context.strokeStyle = 'rgba(255,255,255,0.25)';
  context.beginPath();
  context.arc(cx, cy, ringR, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = ownerColor;
  context.beginPath();
  context.arc(cx, cy, ringR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  context.stroke();
  context.restore();

  // "建造中" label with percentage.
  const label = `建造中 ${Math.round(progress * 100)}%`;
  context.save();
  context.font = `bold ${Math.max(10, Math.min(rect.width, rect.height) * 0.22)}px system-ui`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  const tw = context.measureText(label).width + 12;
  const th = Math.max(15, rect.height * 0.24);
  const ly = rect.y + rect.height * 0.16;
  context.fillStyle = 'rgba(18,28,38,0.8)';
  roundRectPath(context, cx - tw / 2, ly - th / 2, tw, th, 6);
  context.fill();
  context.fillStyle = '#eaffff';
  context.fillText(label, cx, ly + 0.5);
  context.restore();

  context.restore();
}

export function drawBuilding(building, map, includeHealth = true, state = null) {
  const construction = isConstructing(building, state);
  if (construction) {
    drawConstruction(building, map, construction.progress);
    return;
  }
  drawBuildingBody(building, map);
  if (includeHealth) drawBuildingHealth(building, map);
  drawUpgradeBadge(building, map, state);
}

function drawUpgradeBadge(building, map, state) {
  if (!state || !state.players) return;
  const tracks = BUILDING_UPGRADE_TRACKS[building.type];
  if (!tracks) return;
  const upgrades = state.players[building.owner]?.upgrades;
  if (!upgrades) return;
  const level = tracks.reduce((sum, track) => sum + (upgrades[track] || 0), 0);
  if (level <= 0) return;

  const rect = objectRect(building, map);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const radius = Math.min(rect.width, rect.height) * 0.6;
  const ownerColor = VISUAL_CONFIG.terrainColors[building.owner] || '#ffffff';

  // Halo — intensity grows with the number of purchased levels.
  context.save();
  context.globalAlpha = Math.min(0.55, 0.18 + level * 0.07);
  context.strokeStyle = ownerColor;
  context.lineWidth = 3;
  context.beginPath();
  context.arc(cx, cy, radius, 0, Math.PI * 2);
  context.stroke();
  context.restore();

  // Badge — a small disc with the total level, pinned to the top-right.
  const bx = rect.x + rect.width * 0.84;
  const by = rect.y + rect.height * 0.14;
  const badgeRadius = Math.max(8, rect.width * 0.2);
  context.save();
  context.fillStyle = '#ffd24a';
  context.strokeStyle = ownerColor;
  context.lineWidth = 2;
  context.beginPath();
  context.arc(bx, by, badgeRadius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.fillStyle = '#3a2c00';
  context.font = `bold ${Math.round(badgeRadius * 1.3)}px system-ui`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(String(level), bx, by + 0.5);
  context.restore();
}

export function drawSnapMarker(point) {
  if (!point) return;
  const pixel = pixels(point);
  const { width, height } = size();
  const radius = Math.max(7, Math.min(width, height) * 0.018);
  context.save();
  context.globalAlpha = 0.9;
  context.fillStyle = VISUAL_CONFIG.temporaryRouteColor;
  context.strokeStyle = '#ffffff';
  context.lineWidth = 2;
  context.beginPath();
  context.arc(pixel.x, pixel.y, radius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
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

// Visualises the "grab a cell before it flips" mechanic: a dashed owner-coloured
// frame on any cell a player has reserved via the build menu.
export function drawReservations(state) {
  if (!state.reservations || !state.reservations.length || !state.map) return;
  const { width, height } = size();
  const cellWidth = width / state.map.columns;
  const cellHeight = height / state.map.rows;
  context.save();
  context.lineWidth = Math.max(2, Math.min(cellWidth, cellHeight) * 0.07);
  context.setLineDash([cellWidth * 0.18, cellWidth * 0.14]);
  for (const reservation of state.reservations) {
    const color = VISUAL_CONFIG.terrainColors[reservation.owner] || '#ffffff';
    context.strokeStyle = color;
    context.strokeRect(
      reservation.column * cellWidth + 2,
      reservation.row * cellHeight + 2,
      cellWidth - 4,
      cellHeight - 4
    );
  }
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
    if (item.kind === 'building') drawBuilding(item.value, state.map, false, state);
    if (item.kind === 'unit') drawUnit(item.value, state.map, animationNow);
  }
  for (const building of state.buildings) {
    if (isConstructing(building, state)) continue;
    drawBuildingHealth(building, state.map);
  }
  for (const unit of state.units || []) drawUnitHealth(unit, state.map);
  drawCoins(state.coins, state.map, animationNow);
  drawSelection(selectedCell, state.map);
  drawReservations(state);
  if (state.winner) drawBattleResult(state.winner);
}

// Neutral gold pickups: a bobbing coin with a shrinking ring that shows how
// long it will stay before vanishing. Clicking one claims the gold.
export function drawCoins(coins, map, animationNow = performance.now()) {
  if (!coins || !coins.length || !map) return;
  const { width, height } = size();
  const cell = Math.min(width / map.columns, height / map.rows);
  const radius = cell * 0.28;
  for (const coin of coins) {
    const center = pixels({ x: coin.x, y: coin.y });
    const bob = Math.sin(animationNow / 260 + coin.x * 40) * cell * 0.06;
    const cx = center.x;
    const cy = center.y + bob;
    const ttlRatio = coin.lifetimeMs ? Math.max(0, Math.min(1, coin.remainingMs / coin.lifetimeMs)) : 1;
    context.save();
    // soft shadow on the ground
    context.globalAlpha = 0.28;
    context.fillStyle = '#000';
    context.beginPath();
    context.ellipse(center.x, center.y + cell * 0.22, radius * 0.85, radius * 0.32, 0, 0, Math.PI * 2);
    context.fill();
    context.globalAlpha = 1;
    // coin body
    const gradient = context.createRadialGradient(cx - radius * 0.3, cy - radius * 0.3, radius * 0.2, cx, cy, radius);
    gradient.addColorStop(0, '#fff2b0');
    gradient.addColorStop(0.5, '#ffd24d');
    gradient.addColorStop(1, '#e0a21c');
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(cx, cy, radius, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#a9760c';
    context.lineWidth = Math.max(1, cell * 0.03);
    context.stroke();
    // ¥ glyph
    context.fillStyle = '#8a5a06';
    context.font = `bold ${Math.round(radius * 1.25)}px system-ui, sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText('¥', cx, cy + radius * 0.05);
    // countdown ring (turns from green to red as it runs out)
    const ringColor = ttlRatio > 0.4 ? '#7bd63a' : '#ff5a4d';
    context.strokeStyle = ringColor;
    context.lineWidth = Math.max(1.5, cell * 0.05);
    context.beginPath();
    context.arc(cx, cy, radius * 1.32, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ttlRatio);
    context.stroke();
    context.restore();
  }
}

// Transient combat visuals driven by server-emitted events: tower projectiles
// and explosion / destruction bursts. Drawn on top of the scene each frame.
export function drawEffects(effectList, map, animationNow = performance.now()) {
  if (!effectList || !effectList.length || !map) return;
  const { width, height } = size();
  const cell = Math.min(width / map.columns, height / map.rows);
  for (const effect of effectList) {
    const age = (animationNow - effect.born) / effect.duration;
    if (age < 0 || age > 1) continue;
    const point = pixels({ x: effect.x ?? 0, y: effect.y ?? 0 });
    if (effect.kind === 'projectile') {
      const x = effect.from.x + (effect.to.x - effect.from.x) * age;
      const y = effect.from.y + (effect.to.y - effect.from.y) * age;
      const p = pixels({ x, y });
      const radius = cell * 0.13;
      context.save();
      context.fillStyle = effect.owner === 'player1' ? '#c8ff7a' : '#e0b0ff';
      context.beginPath();
      context.arc(p.x, p.y, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = 'rgba(255,255,255,0.75)';
      context.lineWidth = 1;
      context.stroke();
      context.restore();
    } else {
      const isCastle = effect.kind === 'castle_destroyed';
      const baseRadius = cell * (isCastle ? 1.1 : 0.72);
      const radius = baseRadius * (0.3 + age * 1.15);
      context.save();
      context.globalAlpha = Math.max(0, 1 - age);
      context.fillStyle = isCastle ? '#ffd24d' : '#ff9a3c';
      context.beginPath();
      context.arc(point.x, point.y, radius, 0, Math.PI * 2);
      context.fill();
      context.strokeStyle = effect.owner === 'player1' ? '#9be23a' : '#c79bff';
      context.lineWidth = 3 * (1 - age);
      context.beginPath();
      context.arc(point.x, point.y, radius * 1.12, 0, Math.PI * 2);
      context.stroke();
      context.restore();
    }
  }
}
