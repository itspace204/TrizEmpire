'use strict';

/* ══════════════════════════════════════════════════════════════════════
 * GAMES MODEL — pure, DOM-free logic for the operator ARCADE page.
 *
 * Loaded two ways:
 *   - in the browser as a classic script (window.GAMES_MODEL)
 *   - in node tests via require() — the exact same code the UI runs.
 *
 * Four original games (canvas primitives only — no third-party art, no
 * trademarked assets or names):
 *   - roadRush    : 3-lane car race — dodge traffic, distance is score
 *   - blockDash   : blocky-avatar endless runner — jump, collect studs
 *   - screamCore  : scream-powered meter — loudness raises it, quiet
 *                   drains it; the mic is the controller
 *   - cavernMiner : turn-based voxel digger — dig down, collect ores,
 *                   avoid the lava
 *
 * Rules of the module (same honesty rules as the rest of the project):
 *   - No timers, no canvas, no Math.random in core paths: every random
 *     draw takes an injectable rng so tests are deterministic.
 *   - Each game is create() → state plus pure transitions that return a
 *     NEW state object (shallow copy); the UI owns rendering, input
 *     capture, audio and the requestAnimationFrame loop.
 *   - Nothing here claims more than it does: screamCore measures mic
 *     loudness, it does not judge tone; cavernMiner has no win state,
 *     only depth; roadRush collisions end the run, they are not
 *     "accidents avoided".
 * ══════════════════════════════════════════════════════════════════════ */

/* ── roadRush — the car race ────────────────────────────────────────── */

const ROAD = Object.freeze({
  LANES: 3,
  SPAWN_Z: 110,          // how far ahead traffic appears
  HIT_Z: 5.5,            // |z| below this means "at the player"
  REMOVE_Z: -12,
  BASE_SPEED: 30,        // world units / second at distance 0
  MAX_SPEED: 92,
  ACCEL_PER_100: 11,     // speed gained per 100 distance
  CAR_GAP_Z: 26,         // spawn spacing that keeps a lane opening
  STEER_LERP: 12,        // cosmetic x smoothing, per second
  TRAFFIC_COLORS: Object.freeze(['#ff5f56', '#56c8ff', '#b98bff', '#ffd166', '#7dffa8']),
});

function roadRushCreate() {
  return {
    game: 'roadRush',
    phase: 'run',              // 'run' | 'over'
    lane: 1,                   // 0..ROAD.LANES-1
    x: 50,                     // interpolated screen % (cosmetic)
    distance: 0,
    score: 0,
    speed: ROAD.BASE_SPEED,
    traffic: [],               // { id, lane, z, color }
    nextId: 1,
    spawnCooldown: 0.8,
    reason: null,              // 'collision' once over
  };
}

function roadRushSteer(state, dir) {
  if (state.phase !== 'run') return state;
  const lane = Math.max(0, Math.min(ROAD.LANES - 1, state.lane + dir));
  if (lane === state.lane) return state;
  return { ...state, lane };
}

function roadRushTick(state, dt, rng) {
  if (state.phase !== 'run') return state;
  const rand = rng || Math.random;
  const speed = Math.min(ROAD.MAX_SPEED,
    ROAD.BASE_SPEED + (state.distance / 100) * ROAD.ACCEL_PER_100);
  const distance = state.distance + speed * dt;

  let traffic = state.traffic
    .map(car => ({ ...car, z: car.z - speed * dt }))
    .filter(car => car.z > ROAD.REMOVE_Z);

  let spawnCooldown = state.spawnCooldown - dt;
  let nextId = state.nextId;
  if (spawnCooldown <= 0) {
    const lane = Math.floor(rand() * ROAD.LANES);
    /* Keep at least one lane open: never stack a lane already occupied
       near the spawn line, and never fill two lanes in the same window. */
    const near = traffic.filter(car => car.z > ROAD.SPAWN_Z - ROAD.CAR_GAP_Z);
    const blocked = new Set(near.map(car => car.lane));
    if (!blocked.has(lane) && blocked.size < ROAD.LANES - 1) {
      const color = ROAD.TRAFFIC_COLORS[Math.floor(rand() * ROAD.TRAFFIC_COLORS.length)];
      traffic = traffic.concat({ id: nextId, lane, z: ROAD.SPAWN_Z, color });
      nextId += 1;
    }
    /* Spacing shrinks with speed so density stays fair, not impossible. */
    spawnCooldown = (ROAD.CAR_GAP_Z / speed) * (0.75 + rand() * 0.9);
  }

  const moved = { ...state, speed, distance, traffic, nextId, spawnCooldown };
  const hit = moved.traffic.find(car =>
    car.lane === moved.lane && Math.abs(car.z) < ROAD.HIT_Z);
  if (hit) {
    return { ...moved, phase: 'over', reason: 'collision', score: Math.floor(moved.distance) };
  }
  return { ...moved, score: Math.floor(distance) };
}

