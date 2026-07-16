const GAME_CONFIG = Object.freeze({
  startingGold: 400,
  buildingCosts: Object.freeze({ mine: 100, tower: 150, barracks: 180 }),
  mineIncome: 10,
  mineIncomeIntervalMs: 2000
});

const MAP_CONFIG = Object.freeze({ rows: 9, columns: 18, homeColumns: 6 });
const ROUTE_CONFIG = Object.freeze({ minPoints: 2, maxPoints: 100, endpointTolerance: 0.08, minLength: 0.05, maxLength: 4 });

module.exports = { GAME_CONFIG, MAP_CONFIG, ROUTE_CONFIG };
