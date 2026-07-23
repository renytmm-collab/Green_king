export const VISUAL_CONFIG = Object.freeze({
  terrainColors: Object.freeze({
    cliff: '#986443',
    neutral: '#d5bd67',
    player1: '#78ad2f',
    player2: '#59635d'
  }),
  terrainEdgeColor: '#4a301f',
  tileGridColor: 'rgba(48, 70, 30, 0.13)',
  tileLightOverlay: 'rgba(255, 255, 190, 0.055)',
  tileDarkOverlay: 'rgba(30, 48, 25, 0.045)',
  routeLineWidth: 4,
  routeDash: [7, 5],
  temporaryRouteDash: [7, 5],
  routeColor: '#54eb3e',
  temporaryRouteColor: '#9cff70',
  buildingScale: 0.76,
  fontScale: 0.32,
  selectionColor: '#fff2a8',
  healthBarHeight: 4,
  healthBarGap: 3,
  unitRadius: 0.18,
  unitColors: Object.freeze({
    player1: '#76b938',
    player2: '#8b6fa9'
  })
});

const buildingAsset = (type, owner, scale) => Object.freeze({
  src: `/assets/original/buildings/${type}_${owner}.png`,
  scale,
  anchorX: 0.5,
  anchorY: 1,
  baselineY: 0.94,
  maxHeightCells: 1.45
});

const unitAsset = (owner, direction) => Object.freeze({
  src: `/assets/original/units/soldier_${owner}_${direction}.png`,
  frameWidth: 41,
  frameHeight: 37,
  frameCount: 36,
  columns: 6,
  fps: 12,
  scale: 0.7,
  anchorX: 0.5,
  anchorY: 1,
  baselineY: 0.74,
  maxHeightCells: 0.72
});

export const ASSET_MANIFEST = Object.freeze({
  buildings: Object.freeze({
    castle: Object.freeze({
      player1: buildingAsset('castle', 'player1', 1.36),
      player2: buildingAsset('castle', 'player2', 1.36)
    }),
    mine: Object.freeze({
      player1: buildingAsset('mine', 'player1', 1.24),
      player2: buildingAsset('mine', 'player2', 1.24)
    }),
    tower: Object.freeze({
      player1: buildingAsset('tower', 'player1', 1.02),
      player2: buildingAsset('tower', 'player2', 1.02)
    }),
    barracks: Object.freeze({
      player1: buildingAsset('barracks', 'player1', 1.16),
      player2: buildingAsset('barracks', 'player2', 1.16)
    })
  }),
  obstacles: Object.freeze({
    tree: Object.freeze({
      src: '/assets/original/obstacles/tree.png',
      scale: 1.42,
      anchorX: 0.5,
      anchorY: 1,
      baselineY: 1,
      maxHeightCells: 1.42
    }),
    rock: Object.freeze({
      src: '/assets/original/obstacles/rock.png',
      scale: 1.08,
      anchorX: 0.5,
      anchorY: 1,
      baselineY: 0.94,
      maxHeightCells: 1.1
    })
  }),
  units: Object.freeze({
    player1: Object.freeze({
      left: unitAsset('player1', 'left'),
      right: unitAsset('player1', 'right')
    }),
    player2: Object.freeze({
      left: unitAsset('player2', 'left'),
      right: unitAsset('player2', 'right')
    })
  })
});