/* ── blockDash — the blocky endless runner ──────────────────────────── */

const DASH = Object.freeze({
  GROUND: 0,              // player y at rest (up is positive)
  GRAVITY: 60,
  JUMP_V: 40,
  AIR_JUMP_V: 32,         // weaker second jump
  PLAYER_X: 22,           // % across the screen
  PLAYER_W: 6,
  PLAYER_H: 9,
  BASE_SPEED: 14,         // world units / second
  MAX_SPEED: 30,
  ACCEL_PER_400: 4,
  SPAWN_X: 108,
  STUD_POINTS: 10,
});

function blockDashCreate() {
  return {
    game: 'blockDash',
    phase: 'run',
    y: DASH.GROUND,
    vy: 0,
    grounded: true,
    airJumps: 1,
    obstacles: [],         // { id, x, w, h, kind }
    studs: [],             // { id, x, y, taken }
    worldX: 0,
    speed: DASH.BASE_SPEED,
    score: 0,
    studsGot: 0,
    nextId: 1,
    spawnCooldown: 0.9,
    reason: null,
  };
}

function blockDashJump(state) {
  if (state.phase !== 'run') return state;
  if (state.grounded) {
    return { ...state, vy: DASH.JUMP_V, grounded: false };
  }
  if (state.airJumps > 0) {
    return { ...state, vy: DASH.AIR_JUMP_V, airJumps: state.airJumps - 1 };
  }
  return state;
}

function blockDashTick(state, dt, rng) {
  if (state.phase !== 'run') return state;
  const rand = rng || Math.random;

  let { y, vy, grounded, airJumps } = state;
  vy -= DASH.GRAVITY * dt;
  y += vy * dt;
  if (y <= DASH.GROUND) {
    y = DASH.GROUND;
    vy = 0;
    grounded = true;
    airJumps = 1;
  }

  const speed = Math.min(DASH.MAX_SPEED,
    DASH.BASE_SPEED + (state.worldX / 400) * DASH.ACCEL_PER_400);
  const worldX = state.worldX + speed * dt;

  let obstacles = state.obstacles
    .map(o => ({ ...o, x: o.x - speed * dt }))
    .filter(o => o.x + o.w > -8);
  let studs = state.studs
    .map(s => ({ ...s, x: s.x - speed * dt }))
    .filter(s => !s.taken && s.x > -8);

  let spawnCooldown = state.spawnCooldown - dt;
  let nextId = state.nextId;
  let studsGot = state.studsGot;
  if (spawnCooldown <= 0) {
    const r = rand();
    const kind = r < 0.45 ? 'block' : (r < 0.8 ? 'spike' : 'crate');
    const dims = kind === 'spike' ? { w: 5, h: 5 }
      : kind === 'crate' ? { w: 8, h: 9 } : { w: 7, h: 7 + Math.floor(rand() * 4) };
    const obstacle = { id: nextId, x: DASH.SPAWN_X, kind, ...dims };
    obstacles = obstacles.concat(obstacle);
    nextId += 1;
    if (rand() < 0.65) {
      const count = 3;
      for (let i = 0; i < count; i += 1) {
        studs = studs.concat({
          id: nextId,
          x: DASH.SPAWN_X + obstacle.w / 2 + (i - 1) * 5,
          y: obstacle.h + 5 + Math.sin((i / (count - 1)) * Math.PI) * 4,
          taken: false,
        });
        nextId += 1;
      }
    }
    spawnCooldown = 1.05 + rand() * 0.75;
  }

  /* Player AABB in world-% coordinates. */
  const px = DASH.PLAYER_X;
  const pw = DASH.PLAYER_W;
  const ph = DASH.PLAYER_H;
  const hitObstacle = obstacles.find(o =>
    px < o.x + o.w && px + pw > o.x && y < o.h && y + ph > 0);
  if (hitObstacle) {
    return {
      ...state, phase: 'over', reason: hitObstacle.kind,
      y, vy, grounded, airJumps, obstacles, studs, worldX, speed, nextId,
      spawnCooldown, score: state.score, studsGot,
    };
  }

  let score = state.score;
  studs = studs.map(s => {
    if (s.taken) return s;
    const cx = px + pw / 2;
    const cy = y + ph / 2;
    if (Math.abs(s.x - cx) < 4.5 && Math.abs(s.y - cy) < 6) {
      studsGot += 1;
      score += DASH.STUD_POINTS;
      return { ...s, taken: true };
    }
    return s;
  });

  return {
    ...state, y, vy, grounded, airJumps, obstacles, studs, worldX, speed,
    nextId, spawnCooldown, score, studsGot,
  };
}

