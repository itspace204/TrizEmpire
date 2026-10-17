'use strict';

/* Missions — the operator's work orders for the crew.
 *
 * A mission moves through four stages, and every transition is an explicit
 * operator decision. That is not a shortcut: this app does not drive an
 * execution engine, so a mission's progress is recorded here honestly rather
 * than inferred from activity the backend cannot evidence.
 *
 *   brief     → created, plan waiting for approval ("Your desk")
 *   progress  → plan approved; steps advance one at a time, each stamped
 *   review    → last step finished; finished work waits for the word
 *   delivered → approved delivery; kept for replay and the 30-day chart
 *
 * Every record carries real timestamps (ms since epoch), so elapsed times,
 * cycle time, on-time rate and the delivered chart are computed from what
 * actually happened — never estimated.
 *
 * Persistence is a single JSON document behind lib/docstore.js, so the same
 * record works on a local file, an Upstash KV store or Neon (precedence
 * Neon > KV > file). Validation runs before every write and on every read.
 */

const { createStore } = require('./docstore');
const MODEL = require('../crew/crew-model');

const STORE_KEY = 'trizempire:missions';
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CREW = 6;
const MAX_STEPS = 12;
const MAX_MISSIONS = 200;
const STATUSES = Object.freeze(['brief', 'progress', 'review', 'delivered']);
const ACTIONS = Object.freeze(['approve', 'advance', 'deliver', 'reopen']);

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function emptyState() {
  return { seq: 1000, missions: [] };
}

/* ── validation ────────────────────────────────────────────────────────── */

function validProfile(value) {
  return typeof value === 'string' && PROFILE_ID.test(value);
}

/* Validates one mission record (used when reading a stored document). */
function validateMission(mission) {
  if (!mission || typeof mission !== 'object' || Array.isArray(mission)) {
    return 'mission must be an object';
  }
  if (typeof mission.id !== 'string' || !/^NX-\d{1,9}$/.test(mission.id)) return 'invalid mission id';
  if (typeof mission.title !== 'string' || mission.title.trim() === '' || mission.title.length > 160) return 'invalid mission title';
  if (!Array.isArray(mission.crew) || mission.crew.length === 0 || mission.crew.length > MAX_CREW) return 'invalid crew';
  if (!mission.crew.every(validProfile)) return 'invalid crew member';
  if (!Array.isArray(mission.steps) || mission.steps.length === 0 || mission.steps.length > MAX_STEPS) return 'invalid steps';
  for (const step of mission.steps) {
    if (!step || typeof step !== 'object') return 'invalid step';
    if (typeof step.name !== 'string' || step.name.trim() === '' || step.name.length > 120) return 'invalid step name';
    if (!validProfile(step.owner)) return 'invalid step owner';
    for (const stamp of [step.startedAt, step.finishedAt]) {
      if (stamp !== null && stamp !== undefined && !Number.isFinite(stamp)) return 'invalid step timestamp';
    }
  }
  if (!STATUSES.includes(mission.status)) return 'invalid status';
  if (!Number.isFinite(mission.limitMinutes) || mission.limitMinutes <= 0 || mission.limitMinutes > 24 * 60) return 'invalid time limit';
  for (const stamp of [mission.createdAt, mission.startedAt, mission.finishedAt, mission.deliveredAt]) {
    if (stamp !== null && stamp !== undefined && !Number.isFinite(stamp)) return 'invalid timestamp';
  }
  return null;
}

/* docstore validate(): the whole document. */
function validateState(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, error: 'state must be an object' };
  }
  if (!Number.isInteger(doc.seq) || doc.seq < 0) return { ok: false, error: 'state seq must be a non-negative integer' };
  if (!Array.isArray(doc.missions)) return { ok: false, error: 'state missions must be an array' };
  if (doc.missions.length > MAX_MISSIONS) return { ok: false, error: `too many missions (max ${MAX_MISSIONS})` };
  for (const mission of doc.missions) {
    const problem = validateMission(mission);
    if (problem) return { ok: false, error: problem };
  }
  const ids = new Set(doc.missions.map(m => m.id));
  if (ids.size !== doc.missions.length) return { ok: false, error: 'duplicate mission ids' };
  return { ok: true, doc };
}

