'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../crew/crew-model');

/* The same module the browser loads — these tests pin the behavior the
 * Crew command center UI depends on: derived roster (never mutated),
 * stable mannequin identity, and honest status derivation. */

const AGENTS = [
  { id: 'default', name: 'Orchestrator' },
  { id: 'research', name: 'Research' },
  { id: 'writer', name: 'Writer' },
  { id: 'developer', name: 'Developer' },
  { id: 'data', name: 'Data' },
];

test('otherAgents excludes the selected agent and preserves order', () => {
  const others = model.otherAgents(AGENTS, 'writer');
  assert.deepEqual(others.map(a => a.id), ['default', 'research', 'developer', 'data']);
});

test('selecting repeatedly never duplicates or loses agents', () => {
  // Walk through a selection history like the UI produces.
  let selected = 'default';
  const history = ['writer', 'developer', 'writer', 'default', 'data'];
  for (const next of history) {
    selected = next;
    const roster = model.otherAgents(AGENTS, selected);
    const ids = roster.map(a => a.id);
    // No agent twice in the roster...
    assert.equal(new Set(ids).size, ids.length);
    // ...the selected agent is out of it...
    assert.ok(!ids.includes(selected));
    // ...the full collection is untouched, and roster + center = all agents.
    assert.equal(AGENTS.length, 5);
    assert.equal(roster.length + 1, AGENTS.length);
  }
});

test('otherAgents never mutates the source collection', () => {
  const before = AGENTS.map(a => a.id);
  model.otherAgents(AGENTS, 'research');
  model.otherAgents(AGENTS, 'default');
  assert.deepEqual(AGENTS.map(a => a.id), before);
});

test('otherAgents handles empty, unknown and single-agent collections', () => {
  assert.deepEqual(model.otherAgents([], 'default'), []);
  assert.deepEqual(model.otherAgents(AGENTS, 'nobody-here').length, 5);
  const single = [{ id: 'default' }];
  assert.deepEqual(model.otherAgents(single, 'default'), []);
});

test('mannequin identity is stable per agent id', () => {
  for (const a of AGENTS) {
    assert.equal(model.outfitFor(a.id), model.outfitFor(a.id));
  }
  // Outfits always come from the declared identity set.
  for (const a of AGENTS) {
    assert.ok(model.OUTFITS.includes(model.outfitFor(a.id)));
    assert.ok(model.outfitFor(a.id).tie.kind === 'long' || model.outfitFor(a.id).tie.kind === 'bow');
  }
});

