const GAME_CONFIG = Object.freeze({
  startingGold: 400,
  constructionDurationMs: 500,
  buildingCosts: Object.freeze({ mine: 100, tower: 150, barracks: 180 }),
  clearCosts: Object.freeze({ tree: 40, rock: 60 }),
  mineIncome: 10,
  mineIncomeIntervalMs: 2000,
  buildingStats: Object.freeze({
    castle: Object.freeze({ maxHp: 1200 }),
    mine: Object.freeze({ maxHp: 280 }),
    tower: Object.freeze({ maxHp: 420 }),
    barracks: Object.freeze({ maxHp: 360 })
  })
});

const MAP_CONFIG = Object.freeze({ rows: 9, columns: 18 });

// Every map is 180°-rotation symmetric so player1 (4,1) and player2 (4,16)
// are perfect mirrors — fair for 1v1. Two castles always sit at the mirrored
// edges. '.' = playable grass, '#' = impassable cliff. Obstacles (trees/rocks)
// are placed on grass and block building + routing, forcing units to weave around.
const MAPS = Object.freeze({
  plain: Object.freeze({
    id: 'plain',
    name: '平原',
    description: '开阔地对，零星树石，直路快攻，新手友好。',
    terrainRows: Object.freeze([
      '####..........####',
      '###............###',
      '##..............##',
      '#................#',
      '..................',
      '#................#',
      '##..............##',
      '###............###',
      '####..........####'
    ]),
    initialTerritoryRadius: 1,
    buildingExpansionRadius: 1,
    castles: Object.freeze({
      player1: Object.freeze({ row: 4, column: 1 }),
      player2: Object.freeze({ row: 4, column: 16 })
    }),
    obstacles: Object.freeze([
      Object.freeze({ id: 'tree_lf', type: 'tree', row: 4, column: 3 }),
      Object.freeze({ id: 'tree_rf', type: 'tree', row: 4, column: 14 }),
      Object.freeze({ id: 'rock_l', type: 'rock', row: 2, column: 4 }),
      Object.freeze({ id: 'rock_r', type: 'rock', row: 6, column: 13 }),
      Object.freeze({ id: 'tree_ll', type: 'tree', row: 6, column: 5 }),
      Object.freeze({ id: 'tree_rl', type: 'tree', row: 2, column: 12 })
    ])
  }),
  canyon: Object.freeze({
    id: 'canyon',
    name: '峡谷',
    description: '中轴悬崖带只留两处隘口，塔防拦截走强。',
    terrainRows: Object.freeze([
      '####..........####',
      '###.....##.....###',
      '##......##......##',
      '#................#',
      '........##........',
      '#................#',
      '##......##......##',
      '###.....##.....###',
      '####..........####'
    ]),
    initialTerritoryRadius: 1,
    buildingExpansionRadius: 1,
    castles: Object.freeze({
      player1: Object.freeze({ row: 4, column: 1 }),
      player2: Object.freeze({ row: 4, column: 16 })
    }),
    obstacles: Object.freeze([
      Object.freeze({ id: 'tree_c1', type: 'tree', row: 2, column: 5 }),
      Object.freeze({ id: 'tree_c2', type: 'tree', row: 6, column: 12 }),
      Object.freeze({ id: 'tree_c3', type: 'tree', row: 3, column: 4 }),
      Object.freeze({ id: 'tree_c4', type: 'tree', row: 5, column: 13 })
    ])
  }),
  archipelago: Object.freeze({
    id: 'archipelago',
    name: '群岛',
    description: '中央陆地切开两半，只能上下绕远包抄。',
    terrainRows: Object.freeze([
      '####..........####',
      '###............###',
      '##...########...##',
      '#..############..#',
      '..##############..',
      '#..############..#',
      '##...########...##',
      '###............###',
      '####..........####'
    ]),
    initialTerritoryRadius: 1,
    buildingExpansionRadius: 1,
    castles: Object.freeze({
      player1: Object.freeze({ row: 4, column: 1 }),
      player2: Object.freeze({ row: 4, column: 16 })
    }),
    obstacles: Object.freeze([
      Object.freeze({ id: 'rock_a1', type: 'rock', row: 1, column: 8 }),
      Object.freeze({ id: 'rock_a2', type: 'rock', row: 7, column: 9 })
    ])
  }),
  forest: Object.freeze({
    id: 'forest',
    name: '迷林',
    description: '对称散布树石，多条蜿蜒小道多线博弈。',
    terrainRows: Object.freeze([
      '####..........####',
      '###............###',
      '##..............##',
      '#................#',
      '..................',
      '#................#',
      '##..............##',
      '###............###',
      '####..........####'
    ]),
    initialTerritoryRadius: 1,
    buildingExpansionRadius: 1,
    castles: Object.freeze({
      player1: Object.freeze({ row: 4, column: 1 }),
      player2: Object.freeze({ row: 4, column: 16 })
    }),
    obstacles: Object.freeze([
      Object.freeze({ id: 'tr_f1', type: 'tree', row: 2, column: 4 }),
      Object.freeze({ id: 'tr_f2', type: 'tree', row: 6, column: 13 }),
      Object.freeze({ id: 'rk_f1', type: 'rock', row: 3, column: 7 }),
      Object.freeze({ id: 'rk_f2', type: 'rock', row: 5, column: 10 }),
      Object.freeze({ id: 'tr_f3', type: 'tree', row: 2, column: 10 }),
      Object.freeze({ id: 'tr_f4', type: 'tree', row: 6, column: 7 }),
      Object.freeze({ id: 'rk_f3', type: 'rock', row: 3, column: 11 }),
      Object.freeze({ id: 'rk_f4', type: 'rock', row: 5, column: 6 }),
      Object.freeze({ id: 'tr_f5', type: 'tree', row: 4, column: 5 }),
      Object.freeze({ id: 'tr_f6', type: 'tree', row: 4, column: 12 }),
      Object.freeze({ id: 'rk_f5', type: 'rock', row: 4, column: 3 }),
      Object.freeze({ id: 'rk_f6', type: 'rock', row: 4, column: 14 }),
      Object.freeze({ id: 'tr_f7', type: 'tree', row: 1, column: 8 }),
      Object.freeze({ id: 'tr_f8', type: 'tree', row: 7, column: 9 })
    ])
  }),
  bridge: Object.freeze({
    id: 'bridge',
    name: '孤桥',
    description: '中央一道悬崖仅留一处孤桥，双方大军都须从此过河，桥头防御塔定胜负。',
    terrainRows: Object.freeze([
      '####....##....####',
      '###.....##.....###',
      '##......##......##',
      '#................#',
      '..................',
      '#................#',
      '##......##......##',
      '###.....##.....###',
      '####....##....####'
    ]),
    initialTerritoryRadius: 1,
    buildingExpansionRadius: 1,
    castles: Object.freeze({
      player1: Object.freeze({ row: 4, column: 1 }),
      player2: Object.freeze({ row: 4, column: 16 })
    }),
    obstacles: Object.freeze([
      Object.freeze({ id: 'rock_b1', type: 'rock', row: 2, column: 5 }),
      Object.freeze({ id: 'rock_b2', type: 'rock', row: 6, column: 12 }),
      Object.freeze({ id: 'rock_b3', type: 'rock', row: 2, column: 12 }),
      Object.freeze({ id: 'rock_b4', type: 'rock', row: 6, column: 5 }),
      Object.freeze({ id: 'tree_b1', type: 'tree', row: 3, column: 6 }),
      Object.freeze({ id: 'tree_b2', type: 'tree', row: 5, column: 11 })
    ])
  }),
  gambit: Object.freeze({
    id: 'gambit',
    name: '棋局',
    description: '中央中立庭院由两道错位的隘墙围出多条进攻路线，双方都须抢先占据中枢；主攻方向猜错就会被抄家。',
    terrainRows: Object.freeze([
      '####..#....#..####',
      '###...#....#...###',
      '##....#.........##',
      '#.....#..........#',
      '..................',
      '#..........#.....#',
      '##.........#....##',
      '###...#....#...###',
      '####..#....#..####'
    ]),
    initialTerritoryRadius: 1,
    buildingExpansionRadius: 1,
    castles: Object.freeze({
      player1: Object.freeze({ row: 4, column: 1 }),
      player2: Object.freeze({ row: 4, column: 16 })
    }),
    obstacles: Object.freeze([
      Object.freeze({ id: 'rock_g1', type: 'rock', row: 3, column: 8 }),
      Object.freeze({ id: 'rock_g2', type: 'rock', row: 5, column: 9 }),
      Object.freeze({ id: 'rock_g3', type: 'rock', row: 3, column: 9 }),
      Object.freeze({ id: 'rock_g4', type: 'rock', row: 5, column: 8 }),
      Object.freeze({ id: 'tree_g1', type: 'tree', row: 4, column: 7 }),
      Object.freeze({ id: 'tree_g2', type: 'tree', row: 4, column: 10 }),
      Object.freeze({ id: 'tree_g3', type: 'tree', row: 2, column: 9 }),
      Object.freeze({ id: 'tree_g4', type: 'tree', row: 6, column: 8 }),
      Object.freeze({ id: 'tree_g5', type: 'tree', row: 2, column: 8 }),
      Object.freeze({ id: 'tree_g6', type: 'tree', row: 6, column: 9 })
    ])
  })
});

