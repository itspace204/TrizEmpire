'use strict';

/* ══════════════════════════════════════════════════════════════════════
 * CREW MODEL — pure, DOM-free logic shared by the Crew command center.
 *
 * Loaded two ways:
 *   - in the browser as a classic script (window.NEXORA_MODEL)
 *   - in node tests via require() — the exact same code the UI runs.
 *
 * Contents:
 *   - OUTFITS      : the mannequin visual identity (one formal outfit per
 *                    agent, assigned deterministically from the stable id).
 *   - STATUS       : honest lifecycle states derived from the Hermes backend.
 *   - deriveStatuses(): backend status → per-agent states (never fabricated).
 *   - otherAgents()   : the DERIVED right-hand roster (selected agent excluded)
 *                    — computed with filter(), never by moving agents between
 *                    arrays, so nothing is ever duplicated or lost.
 *   - mannequinSVG()  : consistent faceless mannequin portrait, same identity
 *                    everywhere it appears (sidebar, roster, fallback stage).
 * ══════════════════════════════════════════════════════════════════════ */

/* ── mannequin visual identity ─────────────────────────────────────── */

/* Faceless premium mannequins: glossy black metallic head, formal outfit.
 * Variety follows the reference: black suits + tie, tuxedos + bow tie,
 * ivory jackets, charcoal, bronze-trimmed, midnight. No faces, ever. */
const OUTFITS = [
  { id: 'noir-tie',   jacket: '#171310', shade: '#0d0b09', shirt: '#e9e2d4', accent: '#d5b38a', tie: { kind: 'long', color: '#211c17' } },
  { id: 'tux-bow',    jacket: '#121010', shade: '#0a0909', shirt: '#f3ede1', accent: '#e3c795', tie: { kind: 'bow',  color: '#100e0d' } },
  { id: 'ivory',      jacket: '#e6dcc6', shade: '#c9bd9f', shirt: '#191512', accent: '#a98c58', tie: { kind: 'long', color: '#171310' } },
  { id: 'charcoal',   jacket: '#221e1a', shade: '#16130f', shirt: '#ded4c2', accent: '#d5b38a', tie: { kind: 'long', color: '#5c4a32' } },
  { id: 'bronze',     jacket: '#2b2018', shade: '#191209', shirt: '#e8ddc8', accent: '#caa066', tie: { kind: 'bow',  color: '#caa066' } },
  { id: 'midnight',   jacket: '#151823', shade: '#0d0f16', shirt: '#e7e2d8', accent: '#d5b38a', tie: { kind: 'long', color: '#1c2030' } },
];

/* Short presentational role labels for known profiles; any other profile
 * (the live Hermes list can grow) falls back to its own name. These label
 * the agent's domain only — they do not imply any backend capability. */
const ROLE = {
  default: 'COMMAND',
  research: 'RESEARCH',
  writer: 'WRITING',
  developer: 'ENGINEERING',
  data: 'ANALYTICS',
};

/* Stable hash (FNV-1a style) → the same agent always gets the same
 * mannequin outfit, everywhere it appears. */
function hashId(str) {
  let h = 2166136261 >>> 0;
  const s = String(str || 'default');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function outfitFor(profileId) {
  return OUTFITS[hashId(profileId) % OUTFITS.length];
}

function roleFor(profileId) {
  return ROLE[profileId] || String(profileId || 'agent').toUpperCase();
}

/* ── honest status vocabulary ──────────────────────────────────────── */

/* States the Hermes backend can actually evidence:
 *   working — counted among the active agents
 *   ready   — gateway up, nothing running
 *   idle    — gateway up, others are working
 *   offline — gateway down / backend unreachable
 * "Thinking"/"Completed" are deliberately absent: the backend cannot
 * evidence them, and this project never fabricates state. */
const STATUS = {
  working: { css: '#ff4d4d', text: 'WORKING' },
  ready:   { css: '#3ddc84', text: 'READY' },
  idle:    { css: '#4aa8ff', text: 'IDLE' },
  offline: { css: '#a06bff', text: 'OFFLINE' },
};

function statusInfo(key) {
  return STATUS[key] || STATUS.offline;
}

/* Backend status object → { [profile]: statusKey }. Mirrors the Agent City
 * derivation so both views always agree. */
function deriveStatuses(status, profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  const map = {};
  if (!status || status.gateway_running !== true) {
    list.forEach(p => { map[p] = 'offline'; });
    return map;
  }
  const working = Math.min(Number(status.active_agents) || 0, list.length);
  list.forEach((p, i) => {
    map[p] = i < working ? 'working' : (working > 0 ? 'idle' : 'ready');
  });
  return map;
}

/* Real per-agent facts ({ profile, activeSessions, sessions, ... } from
 * GET /api/hermes/agents) → { [profile]: statusKey }.
 *
 * Evidence rules — nothing is inferred beyond what the backend reports:
 *   gateway down              → every agent offline (same as deriveStatuses)
 *   activeSessions > 0        → working  (Hermes stamped is_active itself)
 *   no active session here,
 *   but someone else active   → idle
 *   nobody active             → ready
 * A crew member Hermes never mentions counts as having no active session —
 * never as working. gatewayRunning is deliberately NOT used to claim
 * 'offline': Hermes serves many profiles from one shared gateway, so a false
 * per-profile flag does not mean that agent is unreachable. */
function deriveStatusesFromAgents(facts, profiles, status) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (!status || status.gateway_running !== true) return deriveStatuses(status, list);
  const byProfile = new Map();
  (Array.isArray(facts) ? facts : []).forEach(f => {
    if (f && typeof f.profile === 'string') byProfile.set(f.profile, f);
  });
  const working = new Set(list.filter(p => Number(byProfile.get(p)?.activeSessions) > 0));
  const map = {};
  list.forEach(p => {
    map[p] = working.has(p) ? 'working' : (working.size > 0 ? 'idle' : 'ready');
  });
  return map;
}

