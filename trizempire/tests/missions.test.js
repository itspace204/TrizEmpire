'use strict';

/* Tests for missions — the operator's work orders:
 *   - lib/missions.js  lifecycle (brief → progress → review → delivered),
 *                      validation before every write, stats computed from
 *                      the real timestamps only;
 *   - /api/missions    list, create, approve, advance, deliver, reopen,
 *                      delete — plus the gates every state-changing route
 *                      faces (session auth, CSRF header, same origin) and
 *                      honest persistence (restart survives, corrupt file
 *                      is reported instead of crashing the endpoint).
 * Progress here is recorded by the operator, never inferred: every test
 * pins an explicit transition and the refusal message when it is not due. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server');
const { hashPassword } = require('../lib/auth');
const missions = require('../lib/missions');
const MODEL = require('../crew/crew-model');

const ADMIN_HASH = hashPassword('correct horse battery staple');
const T0 = 1700000000000;
const MIN = 60 * 1000;

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triz-mis-'));
  return path.join(dir, 'missions.json');
}

async function withServer(run, options = {}) {
  const server = createServer(options);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const plan = over => ({
  title: 'Habit worth starting',
  crew: ['writer', 'research'],
  steps: [
    { name: 'Collect examples', owner: 'research' },
    { name: 'Draft the post', owner: 'writer' },
  ],
  limitMinutes: 15,
  note: '',
  ...over,
});

/* Walks a fresh state through the whole lifecycle with fixed stamps. */
function mature(over) {
  let state = missions.emptyState();
  state = missions.createMission(state, plan(), T0).doc;
  const id = state.missions[0].id;
  state = missions.approveMission(state, id, T0 + MIN).doc;
  state = missions.advanceMission(state, id, T0 + 3 * MIN).doc;
  state = missions.advanceMission(state, id, T0 + 5 * MIN).doc;
  state = missions.deliverMission(state, id, T0 + 6 * MIN).doc;
  return { state, id, ...over };
}

/* ── model: creation and validation ─────────────────────────────────── */

test('createMission assigns NX ids, unshifts and starts in brief', () => {
  const a = missions.createMission(missions.emptyState(), plan(), T0);
  assert.equal(a.ok, true);
  assert.equal(a.mission.id, 'NX-1001');
  assert.equal(a.mission.status, 'brief');
  assert.equal(a.mission.startedAt, null);
  assert.ok(a.mission.steps.every(s => s.startedAt === null && s.finishedAt === null));

  const b = missions.createMission(a.doc, plan({ title: 'Second one' }), T0 + MIN);
  assert.equal(b.mission.id, 'NX-1002', 'seq keeps counting');
  assert.equal(b.doc.missions[0].id, 'NX-1002', 'newest mission first');
  assert.equal(b.doc.missions.length, 2);
});

test('createMission refuses input the model would not accept and names why', () => {
  const cases = [
    [plan({ title: '' }), /title must be 1–160 characters/],
    [plan({ crew: [] }), /crew must be 1–6 known profile ids/],
    [plan({ steps: [] }), /a mission needs 1–12 steps/],
    [plan({ steps: [{ name: 'Orphan', owner: 'nobody' }] }), /not on this mission's crew/],
    [plan({ limitMinutes: 0 }), /limit must be between 1 and 1440 minutes/],
    [plan({ limitMinutes: 1441 }), /limit must be between 1 and 1440 minutes/],
    [{}, /title must be 1–160 characters/],
  ];
  for (const [input, pattern] of cases) {
    const res = missions.createMission(missions.emptyState(), input, T0);
    assert.equal(res.ok, false, `should refuse: ${JSON.stringify(input).slice(0, 60)}`);
    assert.match(res.error, pattern);
    assert.equal(res.doc, undefined, 'nothing is written on refusal');
  }
});

test('validation runs before every write, not only at creation', () => {
  const { state } = mature();
  const corrupt = { ...state, missions: [{ ...state.missions[0], status: 'exploded' }] };
  const checked = missions.validateState(corrupt);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /invalid status/);

  const dupes = { seq: 3, missions: [] };
  dupes.missions = [missions.createMission(missions.emptyState(), plan(), T0).mission];
  dupes.missions.push({ ...dupes.missions[0] });
  assert.match(missions.validateState(dupes).error, /duplicate mission ids/);
  assert.match(missions.validateState({ seq: -1, missions: [] }).error, /seq/);
  assert.match(missions.validateState(null).error, /object/);
});