/* ── screamCore — the screaming game ────────────────────────────────── */

const SCREAM = Object.freeze({
  RUN_SECONDS: 30,
  LEVELS: Object.freeze([0.15, 0.22, 0.30, 0.40, 0.55]),
  RISE_PER_SEC: 30,       // meter %/second while at or above target
  DECAY_PER_SEC: 15,      // meter %/second while below
  LEVEL_BONUS_SECONDS: 5,
  MAX_METER: 100,
});

function screamCoreCreate() {
  return {
    game: 'screamCore',
    phase: 'run',          // 'run' | 'over'
    won: false,            // cleared every level before time ran out
    meter: 0,              // 0..SCREAM.MAX_METER
    level: 0,              // index into LEVELS
    target: SCREAM.LEVELS[0],
    timeLeft: SCREAM.RUN_SECONDS,
    peak: 0,               // loudest sample seen this run (0..~1)
    cheers: 0,             // levels cleared
    reason: null,          // 'time'
  };
}

/* v is normalized loudness 0..1 (UI: RMS of the mic waveform). */
function screamCoreFeed(state, v, dt) {
  if (state.phase !== 'run') return state;
  const loud = Math.max(0, Math.min(1, Number(v) || 0));
  const peak = Math.max(state.peak, loud);
  let meter = loud >= state.target
    ? Math.min(SCREAM.MAX_METER, state.meter + SCREAM.RISE_PER_SEC * dt)
    : Math.max(0, state.meter - SCREAM.DECAY_PER_SEC * dt);

  if (meter >= SCREAM.MAX_METER) {
    const nextLevel = state.level + 1;
    if (nextLevel >= SCREAM.LEVELS.length) {
      return {
        ...state, meter: SCREAM.MAX_METER, peak,
        level: nextLevel, cheers: nextLevel, won: true, phase: 'over', reason: 'cleared',
      };
    }
    return {
      ...state, meter: 0, peak, level: nextLevel,
      target: SCREAM.LEVELS[nextLevel], cheers: nextLevel,
      timeLeft: state.timeLeft + SCREAM.LEVEL_BONUS_SECONDS,
    };
  }
  return { ...state, meter, peak };
}

function screamCoreTick(state, dt) {
  if (state.phase !== 'run') return state;
  const timeLeft = Math.max(0, state.timeLeft - dt);
  if (timeLeft <= 0) {
    return { ...state, timeLeft: 0, phase: 'over', reason: 'time', won: false };
  }
  return { ...state, timeLeft };
}

/* ── cavernMiner — the voxel digger ─────────────────────────────────── */

const CAVE = Object.freeze({
  W: 9,
  H: 16,
  HEALTH: 3,
  START_X: 4,
});

const BLOCK = Object.freeze({
  EMPTY: 0,
  DIRT: 1,
  STONE: 2,
  GOLD: 3,
  DIAMOND: 4,
  LAVA: 5,
});

const BLOCK_POINTS = Object.freeze({
  [BLOCK.DIRT]: 2,
  [BLOCK.STONE]: 5,
  [BLOCK.GOLD]: 25,
  [BLOCK.DIAMOND]: 100,
  [BLOCK.LAVA]: 0,
});