/* ── how busy a building looks in the Agent City ──────────────────── */

/* Real per-agent facts → the two visual channels of a building:
 *
 *   heat ← the strongest evidence of work, either
 *            load  = activeSessions (Hermes' own is_active flag), or
 *            warmth = how recently this profile last touched a session,
 *                     cooling linearly to nothing after COOL_SEC.
 *   beat ← activeSessions only: how fast the building pulses. Zero when
 *          nothing is running, so a building that merely worked recently is
 *          warm but still — "working" and "worked" must not look alike.
 *
 * A profile the backend says nothing about gets NO facts at all and both
 * channels stay zero: the building looks exactly as it did before this
 * existed. lastActiveAgeSec of null is "no usable timestamp" — never "just
 * now" (Number(null) is 0, which would light every untouched building as
 * freshly active). Nothing is interpolated, averaged or assumed. */
const ACTIVITY_COOL_SEC = 1800;   // warmth reaches zero half an hour after the last activity
const ACTIVITY_TICK_MAX = 4;      // concurrent sessions that read as flat out
const ACTIVITY_BEAT_SLOW = 2600, ACTIVITY_BEAT_FAST = 1160;

function activityFor(fact) {
  if (!fact || typeof fact !== 'object') return { heat: 0, beat: 0 };
  const active = Math.max(0, Number(fact.activeSessions) || 0);
  const age = typeof fact.lastActiveAgeSec === 'number' && Number.isFinite(fact.lastActiveAgeSec)
    && fact.lastActiveAgeSec >= 0 ? fact.lastActiveAgeSec : null;
  const load = Math.min(active, ACTIVITY_TICK_MAX) / ACTIVITY_TICK_MAX;
  const warmth = age === null ? 0 : Math.max(0, 1 - age / ACTIVITY_COOL_SEC) * .6;
  const beat = active > 0
    ? Math.round(ACTIVITY_BEAT_SLOW
      - (Math.min(active, ACTIVITY_TICK_MAX) - 1) * (ACTIVITY_BEAT_SLOW - ACTIVITY_BEAT_FAST)
        / (ACTIVITY_TICK_MAX - 1))
    : 0;
  return { heat: +Math.max(load, warmth).toFixed(3), beat };
}

/* ── isolated workspaces (cockpit cards) ──────────────────────────── */

/* The cockpit's ISOLATED WORKSPACES cards are an organizational view over
 * the SAME live profiles the crew uses. Membership is explicit here — one
 * home per profile — so a card can never silently duplicate an agent.
 * Defaults below ship with the Client card honestly empty; an operator
 * assigns agents to it (and rearranges any card) through the UI, and the
 * server persists the mapping — see withAssignments(). Profiles no table
 * mentions (the live Hermes list can grow) belong to no card and stay
 * reachable through the Crew view. */
const WORKSPACES = [
  { id: 'content',  name: 'Content',  hero: true,  profiles: ['writer', 'research'] },
  { id: 'work',     name: 'Work',     hero: false, profiles: ['developer', 'data'] },
  { id: 'personal', name: 'Personal', hero: false, profiles: ['default'] },
  { id: 'client',   name: 'Client',   hero: false, profiles: [] },
];

/* Workspace → its real crew members, in the workspace's declared order.
 * Pure: never mutates the crew list, unknown ids are skipped honestly. */
function agentsInWorkspace(workspace, crew) {
  const ids = workspace && Array.isArray(workspace.profiles) ? workspace.profiles : [];
  const list = Array.isArray(crew) ? crew : [];
  return ids
    .map(id => list.find(c => c && c.profile === id))
    .filter(Boolean);
}

/* Which workspace owns this profile — null when unassigned. */
function workspaceForProfile(profile) {
  return WORKSPACES.find(ws => Array.isArray(ws.profiles) && ws.profiles.includes(profile)) || null;
}

/* Operator overrides, persisted by the server (PUT /api/workspaces) and
 * handed back on load (GET /api/workspaces). Pure: returns a NEW workspace
 * array — the default table is never mutated, so a bad assignment can always
 * be escaped by falling back to the defaults. Only workspace ids present in
 * `assignments` are replaced; everything else keeps its default membership.
 * The server validates the map (known ids, one home per profile) before it
 * is ever stored; here unknown ids are simply skipped, never trusted. */
