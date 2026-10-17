'use strict';

/* ARCADE model tests — the pure game logic in crew/games-model.js:
 *   - roadRush    : steering clamps, speed ramp, spawn gap rule, collision ends the run
 *   - blockDash   : gravity/jump/double-jump, stud scoring, obstacle ends the run
 *   - screamCore  : meter rise/decay, level clears add time, clock ends the run
 *   - cavernMiner : dig yields by ore, lava costs health, depth tracking, drop
 * All randomness is injectable, so every expectation here is deterministic. */

const test = require('node:test');
const assert = require('node:assert/strict');

const M = require('../crew/games-model.js');

/* Deterministic rng: a cycling sequence, so "random" draws are exact. */
function seqRng(values) {
  let i = 0;
  return () => values[i++ % values.length];
}
const midRng = () => 0.5;

/* ── registry ───────────────────────────────────────────────────────── */

test('the model exposes four games and their metadata', () => {
  assert.equal(M.GAMES.length, 4);
  assert.deepEqual(M.GAMES.map(g => g.id),
    ['roadRush', 'blockDash', 'screamCore', 'cavernMiner']);
  for (const g of M.GAMES) {
    assert.ok(g.title && g.blurb && g.keys, `${g.id} needs lobby copy`);
  }
});

/* ── roadRush ───────────────────────────────────────────────────────── */

test('roadRush: steering moves a lane and clamps at the edges', () => {
  let s = M.roadRushCreate();
  assert.equal(s.lane, 1);
  s = M.roadRushSteer(s, -1);
  assert.equal(s.lane, 0);
  s = M.roadRushSteer(s, -1);
  assert.equal(s.lane, 0, 'left edge clamps');
  s = M.roadRushSteer(s, 1);
  s = M.roadRushSteer(s, 1);
  assert.equal(s.lane, 2);
  s = M.roadRushSteer(s, 1);
  assert.equal(s.lane, 2, 'right edge clamps');
});

test('roadRush: ticking builds distance, score and speed', () => {
  let s = M.roadRushCreate();
  for (let i = 0; i < 120; i += 1) s = M.roadRushTick(s, 1 / 60, midRng);
  assert.ok(s.distance > 50, `distance accumulates (got ${s.distance})`);
  assert.equal(s.score, Math.floor(s.distance), 'score is whole meters');
  assert.ok(s.speed > M.ROAD.BASE_SPEED, 'speed ramps with distance');
  assert.ok(s.speed <= M.ROAD.MAX_SPEED, 'speed never exceeds the cap');
});

test('roadRush: the spawn rule always keeps one lane open', () => {
  let s = M.roadRushCreate();
  for (let i = 0; i < 600; i += 1) {
    s = M.roadRushTick(s, 1 / 30, seqRng([0.1, 0.2, 0.3, 0.9]));
    if (s.phase !== 'run') break;
  }
  /* For every spawn window, at least one lane must be free near the top. */
  const near = s.traffic.filter(c => c.z > M.ROAD.SPAWN_Z - M.ROAD.CAR_GAP_Z);
  const lanes = new Set(near.map(c => c.lane));
  assert.ok(lanes.size < M.ROAD.LANES, 'never all lanes blocked at once');
});

test('roadRush: a car in the player lane ends the run, a miss does not', () => {
  const base = M.roadRushCreate();
  const inLane = {
    ...base,
    traffic: [{ id: 1, lane: 1, z: 10, color: '#fff' }],
  };
  const crashed = M.roadRushTick(inLane, 0.5, midRng); // car reaches z<5.5
  assert.equal(crashed.phase, 'over');
  assert.equal(crashed.reason, 'collision');
  assert.ok(Number.isInteger(crashed.score), 'the run keeps its score');

  const otherLane = { ...base, lane: 0, traffic: [{ id: 1, lane: 1, z: 10, color: '#fff' }] };
  const missed = M.roadRushTick(otherLane, 0.5, midRng);
  assert.equal(missed.phase, 'run', 'other lanes are safe');
});

test('roadRush: a finished run ignores further input and time', () => {
  const over = { ...M.roadRushCreate(), phase: 'over' };
  assert.equal(M.roadRushSteer(over, 1).phase, 'over');
  assert.equal(M.roadRushTick(over, 1, midRng).phase, 'over');
  assert.equal(M.roadRushTick(over, 1, midRng).distance, over.distance, 'frozen');
});

/* ── blockDash ──────────────────────────────────────────────────────── */