/* ── model: lifecycle ───────────────────────────────────────────────── */

test('approve stamps the start, advance walks the steps into review', () => {
  let state = missions.createMission(missions.emptyState(), plan(), T0).doc;
  const id = state.missions[0].id;

  const ap = missions.approveMission(state, id, T0 + MIN);
  assert.equal(ap.ok, true);
  assert.equal(ap.mission.status, 'progress');
  assert.equal(ap.mission.startedAt, T0 + MIN);
  assert.equal(ap.mission.steps[0].startedAt, T0 + MIN, 'first step starts with the approval');
  assert.equal(ap.mission.steps[1].startedAt, null, 'later steps wait their turn');
  state = ap.doc;

  const a1 = missions.advanceMission(state, id, T0 + 3 * MIN);
  assert.equal(a1.mission.steps[0].finishedAt, T0 + 3 * MIN);
  assert.equal(a1.mission.steps[1].startedAt, T0 + 3 * MIN, 'the next step takes over');
  assert.equal(a1.mission.status, 'progress');
  state = a1.doc;

  const a2 = missions.advanceMission(state, id, T0 + 5 * MIN);
  assert.equal(a2.mission.status, 'review', 'last step finishing moves it to review');
  assert.equal(a2.mission.finishedAt, T0 + 5 * MIN);
  state = a2.doc;

  const d = missions.deliverMission(state, id, T0 + 6 * MIN);
  assert.equal(d.mission.status, 'delivered');
  assert.equal(d.mission.deliveredAt, T0 + 6 * MIN);
});

test('out-of-order transitions are refused with the actual stage named', () => {
  let state = missions.createMission(missions.emptyState(), plan(), T0).doc;
  const id = state.missions[0].id;

  let r = missions.advanceMission(state, id, T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /is brief, not progress/);

  r = missions.deliverMission(state, id, T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /is brief, not review/);

  r = missions.approveMission(state, 'NX-9999', T0);
  assert.equal(r.ok, false);
  assert.match(r.error, /does not exist/);

  r = missions.approveMission(state, id, T0);
  state = r.doc;
  r = missions.approveMission(state, id, T0);
  assert.match(r.error, /is progress, not brief/, 'double approval is impossible');

  r = missions.deliverMission(state, id, T0);
  assert.match(r.error, /is progress, not review/, 'work in progress cannot be delivered');

  // review → reopen puts the last step back on the bench, so the mission
  // can be advanced all the way to review again (no dead end).
  state = missions.advanceMission(state, id, T0 + MIN).doc;
  state = missions.advanceMission(state, id, T0 + 2 * MIN).doc;
  assert.equal(state.missions[0].status, 'review');
  const re = missions.reopenMission(state, id, T0 + 3 * MIN);
  assert.equal(re.ok, true);
  assert.equal(re.mission.status, 'progress');
  assert.equal(re.mission.finishedAt, null);
  assert.equal(re.mission.steps[1].finishedAt, null, 'the last step is open again');
  assert.equal(re.mission.steps[1].startedAt, T0 + 3 * MIN, 'and its clock restarted');
  state = re.doc;
  assert.equal(missions.advanceMission(state, id, T0 + 4 * MIN).mission.status, 'review',
    'after the reopen the mission can reach review again');
});

test('delete removes only unfinished business', () => {
  let state = missions.createMission(missions.emptyState(), plan(), T0).doc;
  const briefId = state.missions[0].id;
  state = missions.createMission(state, plan({ title: 'Another' }), T0).doc;
  const otherId = state.missions[0].id;

  const ap = missions.approveMission(state, briefId, T0 + MIN);
  state = ap.doc;
  const blocked = missions.deleteMission(state, briefId);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /is progress and cannot be deleted/);

  const gone = missions.deleteMission(state, otherId);
  assert.equal(gone.ok, true);
  assert.equal(gone.doc.missions.length, 1, 'the running mission stays');

  const { state: done, id } = mature();
  assert.equal(missions.deleteMission(done, id).ok, false, 'delivered work is history');
  assert.match(missions.deleteMission(done, id).error, /is delivered and cannot be deleted/);

  assert.equal(missions.deleteMission(state, 'NX-4242').ok, false);
});