/* Validates a create() input from the API. Returns cleaned values or an
 * error naming the problem (titles and step names are operator text, shown
 * in this very UI, so naming them is safe — nothing secret lives here). */
function validateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'mission must be an object with a title, crew, steps and a limit' };
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (title === '' || title.length > 160) {
    return { ok: false, error: 'title must be 1–160 characters' };
  }
  const crew = Array.isArray(input.crew) ? input.crew.filter((v, i, a) => a.indexOf(v) === i) : [];
  if (crew.length === 0 || crew.length > MAX_CREW || !crew.every(validProfile)) {
    return { ok: false, error: `crew must be 1–${MAX_CREW} known profile ids` };
  }
  const rawSteps = Array.isArray(input.steps) ? input.steps : [];
  if (rawSteps.length === 0 || rawSteps.length > MAX_STEPS) {
    return { ok: false, error: `a mission needs 1–${MAX_STEPS} steps` };
  }
  const steps = [];
  for (const raw of rawSteps) {
    const name = raw && typeof raw.name === 'string' ? raw.name.trim() : '';
    const owner = raw && typeof raw.owner === 'string' ? raw.owner : '';
    if (name === '' || name.length > 120) return { ok: false, error: 'each step needs a name of 1–120 characters' };
    if (!crew.includes(owner)) return { ok: false, error: `step "${name}" is assigned to ${owner || 'nobody'}, who is not on this mission's crew` };
    steps.push({ name, owner, startedAt: null, finishedAt: null });
  }
  let limitMinutes = Number(input.limitMinutes);
  if (!Number.isFinite(limitMinutes)) limitMinutes = 60;
  limitMinutes = Math.round(limitMinutes);
  if (limitMinutes <= 0 || limitMinutes > 24 * 60) {
    return { ok: false, error: 'limit must be between 1 and 1440 minutes' };
  }
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 600) : '';
  return { ok: true, value: { title, crew, steps, limitMinutes, note } };
}

/* ── lifecycle ─────────────────────────────────────────────────────────── */

const clone = state => ({ seq: state.seq, missions: state.missions.map(m => ({
  ...m,
  crew: [...m.crew],
  steps: m.steps.map(s => ({ ...s })),
})) });

function find(state, id) {
  return state.missions.find(m => m.id === id) || null;
}

function createMission(state, input, now) {
  const checked = validateInput(input);
  if (!checked.ok) return { ok: false, error: checked.error };
  const next = clone(state);
  next.seq = state.seq + 1;
  const mission = {
    id: `NX-${next.seq}`,
    ...checked.value,
    status: 'brief',
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    deliveredAt: null,
  };
  next.missions.unshift(mission);
  return { ok: true, mission, doc: next };
}

/* Shared transition guard: the mission must exist and be in the expected
 * stage. The message tells the operator exactly where it stands. */
function transition(state, id, from, to) {
  const mission = find(state, id);
  if (!mission) return { ok: false, error: `mission ${id} does not exist` };
  if (mission.status !== from) {
    return { ok: false, error: `mission ${id} is ${mission.status}, not ${from}` };
  }
  const next = clone(state);
  return { ok: true, mission: find(next, id), doc: next };
}

function approveMission(state, id, now) {
  const t = transition(state, id, 'brief', 'progress');
  if (!t.ok) return t;
  t.mission.status = 'progress';
  t.mission.startedAt = now;
  t.mission.steps[0].startedAt = now;
  return { ok: true, mission: t.mission, doc: t.doc };
}

function advanceMission(state, id, now) {
  const t = transition(state, id, 'progress', 'progress');
  if (!t.ok) return t;
  const step = t.mission.steps.find(s => !s.finishedAt);
  if (!step) return { ok: false, error: `mission ${id} has no open step to advance` };
  step.finishedAt = now;
  const nextStep = t.mission.steps.find(s => !s.finishedAt);
  if (nextStep) {
    nextStep.startedAt = nextStep.startedAt ?? now;
  } else {
    t.mission.status = 'review';
    t.mission.finishedAt = now;
  }
  return { ok: true, mission: t.mission, doc: t.doc };
}

function deliverMission(state, id, now) {
  const t = transition(state, id, 'review', 'delivered');
  if (!t.ok) return t;
  t.mission.status = 'delivered';
  t.mission.deliveredAt = now;
  return { ok: true, mission: t.mission, doc: t.doc };
}