test('blockDash: jump launches from the ground only, then gravity lands', () => {
  let s = M.blockDashCreate();
  assert.equal(s.grounded, true);
  s = M.blockDashJump(s);
  assert.ok(s.vy > 0, 'jump gives upward velocity');
  assert.equal(s.grounded, false);
  const midair = M.blockDashJump(s);
  assert.equal(midair.vy, M.DASH.AIR_JUMP_V,
    'the air jump sets its own (weaker, recovery-style) velocity');
  assert.ok(midair.vy > 0, 'and it is still upward');
  assert.equal(midair.airJumps, 0, 'only one air jump');
  const spent = M.blockDashJump(midair);
  assert.equal(spent.vy, midair.vy, 'no triple jump');
  for (let i = 0; i < 200 && !s.grounded; i += 1) s = M.blockDashTick(s, 1 / 60, midRng);
  assert.equal(s.grounded, true, 'gravity brings the runner back');
  assert.equal(s.y, M.DASH.GROUND);
});

test('blockDash: studs award points and get collected by proximity', () => {
  const base = M.blockDashCreate();
  const s = {
    ...base,
    studs: [{ id: 1, x: M.DASH.PLAYER_X + 3, y: 4.5, taken: false }],
  };
  const n = M.blockDashTick(s, 1 / 60, midRng);
  assert.equal(n.studsGot, 1);
  assert.equal(n.score, M.DASH.STUD_POINTS);
  assert.equal(n.studs.find(x => x.id === 1).taken, true);
});

test('blockDash: an obstacle in the runner ends the run with its kind', () => {
  const s = {
    ...M.blockDashCreate(),
    obstacles: [{ id: 1, x: M.DASH.PLAYER_X + 1, w: 7, h: 7, kind: 'block' }],
  };
  const n = M.blockDashTick(s, 1 / 60, midRng);
  assert.equal(n.phase, 'over');
  assert.equal(n.reason, 'block');
});

/* ── screamCore ─────────────────────────────────────────────────────── */

test('screamCore: loud fills the meter, quiet drains it', () => {
  let s = M.screamCoreCreate();
  const loud = s.target + 0.1;
  s = M.screamCoreFeed(s, loud, 0.5);
  assert.ok(s.meter > 0, 'above target raises the meter');
  const peak = s.meter;
  s = M.screamCoreFeed(s, 0.01, 0.5);
  assert.ok(s.meter < peak, 'silence drains it back down');
  assert.ok(s.meter >= 0, 'never negative');
});

test('screamCore: clearing a meter level advances and adds time', () => {
  let s = M.screamCoreCreate();
  const t0 = s.timeLeft;
  /* Enough sustained loudness to clear level 0 (target 0.15, rise 30%/s). */
  for (let i = 0; i < 30 && s.level === 0; i += 1) {
    s = M.screamCoreFeed(s, 0.9, 0.2);
  }
  assert.equal(s.level, 1, 'level advanced');
  assert.equal(s.cheers, 1);
  assert.equal(s.meter, 0, 'meter restarts empty');
  assert.equal(s.timeLeft, t0 + M.SCREAM.LEVEL_BONUS_SECONDS, 'clearing buys time');
  assert.ok(s.target > M.SCREAM.LEVELS[0], 'the next target is harder');
});

test('screamCore: clearing every level wins; the clock losing says so', () => {
  let s = M.screamCoreCreate();
  for (let i = 0; i < 500 && s.phase === 'run'; i += 1) {
    s = M.screamCoreFeed(s, 1, 0.2);
  }
  assert.equal(s.phase, 'over');
  assert.equal(s.won, true, 'all levels cleared = win');
  assert.equal(s.reason, 'cleared');

  let quiet = M.screamCoreCreate();
  for (let i = 0; i < 100 && quiet.phase === 'run'; i += 1) {
    quiet = M.screamCoreTick(quiet, 1);
  }
  assert.equal(quiet.phase, 'over');
  assert.equal(quiet.reason, 'time');
  assert.equal(quiet.won, false, 'the clock ending is not a win');
  assert.equal(quiet.timeLeft, 0);
});

test('screamCore: peak tracks the loudest sample and out-of-range clamps', () => {
  let s = M.screamCoreCreate();
  s = M.screamCoreFeed(s, 0.05, 0.1);
  s = M.screamCoreFeed(s, 5, 0.1);       // absurd input clamps, no crash
  assert.ok(s.peak <= 1, 'peak clamped to 1');
  const after = M.screamCoreFeed(s, 0.01, 0.1);
  assert.ok(after.peak >= s.peak * 0.999, 'peak never drops');
});