/* ── model: statistics from real timestamps only ────────────────────── */

test('computeStats reports waiting, cycle, on-time and the 30-day chart', () => {
  const state = missions.emptyState();
  let s = state;
  s = missions.createMission(s, plan({ title: 'Waiting plan' }), T0).doc;
  const briefId = s.missions[0].id;

  // Delivered on time: 5 minutes against a 15-minute limit.
  s = missions.createMission(s, plan({ title: 'Fast one', limitMinutes: 15 }), T0).doc;
  const fast = s.missions[0].id;
  s = missions.approveMission(s, fast, T0).doc;
  s = missions.advanceMission(s, fast, T0 + 2 * MIN).doc;
  s = missions.advanceMission(s, fast, T0 + 4 * MIN).doc;
  s = missions.deliverMission(s, fast, T0 + 5 * MIN).doc;

  // Delivered late: 30 minutes against a 15-minute limit.
  s = missions.createMission(s, plan({ title: 'Slow one', limitMinutes: 15 }), T0).doc;
  const slow = s.missions[0].id;
  s = missions.approveMission(s, slow, T0).doc;
  s = missions.advanceMission(s, slow, T0 + 10 * MIN).doc;
  s = missions.advanceMission(s, slow, T0 + 20 * MIN).doc;
  s = missions.deliverMission(s, slow, T0 + 30 * MIN).doc;

  // One in review, one running.
  s = missions.createMission(s, plan({ title: 'Needs the word' }), T0).doc;
  const review = s.missions[0].id;
  s = missions.approveMission(s, review, T0).doc;
  s = missions.advanceMission(s, review, T0 + MIN).doc;
  s = missions.advanceMission(s, review, T0 + 2 * MIN).doc;

  s = missions.createMission(s, plan({ title: 'Running now' }), T0).doc;
  const running = s.missions[0].id;
  s = missions.approveMission(s, running, T0).doc;
  assert.ok(briefId);

  // "now" is 3 days after the deliveries — cycle and on-time use the real stamps.
  const now = T0 + 3 * 24 * 60 * MIN;
  const stats = missions.computeStats(s, now, missions.rosterSize());

  assert.equal(stats.waiting.brief, 1);
  assert.equal(stats.waiting.review, 1);
  assert.equal(stats.waiting.total, 2, 'one plan to approve, one to deliver');
  assert.equal(stats.running, 1);
  assert.equal(stats.delivered.total, 2);

  // cycle = average(startedAt → deliveredAt) over the two deliveries = (5m + 30m)/2
  assert.equal(stats.cycleSeconds, Math.round((5 * MIN + 30 * MIN) / 2) / 1000);
  // on time = 1 of 2 inside the 15-minute limit
  assert.equal(stats.onTimePercent, 50);

  // chart: both deliveries 3 days ago, none today
  assert.equal(stats.delivered.days.length, 30);
  assert.equal(stats.delivered.days[26], 2);
  assert.equal(stats.delivered.today, 0);

  // roster: distinct profiles across the shipped workspaces
  const expectedRoster = new Set();
  for (const ws of MODEL.WORKSPACES) for (const p of ws.profiles) expectedRoster.add(p);
  assert.equal(stats.agentsAtWork.total, expectedRoster.size);
  assert.equal(stats.agentsAtWork.busy, 1);
  assert.deepEqual([...stats.limits.brief].sort(), [briefId].sort());
  assert.deepEqual([...stats.limits.review].sort(), [review].sort());
});

test('computeStats on an empty state stays honest (nulls, not zeros)', () => {
  const stats = missions.computeStats(missions.emptyState(), T0, missions.rosterSize());
  assert.equal(stats.waiting.total, 0);
  assert.equal(stats.running, 0);
  assert.equal(stats.delivered.total, 0);
  assert.equal(stats.cycleSeconds, null, 'no deliveries: no cycle time claim');
  assert.equal(stats.onTimePercent, null, 'no deliveries: no on-time claim');
  assert.equal(stats.delivered.days.length, 30);
  assert.ok(stats.delivered.days.every(v => v === 0));
});

/* ── API: list, create ──────────────────────────────────────────────── */