function withAssignments(workspaces, assignments) {
  const base = Array.isArray(workspaces) ? workspaces : [];
  const map = (assignments && typeof assignments === 'object' && !Array.isArray(assignments))
    ? assignments
    : {};
  return base.map(ws => {
    if (!Object.prototype.hasOwnProperty.call(map, ws.id)) {
      return Object.assign({}, ws, { profiles: (Array.isArray(ws.profiles) ? ws.profiles : []).slice() });
    }
    const ids = Array.isArray(map[ws.id])
      ? map[ws.id].filter(id => typeof id === 'string' && id.length > 0)
      : [];
    return Object.assign({}, ws, { profiles: ids });
  });
}

/* ── derived roster ────────────────────────────────────────────────── */

/* The right-hand roster is ALWAYS derived from the complete collection:
 * filter by id, never mutate, never dedupe-by-hand. The previously
 * selected agent therefore reappears automatically and no agent can be
 * duplicated or lost, whatever the selection history. */
function otherAgents(agents, selectedId) {
  return (Array.isArray(agents) ? agents : [])
    .filter(a => a && a.id !== selectedId);
}

/* ── mannequin portrait (SVG data URI) ─────────────────────────────── */

function escAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* A consistent, faceless mannequin bust: glossy black head, tailored
 * shoulders, champagne-gold piping. Same identity source as the 3D stage
 * (both read outfitFor), so thumbnails and the central figure agree. */
function mannequinSVG(agent, outfit) {
  const o = outfit || outfitFor(agent && (agent.id || agent.profile));
  const gold = escAttr(o.accent);
  const shirt = escAttr(o.shirt);
  const tieColor = escAttr(o.tie.color);
  const tieShape = o.tie.kind === 'bow'
    ? '<path d="M41 68.5 L50 72.5 L50 64.5 Z" fill="' + tieColor + '"/>'
      + '<path d="M59 68.5 L50 72.5 L50 64.5 Z" fill="' + tieColor + '"/>'
    : '<path d="M47.4 72 L52.6 72 L54 95 L50 98.5 L46 95 Z" fill="' + tieColor + '"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="Mannequin portrait">'
    + '<defs>'
    + '<radialGradient id="bg" cx="50%" cy="32%" r="82%"><stop offset="0" stop-color="#241a12"/><stop offset="1" stop-color="#0b0908"/></radialGradient>'
    + '<linearGradient id="jk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + escAttr(o.jacket) + '"/><stop offset="1" stop-color="' + escAttr(o.shade) + '"/></linearGradient>'
    + '<radialGradient id="hd" cx="35%" cy="25%" r="88%"><stop offset="0" stop-color="#635948"/><stop offset=".38" stop-color="#211d19"/><stop offset="1" stop-color="#0a0908"/></radialGradient>'
    + '<linearGradient id="gd" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f2e0b8"/><stop offset="1" stop-color="' + gold + '"/></linearGradient>'
    + '</defs>'
    + '<circle cx="50" cy="50" r="50" fill="url(#bg)"/>'
    + '<path d="M8 100 C10 77 26 67 50 67 C74 67 90 77 92 100 Z" fill="url(#jk)"/>'
    + '<path d="M38.5 69.5 C42.5 80 46 86.5 50 92.5" fill="none" stroke="url(#gd)" stroke-width="1.15" opacity=".9"/>'
    + '<path d="M61.5 69.5 C57.5 80 54 86.5 50 92.5" fill="none" stroke="url(#gd)" stroke-width="1.15" opacity=".9"/>'
    + '<path d="M39 66.5 L50 73 L61 66.5 L56 63.5 L44 63.5 Z" fill="' + shirt + '"/>'
    + tieShape
    + '<rect x="43" y="51" width="14" height="15" rx="6.4" fill="#151210"/>'
    + '<ellipse cx="50" cy="37.5" rx="15.5" ry="19.5" fill="url(#hd)"/>'
    + '<path d="M37.5 26.5 C42.5 20.5 57.5 20.5 62.5 26.5" fill="none" stroke="' + gold + '" stroke-width="1.3" opacity=".55"/>'
    + '</svg>';
}

function avatarDataURI(agent, outfit) {
  return 'data:image/svg+xml,' + encodeURIComponent(mannequinSVG(agent, outfit));
}

/* ── exports ───────────────────────────────────────────────────────── */

const NEXORA_MODEL = {
  OUTFITS,
  ROLE,
  STATUS,
  WORKSPACES,
  hashId,
  outfitFor,
  roleFor,
  statusInfo,
  deriveStatuses,
  deriveStatusesFromAgents,
  activityFor,
  agentsInWorkspace,
  workspaceForProfile,
  withAssignments,
  otherAgents,
  mannequinSVG,
  avatarDataURI,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = NEXORA_MODEL;
}
if (typeof window !== 'undefined') {
  window.NEXORA_MODEL = NEXORA_MODEL;
}