const DEFAULT_MAP_ID = 'plain';
// Backward-compatible alias so existing tests/code referencing LEVEL_CONFIG keep working.
const LEVEL_CONFIG = MAPS[DEFAULT_MAP_ID];

const ROUTE_CONFIG = Object.freeze({
  maxTargets: 3,
  minRawPoints: 2,
  maxRawPoints: 160,
  maxWaypoints: 24,
  endpointTolerance: 0.065,
  minPointDistance: 0.002,
  minLength: 0.03,
  maxLength: 4
});

const COMBAT_CONFIG = Object.freeze({
  tickMs: 100,
  broadcastIntervalMs: 100,
  barracksSpawnIntervalMs: 2400,
  unitMaxHp: 90,
  unitSpeedPerSecond: 0.085,
  unitDamage: 22,
  unitExplosionDamage: 80,
  unitAttackIntervalMs: 700,
  unitAttackRange: 0.035,
  unitAggroRange: 0.05,
  towerDamage: 24,
  towerAttackIntervalMs: 800,
  towerRange: 0.16
});

// In-match tech tree. The original single-player game has a 16-upgrade
// meta-progression unlocked by stars across levels; in a real-time 1v1 LAN
// match we re-cast that as a per-match gold-funded upgrade tree. Each track
// has discrete levels; cost scales with the next level. Multipliers are
// applied server-authoritatively in simulationStep / spawnUnit.
const UPGRADE_CONFIG = Object.freeze({
  tracks: Object.freeze({
    mine: Object.freeze({
      name: '矿场增产', maxLevel: 3, baseCost: 120, costStep: 80, unit: 'incomeMul', mul: 0.25,
      hint: '每座矿山产金 +25%/级'
    }),
    towerDamage: Object.freeze({
      name: '塔攻强化', maxLevel: 3, baseCost: 140, costStep: 90, unit: 'damageMul', mul: 0.25,
      hint: '防御塔伤害 +25%/级'
    }),
    towerRange: Object.freeze({
      name: '塔射扩展', maxLevel: 2, baseCost: 120, costStep: 80, unit: 'rangeMul', mul: 0.15,
      hint: '防御塔射程 +15%/级'
    }),
    barracksRate: Object.freeze({
      name: '出兵提速', maxLevel: 3, baseCost: 130, costStep: 90, unit: 'rateMul', mul: 0.18,
      hint: '兵营出兵间隔 -18%/级'
    }),
    soldierHp: Object.freeze({
      name: '士兵强化', maxLevel: 3, baseCost: 110, costStep: 70, unit: 'hpMul', mul: 0.25,
      hint: '士兵生命 +25%/级'
    }),
    soldierSpeed: Object.freeze({
      name: '行军加速', maxLevel: 2, baseCost: 100, costStep: 70, unit: 'speedMul', mul: 0.2,
      hint: '士兵移动速度 +20%/级'
    }),
    soldierDamage: Object.freeze({
      name: '爆炸增伤', maxLevel: 3, baseCost: 120, costStep: 80, unit: 'damageMul', mul: 0.3,
      hint: '士兵爆炸伤害 +30%/级'
    }),
    castleArmor: Object.freeze({
      name: '城堡加固', maxLevel: 2, baseCost: 150, costStep: 100, unit: 'castleHpMul', mul: 0.3,
      hint: '城堡生命 +30%/级'
    })
  })
});

// Neutral gold pickups, faithful to the original game's random on-map coins.
// A coin periodically appears on a random walkable tile and is claimed by
// whoever clicks it FIRST (contested — either player). Uncollected coins
// vanish after `lifetimeMs`, so grabbing them adds a light APM/attention layer
// on top of the passive mine income (which stays fully automatic).
const PICKUP_CONFIG = Object.freeze({
  spawnIntervalMs: 6500,
  value: 30,
  lifetimeMs: 6000,
  maxActive: 3
});

const NETWORK_CONFIG = Object.freeze({ maxMessageBytes: 64 * 1024 });

function zeroUpgrades() {
  const upgrades = {};
  for (const trackId of Object.keys(UPGRADE_CONFIG.tracks)) upgrades[trackId] = 0;
  return upgrades;
}

module.exports = {
  GAME_CONFIG,
  MAP_CONFIG,
  MAPS: MAPS,
  DEFAULT_MAP_ID,
  LEVEL_CONFIG,
  ROUTE_CONFIG,
  COMBAT_CONFIG,
  UPGRADE_CONFIG,
  zeroUpgrades,
  PICKUP_CONFIG,
  NETWORK_CONFIG
};