test('GET /api/missions answers with empty defaults before anything exists', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const res = await fetch(`${base}/api/missions`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.deepEqual(body.missions, []);
    assert.equal(body.source, 'defaults');
    assert.equal(body.error, null);
    assert.equal(body.backend, 'file');
    assert.equal(body.stats.waiting.total, 0);
    assert.equal(body.stats.delivered.days.length, 30);
  }, { users: [], missionsFile: file });
});

test('POST creates a mission; a fresh server reloads it from disk', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const res = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify(plan()),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.mission.id, 'NX-1001');
    assert.equal(body.mission.status, 'brief');
    assert.equal(body.source, 'stored', 'the write just happened');
    assert.equal(body.error, null);
    assert.equal(body.stats.waiting.brief, 1);
  }, { users: [], missionsFile: file });

  await withServer(async base => {
    const body = await (await fetch(`${base}/api/missions`)).json();
    assert.equal(body.missions.length, 1, 'a restart must not lose the mission');
    assert.equal(body.missions[0].title, 'Habit worth starting');
    assert.equal(body.source, 'stored');
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.version, 1);
    assert.equal(saved.data.missions.length, 1);
    assert.ok(!fs.existsSync(`${file}.tmp`), 'atomic write leaves no temp file');
  }, { users: [], missionsFile: file });
});

test('POST refuses bad payloads with the model\'s own message', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const cases = [
      [plan({ crew: ['writer'], steps: [{ name: 'Solo', owner: 'research' }] }), /not on this mission's crew/],
      [plan({ title: '' }), /title must be 1–160 characters/],
      [plan({ steps: 'nope' }), /a mission needs 1–12 steps/],
    ];
    for (const [payload, pattern] of cases) {
      const res = await fetch(`${base}/api/missions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
        body: JSON.stringify(payload),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(body.error, pattern);
    }
    const list = await (await fetch(`${base}/api/missions`)).json();
    assert.equal(list.missions.length, 0, 'nothing was stored');
  }, { users: [], missionsFile: file });
});

/* ── API: lifecycle over HTTP ───────────────────────────────────────── */

test('approve → advance → deliver through the API, refusing the shortcuts', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const headers = { 'content-type': 'application/json', 'x-triz-csrf': '1' };
    const post = (url, body) => fetch(`${base}${url}`, {
      method: 'POST', headers, body: body === undefined ? '{}' : JSON.stringify(body),
    });

    const created = await (await post('/api/missions', plan())).json();
    const id = created.mission.id;

    // shortcuts first
    let res = await post(`/api/missions/${id}/advance`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /is brief, not progress/);
    res = await post(`/api/missions/${id}/deliver`);
    assert.equal(res.status, 400);
    res = await post('/api/missions/NX-9999/approve');
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /does not exist/);

    // the real path
    res = await post(`/api/missions/${id}/approve`);
    let body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.mission.status, 'progress');
    assert.equal(body.mission.steps[0].startedAt !== null, true);

    res = await post(`/api/missions/${id}/advance`);
    body = await res.json();
    assert.equal(body.mission.steps[0].finishedAt !== null, true);
    assert.equal(body.mission.steps[1].startedAt !== null, true);

    res = await post(`/api/missions/${id}/advance`);
    body = await res.json();
    assert.equal(body.mission.status, 'review');
    assert.equal(body.stats.waiting.review, 1);

    res = await post(`/api/missions/${id}/reopen`);
    body = await res.json();
    assert.equal(body.mission.status, 'progress');
    assert.equal(body.mission.steps[1].finishedAt, null, 'the last step is open again');

    res = await post(`/api/missions/${id}/advance`);
    body = await res.json();
    assert.equal(body.mission.status, 'review', 'reopened missions still reach review');

    res = await post(`/api/missions/${id}/deliver`);
    body = await res.json();
    assert.equal(body.mission.status, 'delivered');
    assert.equal(body.stats.delivered.total, 1);
    assert.equal(body.stats.waiting.total, 0);

    // unknown action and bad methods
    res = await post(`/api/missions/${id}/frobnicate`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /unknown mission action/);

    res = await fetch(`${base}/api/missions/${id}`, { method: 'GET' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST, DELETE');

    res = await fetch(`${base}/api/missions`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, POST');

    res = await fetch(`${base}/api/missions/bogus`, { method: 'DELETE' });
    assert.equal(res.status, 404, 'an id the route does not recognise is not a delete');
  }, { users: [], missionsFile: file });
});

test('DELETE removes a waiting mission and refuses running or delivered ones', async () => {
  const file = tmpFile();
  await withServer(async base => {
    const headers = { 'content-type': 'application/json', 'x-triz-csrf': '1' };
    const post = (url, body) => fetch(`${base}${url}`, {
      method: 'POST', headers, body: body === undefined ? '{}' : JSON.stringify(body),
    });
    const wait = (await (await post('/api/missions', plan({ title: 'To discard' }))).json()).mission.id;
    const keep = (await (await post('/api/missions', plan({ title: 'To run' }))).json()).mission.id;

    let res = await fetch(`${base}/api/missions/${wait}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.missions.length, 1);

    await post(`/api/missions/${keep}/approve`);
    res = await fetch(`${base}/api/missions/${keep}`, { method: 'DELETE' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /is progress and cannot be deleted/);

    res = await fetch(`${base}/api/missions/${keep}`, { method: 'DELETE' });
    assert.equal(res.status, 400, 'deleting twice is refused, not silently repeated');
  }, { users: [], missionsFile: file });
});