/* ── cavernMiner ────────────────────────────────────────────────────── */

test('cavernMiner: the grid is deterministic with an injected rng', () => {
  const a = M.caveCreate(seqRng([0.05, 0.5, 0.95, 0.3]));
  const b = M.caveCreate(seqRng([0.05, 0.5, 0.95, 0.3]));
  assert.deepEqual(a.grid, b.grid, 'same rng, same cave');
  assert.equal(a.grid.length, M.CAVE.H);
  assert.equal(a.grid[0].length, M.CAVE.W);
  assert.ok(a.grid[1][M.CAVE.START_X] === M.BLOCK.EMPTY
    && a.grid[2][M.CAVE.START_X] === M.BLOCK.EMPTY,
    'the drop shaft under spawn is always open');
});

test('cavernMiner: digging down yields ore points and depth, and the miner falls', () => {
  let s = M.caveCreate(midRng);
  /* Gold right under the miner, stone below that so the fall stops at 1. */
  const grid = s.grid.map(r => r.slice());
  grid[1][M.CAVE.START_X] = M.BLOCK.GOLD;
  grid[2][M.CAVE.START_X] = M.BLOCK.STONE;
  s = { ...s, grid };
  const n = M.caveMove(s, 'down');
  assert.equal(n.score, M.BLOCK_POINTS[M.BLOCK.GOLD], 'gold pays 25');
  assert.equal(n.x, M.CAVE.START_X);
  assert.equal(n.y, 1, 'the miner drops into the cell it just cleared');
  assert.equal(n.depth, 1, 'depth tracks the deepest cell');
  assert.equal(n.grid[1][M.CAVE.START_X], M.BLOCK.EMPTY, 'the block is gone');
  assert.equal(n.lastMined.block, M.BLOCK.GOLD, 'the UI can flash what was dug');

  /* Dig the same column once more: the stone is mined, the miner drops
     into it, and the dirt below stops the fall there. */
  const deep = M.caveMove(n, 'down');
  assert.equal(deep.grid[2][M.CAVE.START_X], M.BLOCK.EMPTY, 'stone mined');
  assert.equal(deep.score, n.score + M.BLOCK_POINTS[M.BLOCK.STONE]);
  assert.equal(deep.y, 2, 'the fall stops at the next solid block');
  assert.equal(deep.depth, deep.y, 'depth follows the fall');
});

test('cavernMiner: empty moves are free, walls are not passable, edges clamp', () => {
  let s = M.caveCreate(midRng);
  const grid = s.grid.map(r => r.slice());
  grid[0][M.CAVE.START_X - 1] = M.BLOCK.EMPTY;
  s = { ...s, grid };
  const moved = M.caveMove(s, 'left');
  assert.equal(moved.x, M.CAVE.START_X - 1, 'walking into air moves');

  const wall = M.caveMove({ ...s, x: 0 }, 'left');
  assert.equal(wall.x, 0, 'the world edge clamps');
});

test('cavernMiner: lava costs a heart and empty runs end the game', () => {
  let s = M.caveCreate(midRng);
  const grid = s.grid.map(r => r.slice());
  grid[1][M.CAVE.START_X] = M.BLOCK.LAVA;
  const burned = M.caveMove({ ...s, grid }, 'down');
  assert.equal(burned.health, M.CAVE.HEALTH - 1, 'lava burns one heart');
  assert.equal(burned.score, 0, 'lava pays nothing');

  const dying = M.caveMove({ ...s, grid, health: 1 }, 'down');
  assert.equal(dying.phase, 'over');
  assert.equal(dying.reason, 'lava');
});

test('cavernMiner: the miner drops through open air to rest on a floor', () => {
  let s = M.caveCreate(midRng);
  const grid = s.grid.map(r => r.map(() => M.BLOCK.EMPTY));
  /* Only a floor at the very bottom. */
  for (let x = 0; x < M.CAVE.W; x += 1) grid[M.CAVE.H - 1][x] = M.BLOCK.STONE;
  grid[1][M.CAVE.START_X] = M.BLOCK.EMPTY;
  const dropped = M.caveMove({ ...s, grid }, 'down');
  assert.equal(dropped.y, M.CAVE.H - 2, 'fell to just above the floor');
  assert.equal(dropped.depth, M.CAVE.H - 2);
});

test('cavernMiner: a finished run ignores input', () => {
  const over = { ...M.caveCreate(midRng), phase: 'over' };
  assert.equal(M.caveMove(over, 'down').phase, 'over');
});
