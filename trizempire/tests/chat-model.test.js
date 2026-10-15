'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const chat = require('../crew/chat-model');

/* The same module the browser loads — these tests pin the behavior the
 * Chat view depends on: intent detection, per-seat replies that never
 * invent backend state, and the agent-to-agent mission transcript. */

test('classifyIntent recognizes the five conversational intents', () => {
  assert.equal(chat.classifyIntent('Hey'), 'greeting');
  assert.equal(chat.classifyIntent('thanks a lot'), 'thanks');
  assert.equal(chat.classifyIntent('Can you explain the deploy pipeline?'), 'question');
  assert.equal(chat.classifyIntent('What is the meaning of life?'), 'question');
  assert.equal(
    chat.classifyIntent('Mission: ship the Q4 onboarding project to the staging fleet'),
    'mission'
  );
  assert.equal(chat.classifyIntent('push the dark theme further on every panel'), 'other');
  assert.equal(chat.classifyIntent(''), 'other');
});

test('personaFor covers every crew id and falls back safely', () => {
  for (const id of ['default', 'research', 'writer', 'developer', 'data', 'staff:seo']) {
    const p = chat.personaFor(id);
    assert.ok(p.name, `persona ${id} must have a name`);
    assert.ok(p.domain, `persona ${id} must have a domain`);
  }
  const unknown = chat.personaFor('staff:new-agent');
  assert.equal(unknown.name, 'new-agent');
  assert.equal(unknown.domain, 'general');
});

test('greeting and thanks replies name the seat', () => {
  const g = chat.reply('writer', 'hello there');
  assert.match(g, /Writer/);
  assert.match(g, /writing/);
  const t = chat.reply('data', 'thank you');
  assert.match(t, /Data/);
});

test('linked replies surface the real status, unlinked replies never claim one', () => {
  const linked = chat.reply('research', 'status?', { profile: true, status: 'working' });
  assert.match(linked, /WORKING/);

  const unlinked = chat.reply('staff:travel', 'reroute the whole itinerary through Berlin');
  assert.doesNotMatch(unlinked, /WORKING|READY|IDLE/);
  assert.match(unlinked, /No live session is linked/i);
});

test('mission intent on an unlinked seat points at a linked agent instead of pretending', () => {
  const line = chat.reply('staff:sales',
    'Mission: rebuild the enterprise onboarding project end to end');
  assert.match(line, /don't have a live backend session/i);
  assert.doesNotMatch(line, /I('|\u2019)ll (start|run|execute)/i);
});

test('question and other intents echo a clipped version of the user text', () => {
  const q = chat.reply('developer', 'How should we stage the migration?');
  assert.match(q, /migration/);
  const long = 'x'.repeat(300);
  const o = chat.reply('developer', long);
  assert.ok(o.length < 400, 'reply must stay bounded for any input');
});

test('planDiscussion produces an ordered transcript covering every seat twice plus close', () => {
  const seats = ['default', 'research', 'writer', 'developer', 'data'];
  const turns = chat.planDiscussion('Launch the new pricing page project', { seats });
  // split phase, reaction phase, orchestrator close
  assert.equal(turns.length, seats.length * 2 + 1);
  assert.deepEqual(turns.slice(0, 5).map(t => t.id), seats);
  assert.deepEqual(turns.slice(5, 10).map(t => t.id), seats);
  assert.equal(turns[turns.length - 1].id, 'default');
  turns.forEach(t => {
    assert.ok(t.line && t.line.length > 10, 'every turn has a real line');
    assert.ok(t.name, 'every turn is attributed');
  });
  // the mission text itself is echoed in the opening split
  assert.match(turns[0].line, /pricing page/);
});

test('planDiscussion works with staff-only seat lists', () => {
  const seats = ['staff:marketing', 'staff:seo', 'staff:social'];
  const turns = chat.planDiscussion('Grow newsletter signups this quarter', { seats });
  assert.equal(turns.length, seats.length * 2 + 1);
  assert.deepEqual(turns.slice(0, 3).map(t => t.id), seats);
  assert.equal(turns[turns.length - 1].id, 'default');
});

test('planDiscussion defaults to the five linked crew seats', () => {
  const turns = chat.planDiscussion('Any mission at all');
  assert.deepEqual(turns.slice(0, 5).map(t => t.id),
    ['default', 'research', 'writer', 'developer', 'data']);
});

test('planDiscussion is deterministic for the same input', () => {
  const a = chat.planDiscussion('Ship the mobile app project', { seats: ['default', 'research'] });
  const b = chat.planDiscussion('Ship the mobile app project', { seats: ['default', 'research'] });
  assert.deepEqual(a, b);
});

test('exports expose the browser global shape', () => {
  assert.equal(typeof chat.reply, 'function');
  assert.equal(typeof chat.planDiscussion, 'function');
  assert.equal(typeof chat.classifyIntent, 'function');
  assert.ok(chat.PERSONAS.default);
});