/* Reopening returns the last finished step to the bench. Review means
 * every step is stamped, so without this the reopened mission would have
 * no open step left to advance and could never reach review again — the
 * final step's clock restarts at `now`. */
function reopenMission(state, id, now) {
  const t = transition(state, id, 'review', 'progress');
  if (!t.ok) return t;
  t.mission.status = 'progress';
  t.mission.finishedAt = null;
  const last = [...t.mission.steps].reverse().find(s => s.finishedAt);
  if (last) {
    last.finishedAt = null;
    if (Number.isFinite(now)) last.startedAt = now;
  }
  return { ok: true, mission: t.mission, doc: t.doc };
}

/* Only unfinished business is deletable: a delivered mission is history and
 * stays for replay; a running mission is not silently discardable. */
function deleteMission(state, id) {
  const mission = find(state, id);
  if (!mission) return { ok: false, error: `mission ${id} does not exist` };
  if (mission.status === 'progress' || mission.status === 'delivered') {
    return { ok: false, error: `mission ${id} is ${mission.status} and cannot be deleted` };
  }
  const next = clone(state);
  next.missions = next.missions.filter(m => m.id !== id);
  return { ok: true, mission, doc: next };
}

/* ── statistics (computed from what actually happened) ─────────────────── */

function computeStats(state, now, rosterTotal) {
  const missions = state.missions;
  const brief = missions.filter(m => m.status === 'brief');
  const review = missions.filter(m => m.status === 'review');
  const running = missions.filter(m => m.status === 'progress');
  const delivered = missions.filter(m => m.status === 'delivered' && Number.isFinite(m.deliveredAt));

  const cycles = delivered
    .map(m => (Number.isFinite(m.startedAt) ? (m.deliveredAt - m.startedAt) / 1000 : null))
    .filter(s => s !== null && s >= 0);
  const cycleSeconds = cycles.length
    ? Math.round(cycles.reduce((sum, s) => sum + s, 0) / cycles.length)
    : null;

  const inTime = delivered.filter(m => Number.isFinite(m.startedAt)
    && (m.deliveredAt - m.startedAt) <= m.limitMinutes * MINUTE_MS);
  const timed = delivered.filter(m => Number.isFinite(m.startedAt));
  const onTimePercent = timed.length ? Math.round((inTime.length / timed.length) * 100) : null;

  /* Delivered per UTC day for the last 30 days (index 29 is today). */
  const startOfToday = Math.floor(now / DAY_MS) * DAY_MS;
  const days = new Array(30).fill(0);
  for (const mission of delivered) {
    const bucket = Math.floor((mission.deliveredAt - startOfToday) / DAY_MS) + 29;
    if (bucket >= 0 && bucket < 30) days[bucket] += 1;
  }

  return {
    waiting: { brief: brief.length, review: review.length, total: brief.length + review.length },
    running: running.length,
    delivered: { days, today: days[29], total: delivered.length },
    cycleSeconds,
    onTimePercent,
    agentsAtWork: { busy: running.length, total: Number.isFinite(rosterTotal) ? rosterTotal : null },
    limits: { brief: brief.map(m => m.id), review: review.map(m => m.id) },
  };
}

/* ── persistence ───────────────────────────────────────────────────────── */

/* How many agents the shared model knows about — the honest denominator for
 * "agents at work": distinct profiles across the workspaces, not a claim
 * about machines or licences. */
function rosterSize() {
  const set = new Set();
  for (const workspace of MODEL.WORKSPACES || []) {
    for (const profile of (Array.isArray(workspace.profiles) ? workspace.profiles : [])) set.add(profile);
  }
  return set.size;
}

function createStore$1(config = {}) {
  return createStore({ ...config, key: STORE_KEY, validate: validateState });
}

module.exports = {
  emptyState,
  validateState,
  validateInput,
  validateMission,
  createMission,
  approveMission,
  advanceMission,
  deliverMission,
  reopenMission,
  deleteMission,
  computeStats,
  rosterSize,
  createStore: createStore$1,
  STORE_KEY,
  STATUSES,
  ACTIONS,
  MAX_STEPS,
  MAX_CREW,
  PROFILE_ID,
};
