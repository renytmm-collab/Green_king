const GAME_CONFIG = Object.freeze({
  startingGold: 400,
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

// The playable island is neutral at first. Castles and completed buildings claim
// their surrounding 3x3 footprint, matching the original game's expanding base plates.
// . = playable ground, # = impassable terrain.
const LEVEL_CONFIG = Object.freeze({
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
    Object.freeze({ id: 'tree_left_front', type: 'tree', row: 4, column: 3 }),
    Object.freeze({ id: 'rock_left', type: 'rock', row: 2, column: 4 }),
    Object.freeze({ id: 'tree_left_lower', type: 'tree', row: 6, column: 5 }),
    Object.freeze({ id: 'tree_right_front', type: 'tree', row: 4, column: 14 }),
    Object.freeze({ id: 'rock_right', type: 'rock', row: 2, column: 13 }),
    Object.freeze({ id: 'tree_right_lower', type: 'tree', row: 6, column: 12 })
  ])
});

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
  unitAttackIntervalMs: 700,
  unitAttackRange: 0.035,
  unitAggroRange: 0.05,
  towerDamage: 24,
  towerAttackIntervalMs: 800,
  towerRange: 0.16
});

const NETWORK_CONFIG = Object.freeze({ maxMessageBytes: 64 * 1024 });

module.exports = {
  GAME_CONFIG,
  MAP_CONFIG,
  LEVEL_CONFIG,
  ROUTE_CONFIG,
  COMBAT_CONFIG,
  NETWORK_CONFIG
};