test('every declared outfit is faceless — no facial features in the SVG', () => {
  for (const outfit of model.OUTFITS) {
    const svg = model.mannequinSVG({ id: 'probe' }, outfit);
    assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    // Head + shoulders + gold piping present.
    assert.match(svg, /ellipse/);
    assert.match(svg, /url\(#jk\)/);
    // No eyes, mouth, nose, hair anywhere in the identity set.
    assert.doesNotMatch(svg, /eye|mouth|nose|hair|face\b/i);
  }
});

test('avatarDataURI produces an inline-safe SVG data URI', () => {
  const uri = model.avatarDataURI(AGENTS[0]);
  assert.ok(uri.startsWith('data:image/svg+xml,'));
  // Must not contain raw quotes or angle brackets that would break an img attr.
  const payload = uri.slice('data:image/svg+xml,'.length);
  assert.doesNotMatch(payload, /[<>"]/);
});

test('deriveStatuses is honest: offline when the gateway is down', () => {
  const ids = AGENTS.map(a => a.id);
  assert.deepEqual(model.deriveStatuses(null, ids),
    Object.fromEntries(ids.map(id => [id, 'offline'])));
  assert.deepEqual(model.deriveStatuses({ gateway_running: false }, ids),
    Object.fromEntries(ids.map(id => [id, 'offline'])));
});

test('deriveStatuses maps active agents to working, the rest to idle', () => {
  const ids = AGENTS.map(a => a.id);
  const map = model.deriveStatuses({ gateway_running: true, active_agents: 2 }, ids);
  assert.equal(map.default, 'working');
  assert.equal(map.research, 'working');
  assert.equal(map.writer, 'idle');
  assert.equal(map.data, 'idle');
});

test('deriveStatuses reports ready when the gateway is up with nothing running', () => {
  const ids = AGENTS.map(a => a.id);
  const map = model.deriveStatuses({ gateway_running: true, active_agents: 0 }, ids);
  for (const id of ids) assert.equal(map[id], 'ready');
});

/* ── real per-agent facts → states ───────────────────────────────────── */

test('deriveStatusesFromAgents marks exactly the profiles with an active session', () => {
  const ids = AGENTS.map(a => a.id);
  const facts = [
    { profile: 'default', sessions: 4, activeSessions: 0, lastActiveAgeSec: 900 },
    { profile: 'research', sessions: 1, activeSessions: 2, lastActiveAgeSec: 3 },
    { profile: 'writer', sessions: 0, activeSessions: 0, lastActiveAgeSec: null },
  ];
  const map = model.deriveStatusesFromAgents(facts, ids, { gateway_running: true, active_agents: 3 });
  assert.equal(map.research, 'working', 'its own sessions say so');
  assert.equal(map.default, 'idle', 'someone else is working');
  assert.equal(map.writer, 'idle');
  assert.equal(map.data, 'idle', 'a profile Hermes never mentioned is never working');
  // Per-agent facts beat the global count: 3 agents are "active" upstream,
  // but only research has session evidence here.
  assert.notEqual(map.default, 'working');
});

test('deriveStatusesFromAgents reports ready when no session is active anywhere', () => {
  const ids = AGENTS.map(a => a.id);
  const facts = ids.map(profile => ({ profile, sessions: 2, activeSessions: 0, lastActiveAgeSec: 45 }));
  const map = model.deriveStatusesFromAgents(facts, ids, { gateway_running: true, active_agents: 1 });
  for (const id of ids) assert.equal(map[id], 'ready');
});

test('deriveStatusesFromAgents stays offline for every agent when the gateway is down', () => {
  const ids = AGENTS.map(a => a.id);
  const facts = ids.map(profile => ({ profile, sessions: 1, activeSessions: 5, lastActiveAgeSec: 0 }));
  const map = model.deriveStatusesFromAgents(facts, ids, { gateway_running: false });
  for (const id of ids) assert.equal(map[id], 'offline');
  assert.deepEqual(model.deriveStatusesFromAgents(null, ids, null),
    Object.fromEntries(ids.map(id => [id, 'offline'])));
});

test('deriveStatusesFromAgents returns every crew profile and mutates nothing', () => {
  const ids = AGENTS.map(a => a.id);
  const facts = [{ profile: 'default', sessions: 1, activeSessions: 1, lastActiveAgeSec: 1 }];
  const snapshot = JSON.stringify(facts);
  const map = model.deriveStatusesFromAgents(facts, ids, { gateway_running: true });
  assert.deepEqual(Object.keys(map).sort(), [...ids].sort());
  assert.equal(JSON.stringify(facts), snapshot, 'facts must not be mutated');
  assert.deepEqual(AGENTS.map(a => a.id), ['default', 'research', 'writer', 'developer', 'data']);
});

test('statusInfo covers every declared state and defaults to offline', () => {
  for (const key of Object.keys(model.STATUS)) {
    const info = model.statusInfo(key);
    assert.match(info.css, /^#[0-9a-f]{6}$/i);
    assert.ok(info.text.length > 0);
  }
  assert.equal(model.statusInfo('bogus').text, 'OFFLINE');
});

/* ── isolated workspaces (cockpit cards) ────────────────────────────── */

test('workspace membership maps real crew profiles, one home per profile', () => {
  const crew = ['default', 'research', 'writer', 'developer', 'data'].map(profile => ({ profile }));
  const byId = id => model.WORKSPACES.find(w => w.id === id);
  assert.deepEqual(model.agentsInWorkspace(byId('content'), crew).map(a => a.profile),
    ['writer', 'research']);
  assert.deepEqual(model.agentsInWorkspace(byId('work'), crew).map(a => a.profile),
    ['developer', 'data']);
  assert.deepEqual(model.agentsInWorkspace(byId('personal'), crew).map(a => a.profile),
    ['default']);
  // No agent may appear in two cards, and the hero card stays Content.
  const homes = model.WORKSPACES.flatMap(w => w.profiles);
  assert.equal(new Set(homes).size, homes.length, 'a profile must have exactly one workspace');
  assert.equal(byId('content').hero, true);
});

test('workspaceForProfile resolves assigned profiles and returns null otherwise', () => {
  assert.equal(model.workspaceForProfile('writer').id, 'content');
  assert.equal(model.workspaceForProfile('developer').id, 'work');
  assert.equal(model.workspaceForProfile('default').id, 'personal');
  assert.equal(model.workspaceForProfile('no-such-profile'), null);
  assert.equal(model.workspaceForProfile(undefined), null);
});test('agentsInWorkspace is pure: skips unknown ids, mutates nothing', () => {
  const crew = [{ profile: 'writer', name: 'Writer' }];
  const before = JSON.stringify(crew);
  const client = model.WORKSPACES.find(w => w.id === 'client');
  assert.deepEqual(model.agentsInWorkspace(client, crew), [], 'Client starts honestly empty');
  assert.deepEqual(model.agentsInWorkspace({ profiles: ['ghost'] }, crew), []);
  assert.deepEqual(model.agentsInWorkspace(null, crew), []);
  assert.deepEqual(model.agentsInWorkspace(client, null), []);
  assert.equal(JSON.stringify(crew), before, 'the crew list must not be mutated');
});

/* ── operator overrides (persisted by the server) ──────────────────── */
test('withAssignments applies operator overrides without mutating the defaults', () => {
  const snapshot = JSON.stringify(model.WORKSPACES);
  const next = model.withAssignments(model.WORKSPACES, { client: ['data'] });
  const byId = (list, id) => list.find(w => w.id === id);
  assert.deepEqual(byId(next, 'client').profiles, ['data'], 'operator assignment lands');
  assert.deepEqual(byId(next, 'personal').profiles, ['default'], 'untouched cards keep defaults');
  assert.deepEqual(byId(next, 'content').profiles, ['writer', 'research']);
  assert.equal(JSON.stringify(model.WORKSPACES), snapshot, 'the default table must not be mutated');
  assert.notEqual(next, model.WORKSPACES, 'a NEW array is returned');
});
test('withAssignments keeps one home per profile across the merged result', () => {
  // Moving data out of Work and into Client must remove it from Work too:
  // the override replaces the whole card, so nothing is ever listed twice.
  const next = model.withAssignments(model.WORKSPACES, { work: ['developer'], client: ['data'] });
  const homes = next.flatMap(w => w.profiles);
  assert.equal(new Set(homes).size, homes.length, 'a profile must have exactly one workspace');
  assert.deepEqual(next.find(w => w.id === 'client').profiles, ['data']);
  assert.deepEqual(next.find(w => w.id === 'work').profiles, ['developer']);
});
test('withAssignments ignores junk instead of trusting it', () => {
  const defaults = model.withAssignments(model.WORKSPACES, null);
  assert.deepEqual(defaults.map(w => w.profiles),
    model.WORKSPACES.map(w => w.profiles), 'null assignments = defaults');
  assert.deepEqual(model.withAssignments(model.WORKSPACES, []),
    model.WORKSPACES.map(w => Object.assign({}, w, { profiles: w.profiles.slice() })),
    'an array is not an assignment map');
  const junk = model.withAssignments(model.WORKSPACES, { client: 'data', ghost: ['x'], personal: [42, ''] });
  assert.deepEqual(junk.find(w => w.id === 'client').profiles, [], 'non-array entry = empty card');
  assert.deepEqual(junk.find(w => w.id === 'personal').profiles, [], 'non-string/empty ids are dropped');
  assert.equal(junk.find(w => w.id === 'ghost'), undefined, 'unknown workspace ids do not invent cards');
  assert.deepEqual(junk.find(w => w.id === 'content').profiles, ['writer', 'research']);
});
test('withAssignments can empty a card and works on any workspace list', () => {
  const next = model.withAssignments(model.WORKSPACES, { personal: [] });
  assert.deepEqual(next.find(w => w.id === 'personal').profiles, [], 'an empty array empties the card');
  const custom = [{ id: 'solo', name: 'Solo', profiles: ['a'] }];
  assert.deepEqual(model.withAssignments(custom, { solo: ['b', 'a'] }).map(w => w.profiles), [['b', 'a']],
    'order follows the operator\'s list');
  assert.deepEqual(model.withAssignments(null, {}), [], 'a non-list base yields nothing');
});

/* ── building activity in the Agent City (glow + pulse) ────────────── */

/* Two channels, two kinds of evidence: heat is how busy or how recently
 * busy, beat is what is running RIGHT NOW. These pin that split, and that
 * missing evidence never turns into invented activity. */

test('activityFor: no facts at all means no activity', () => {
  assert.deepEqual(model.activityFor(null), { heat: 0, beat: 0 });
  assert.deepEqual(model.activityFor(undefined), { heat: 0, beat: 0 });
  assert.deepEqual(model.activityFor('nonsense'), { heat: 0, beat: 0 });
});

test('activityFor: a null timestamp is no evidence, never "just now"', () => {
  // Hermes reports null for a profile whose sessions carry no usable time.
  const none = model.activityFor({ profile: 'data', activeSessions: 0, sessions: 0, lastActiveAgeSec: null });
  assert.deepEqual(none, { heat: 0, beat: 0 }, 'an untouched building must stay flat');
});

test('activityFor: concurrency drives the pulse, and only concurrency does', () => {
  const beatOf = n => model.activityFor({ activeSessions: n, lastActiveAgeSec: 1e6 }).beat;
  assert.equal(beatOf(0), 0, 'nothing running: no pulse, however recently it worked');
  assert.equal(beatOf(1), 2600);
  assert.equal(beatOf(2), 2120);
  assert.equal(beatOf(4), 1160, 'flat out');
  assert.equal(beatOf(9), 1160, 'more than flat out cannot be faster');
  assert.ok(beatOf(3) > beatOf(4) && beatOf(3) < beatOf(2), 'monotonic between the ends');
});

test('activityFor: running sessions outweigh mere warmth', () => {
  const recent = model.activityFor({ activeSessions: 0, lastActiveAgeSec: 60 });
  const running = model.activityFor({ activeSessions: 3, lastActiveAgeSec: 60 });
  assert.ok(recent.heat > 0 && recent.beat === 0, 'a building that just worked is warm but still');
  assert.equal(running.heat, .75, 'load 3 of 4');
  assert.ok(running.heat > recent.heat);
});

test('activityFor: warmth cools to nothing on its own ramp', () => {
  const heat = age => model.activityFor({ activeSessions: 0, lastActiveAgeSec: age }).heat;
  assert.ok(heat(0) > heat(600), 'cooling');
  assert.ok(heat(600) > heat(1500));
  assert.equal(heat(1800), 0, 'half an hour later it is done');
  assert.equal(heat(10800), 0, 'and stays done');
  assert.equal(heat(0), .6, 'fresh warmth alone tops out below a running session');
});

test('activityFor: junk numbers can neither brighten nor darken wrongly', () => {
  // A negative concurrency and a timestamp in the future are clock skew and
  // nonsense respectively — both are refused, not clamped into activity.
  assert.deepEqual(model.activityFor({ activeSessions: -5, lastActiveAgeSec: -5 }), { heat: 0, beat: 0 });
  assert.deepEqual(model.activityFor({ activeSessions: 'x', lastActiveAgeSec: 'x' }), { heat: 0, beat: 0 });
  assert.deepEqual(model.activityFor({ activeSessions: NaN, lastActiveAgeSec: Infinity }), { heat: 0, beat: 0 });
  const many = model.activityFor({ activeSessions: 99, lastActiveAgeSec: 0 });
  assert.equal(many.heat, 1, 'heat is capped at 1');
  assert.equal(many.beat, 1160);
});

test('activityFor never mutates the fact it is given', () => {
  const fact = { profile: 'writer', activeSessions: 2, sessions: 7, lastActiveAgeSec: 30 };
  const before = JSON.stringify(fact);
  model.activityFor(fact);
  assert.equal(JSON.stringify(fact), before);
});
