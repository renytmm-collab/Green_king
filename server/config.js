const GAME_CONFIG = Object.freeze({
  startingGold: 400,
  buildingCosts: Object.freeze({ mine: 100, tower: 150, barracks: 180 }),
  mineIncome: 10,
  mineIncomeIntervalMs: 2000
});

module.exports = { GAME_CONFIG };