function caveFill(rng) {
  const rand = rng || Math.random;
  const grid = [];
  for (let y = 0; y < CAVE.H; y += 1) {
    const row = [];
    for (let x = 0; x < CAVE.W; x += 1) {
      if (y === 0) { row.push(BLOCK.EMPTY); continue; }
      const r = rand();
      if (y < 4) row.push(r < 0.88 ? BLOCK.DIRT : BLOCK.EMPTY);
      else if (y < 9) {
        row.push(r < 0.5 ? BLOCK.STONE : r < 0.82 ? BLOCK.DIRT
          : r < 0.93 ? BLOCK.GOLD : BLOCK.EMPTY);
      } else {
        row.push(r < 0.38 ? BLOCK.STONE : r < 0.56 ? BLOCK.GOLD
          : r < 0.64 ? BLOCK.DIAMOND : r < 0.72 ? BLOCK.LAVA : BLOCK.EMPTY);
      }
    }
    grid.push(row);
  }
  /* The drop shaft under the miner: always a way down from spawn. */
  grid[1][CAVE.START_X] = BLOCK.EMPTY;
  grid[2][CAVE.START_X] = BLOCK.EMPTY;
  return grid;
}

function caveCreate(rng) {
  return {
    game: 'cavernMiner',
    phase: 'run',
    grid: caveFill(rng),
    x: CAVE.START_X,
    y: 0,
    health: CAVE.HEALTH,
    score: 0,
    depth: 0,
    lastMined: null,       // { x, y, block } for the UI flash
    reason: null,          // 'lava'
  };
}

function caveDrop(state) {
  let { y } = state;
  while (y + 1 < CAVE.H && state.grid[y + 1][state.x] === BLOCK.EMPTY) y += 1;
  if (y === state.y) return state;
  /* Falling deeper IS digging deeper: the depth record follows the fall. */
  return { ...state, y, depth: Math.max(state.depth, y) };
}

/* dir: 'up' | 'down' | 'left' | 'right'. Walking into empty air moves;
   walking into a block mines it in place (turn-based, one action each). */
function caveMove(state, dir) {
  if (state.phase !== 'run') return state;
  const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  if (!delta) return state;
  const nx = state.x + delta[0];
  const ny = state.y + delta[1];
  if (nx < 0 || nx >= CAVE.W || ny < 0 || ny >= CAVE.H) return state;

  const cell = state.grid[ny][nx];
  if (cell === BLOCK.EMPTY) {
    return caveDrop({ ...state, x: nx, y: ny, depth: Math.max(state.depth, ny), lastMined: null });
  }

  /* Mining. Lava burns instead of yielding. */
  const grid = state.grid.map(row => row.slice());
  grid[ny][nx] = BLOCK.EMPTY;
  if (cell === BLOCK.LAVA) {
    const health = state.health - 1;
    const next = {
      ...state, grid, health, score: state.score,
      lastMined: { x: nx, y: ny, block: cell },
    };
    if (health <= 0) return { ...next, phase: 'over', reason: 'lava' };
    return caveDrop(next);
  }
  return caveDrop({
    ...state, grid,
    score: state.score + (BLOCK_POINTS[cell] || 0),
    lastMined: { x: nx, y: ny, block: cell },
  });
}

/* ── shared metadata (lobby cards, UI titles) ───────────────────────── */

const GAMES = Object.freeze([
  { id: 'roadRush', title: 'ROAD RUSH', emoji: '🏎️', blurb: 'Three lanes, rising speed, oncoming traffic. How far can you get?', keys: '← → or A D to steer' },
  { id: 'blockDash', title: 'BLOCK DASH', emoji: '🧱', blurb: 'A blocky runner hops crates and spikes for studs. Double-jump in the air.', keys: 'SPACE / W / ↑ to jump' },
  { id: 'screamCore', title: 'SCREAM CORE', emoji: '😱', blurb: 'Your voice is the controller: loud fills the meter, quiet drains it.', keys: 'Microphone (or hold SPACE)' },
  { id: 'cavernMiner', title: 'CAVERN MINER', emoji: '⛏️', blurb: 'Dig down through stone and ore. Mind the lava. Depth is glory.', keys: 'Arrows / WASD to move and dig' },
]);

const GAMES_MODEL = Object.freeze({
  ROAD, DASH, SCREAM, CAVE, BLOCK, BLOCK_POINTS, GAMES,
  roadRushCreate, roadRushSteer, roadRushTick,
  blockDashCreate, blockDashJump, blockDashTick,
  screamCoreCreate, screamCoreFeed, screamCoreTick,
  caveCreate, caveMove,
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = GAMES_MODEL;
} else if (typeof window !== 'undefined') {
  window.GAMES_MODEL = GAMES_MODEL;
}