/* ── API: honest persistence ────────────────────────────────────────── */

test('a corrupt missions file is reported, not served and not fatal', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, 'not json at all', 'utf8');
  await withServer(async base => {
    const res = await fetch(`${base}/api/missions`);
    assert.equal(res.status, 200, 'a corrupt file must not take the endpoint down');
    const body = await res.json();
    assert.deepEqual(body.missions, [], 'corrupt storage falls back to defaults');
    assert.equal(body.source, 'defaults');
    assert.match(body.error, /not valid JSON/, 'the operator is told why');

    // …and one valid write repairs the store: the next load is clean.
    const post = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify(plan()),
    });
    const created = await post.json();
    assert.equal(created.ok, true);
    assert.equal(created.source, 'stored');
    assert.equal(created.error, null, 'the stale complaint does not survive a successful write');
    const after = await (await fetch(`${base}/api/missions`)).json();
    assert.equal(after.error, null);
    assert.equal(after.source, 'stored');
  }, { users: [], missionsFile: file });
});

test('a stored document that violates the model is rejected with defaults', async () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    data: { seq: 1001, missions: [{ id: 'NX-1', title: 'bad id' }] },
  }), 'utf8');
  await withServer(async base => {
    const body = await (await fetch(`${base}/api/missions`)).json();
    assert.deepEqual(body.missions, []);
    assert.match(body.error, /stored file rejected: invalid crew; defaults apply/, 'the violated rule is named');
  }, { users: [], missionsFile: file });
});

/* ── API: the gates every mutation faces ────────────────────────────── */

test('missions require a session and a CSRF header once users exist', async () => {
  const file = tmpFile();
  const options = {
    users: [{ username: 'admin', role: 'admin', hash: ADMIN_HASH }],
    secureCookies: false,
    hermesBaseUrl: 'http://127.0.0.1:9',
    missionsFile: file,
  };
  await withServer(async base => {
    // signed out
    let res = await fetch(`${base}/api/missions`);
    assert.equal(res.status, 401, 'the mission list is not public once auth is on');
    res = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1' },
      body: JSON.stringify(plan()),
    });
    assert.equal(res.status, 401);

    // signed in, but no CSRF header
    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ username: 'admin', password: 'correct horse battery staple' }),
    });
    assert.equal(login.status, 200);
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

    res = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(plan()),
    });
    assert.equal(res.status, 403, 'a cookie without the CSRF header writes nothing');

    // signed in, right origin, right header: the write lands
    res = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', cookie, origin: base },
      body: JSON.stringify(plan()),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.mission.status, 'brief');

    // a foreign origin is refused even with cookie and header
    res = await fetch(`${base}/api/missions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-triz-csrf': '1', cookie, origin: 'https://evil.example' },
      body: JSON.stringify(plan({ title: 'Cross-site plan' })),
    });
    assert.equal(res.status, 403);

    // reads work with the session
    res = await fetch(`${base}/api/missions`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).missions.length, 1, 'only the same-origin write landed');
  }, options);
});
