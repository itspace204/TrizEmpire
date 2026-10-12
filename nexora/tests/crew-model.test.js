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
