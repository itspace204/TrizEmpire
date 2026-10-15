/* ══════ AGENT CITY — isometric district (the reference artwork) ══════
   The artwork is an exact crop of the reference frame, embedded as a WebP
   data URI (window.CITY_ASSETS, injected by nexora/city-inject.js). The two
   dark panels baked into the artwork are covered by live ones: the legend
   bottom-left and the agent card bottom-right.

   Every building in the artwork is a station: its own label pill is the
   pointer target (hovering lights the pill), and the chip hanging under it
   carries the live status of the agent that runs that building. Selecting a
   station updates this card, the crew view and the roster. Under the pill,
   the building itself glows and beats from Hermes' real per-profile session
   facts — see activityFor() below.

   The building→agent map is a design-time constant of this district view (the
   same kind of mapping the old orbital map made with its five pods) — it is
   not backend data. Live status and every number come from Hermes; anything
   the backend cannot evidence stays an em dash. */
const MODEL = window.NEXORA_MODEL;
const ASSETS = window.CITY_ASSETS || {};

const wrap = document.getElementById('city-wrap');
const stage = document.getElementById('city-stage');
const art = document.getElementById('city-art');
const ccEyebrow = document.getElementById('cc-eyebrow');
const ccName = document.getElementById('cc-name');
const ccSub = document.getElementById('cc-sub');
const ccSessions = document.getElementById('cc-sessions');
const ccTokens = document.getElementById('cc-tokens');

/* Source geometry, measured on the 1920x1080 reference (nexora/city-crop.js):
   the artwork crop is 1708x864 starting at (106,99). x/y/w/h below are each
   building's label pill relative to that crop; the chip hangs below it.
   `primary` marks the building a profile's card shows by default. */
const SW = ASSETS.w || 1708, SH = ASSETS.h || 864;
const BUILDINGS = [
  { id: 'executor-hq',       name: 'Executor HQ',        x: 800,  y: 233, w: 110, h: 36, profile: 'default',   primary: true },
  { id: 'care-center',       name: 'Care Center',        x: 152,  y: 437, w: 104, h: 32, profile: 'default' },
  { id: 'deal-desk',         name: 'Deal Desk',          x: 204,  y: 539, w: 92,  h: 33, profile: 'default' },
  { id: 'code-foundry',      name: 'Code Foundry',       x: 436,  y: 126, w: 118, h: 33, profile: 'developer', primary: true },
  { id: 'signal-tower',      name: 'Signal Tower',       x: 1362, y: 218, w: 109, h: 33, profile: 'developer' },
  { id: 'research-institute',name: 'Research Institute', x: 528,  y: 245, w: 150, h: 32, profile: 'research',  primary: true },
  { id: 'travel-studio',     name: 'Travel Studio',      x: 677,  y: 116, w: 113, h: 33, profile: 'research' },
  { id: 'content-atelier',   name: 'Content Atelier',    x: 1118, y: 495, w: 127, h: 32, profile: 'writer',    primary: true },
  { id: 'growth-studio',     name: 'Growth Studio',      x: 917,  y: 57,  w: 122, h: 32, profile: 'writer' },
  { id: 'design-loft',       name: 'Design Loft',        x: 1382, y: 619, w: 99,  h: 34, profile: 'writer' },
  { id: 'studio-stage',      name: 'Studio Stage',       x: 1046, y: 724, w: 113, h: 33, profile: 'writer' },
  { id: 'data-citadel',      name: 'Data Citadel',       x: 463,  y: 446, w: 109, h: 32, profile: 'data',      primary: true },
  { id: 'ledger-house',      name: 'Ledger House',       x: 554,  y: 751, w: 117, h: 33, profile: 'data' },
];

art.src = ASSETS.art || '';

const crew = () => (window.TrizEmpire && window.TrizEmpire.CREW) || [];
const statuses = () => window.__crewStatuses || (window.TrizEmpire && window.TrizEmpire.statuses) || {};
const currentProfile = () => (window.TrizEmpire && window.TrizEmpire.currentProfile) || 'default';
const nickOf = profile => (window.TrizEmpire && window.TrizEmpire.NICK && window.TrizEmpire.NICK[profile]) || profile;
const statusKey = profile => statuses()[profile] || 'offline';
const factOf = profile => (window.TrizEmpire && window.TrizEmpire.factOf && window.TrizEmpire.factOf(profile)) || null;
const factLine = profile => (window.TrizEmpire && window.TrizEmpire.factLine && window.TrizEmpire.factLine(profile)) || '';
const buildingById = id => BUILDINGS.find(b => b.id === id) || null;

/* What a building shows about its agent — { heat, beat } — is derived in the
   shared crew model (activityFor), where the evidence rules and the cooling
   ramp are unit-tested against the same code the UI runs. This module only
   turns the result into a pool of light and a pulse.

   The model is a separate script the browser may still hold in cache from an
   earlier build (scripts are served with a max-age), while this page is
   fresh: without the guard below that mismatch would throw inside paint. A
   model that cannot answer means no visuals — never a broken board. */
function activityFor(profile) {
  return MODEL && typeof MODEL.activityFor === 'function'
    ? MODEL.activityFor(factOf(profile))
    : { heat: 0, beat: 0 };
}

/* The status colours arrive as hex; the CSS wants channels it can put an
   alpha on (rgba(var(--rgb), …)). */
function rgbChannels(hex) {
  const h = String(hex || '').replace('#', '');
  const flat = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const v = parseInt(flat, 16);
  return Number.isFinite(v) ? ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) : '255,255,255';
}

let selectedId = null;
/* The selected station follows the app-wide profile selection; when that
   profile changes elsewhere (crew view, roster) its primary building takes
   over, so the card always describes the agent the operator is looking at. */
function selectedBuilding() {
  const held = buildingById(selectedId);
  if (held && held.profile === currentProfile()) return held;
  const profile = currentProfile();
  const next = BUILDINGS.find(b => b.profile === profile && b.primary)
    || BUILDINGS.find(b => b.profile === profile)
    || BUILDINGS[0];
  selectedId = next.id;
  return next;
}

function selectBuilding(id) {
  const b = buildingById(id);
  if (!b) return;
  selectedId = b.id;
  window.TrizEmpire.currentProfile = b.profile;   /* syncs crew view + roster */
  paint();
}

/* ── the board: artwork + every overlay live in one 3D-transformed stage ──
   Panels, stations and the artwork itself share a single transform, so the
   live panels keep covering the reference's baked ones at any zoom or pan,
   and the chips stay on their buildings. Wheels zoom toward the cursor, a
   drag pans, shift/right-drag turns the board (vertical motion tilts it,
   horizontal motion orbits it), double-click (or 0) resets. On top of that
   the board is a stack of planes in one 3D scene and leans a degree or two
   with the pointer — depth only, nothing about the artwork or its design. */
const VIEW = { zoom: 1, panX: 0, panY: 0, tilt: 13, yaw: 0 };
const ZOOM_MIN = 0.65, ZOOM_MAX = 4, TILT_MIN = 0, TILT_MAX = 32, TILT_HOME = 13;
const YAW_MIN = -20, YAW_MAX = 20;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const cosTilt = () => Math.cos(VIEW.tilt * Math.PI / 180);
const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/* ── pointer parallax: the board leans with the cursor ──
   Presentation, not content: the angle you view the district from follows the
   pointer by a degree or two, so the ground and the labels sitting above it
   slide against each other. Never saved, never on under reduced motion, and
   held at zero while the operator is already dragging. */
const PARRY_YAW = 2.2, PARRY_TILT = 1.4;
const PAR = { yaw: 0, tilt: 0, tYaw: 0, tTilt: 0 };
let parFrame = 0;

function parallaxTo(nx, ny) {
  const on = !reducedMotion() && !drag;
  PAR.tYaw = on ? clamp(nx * PARRY_YAW, -PARRY_YAW, PARRY_YAW) : 0;
  PAR.tTilt = on ? clamp(ny * PARRY_TILT, -PARRY_TILT, PARRY_TILT) : 0;
  if (!parFrame) parFrame = requestAnimationFrame(stepParallax);
}

function stepParallax() {
  parFrame = 0;
  PAR.yaw += (PAR.tYaw - PAR.yaw) * .18;
  PAR.tilt += (PAR.tTilt - PAR.tilt) * .18;
  const moving = Math.abs(PAR.tYaw - PAR.yaw) > .02 || Math.abs(PAR.tTilt - PAR.tilt) > .02;
  if (moving) parFrame = requestAnimationFrame(stepParallax);
  else { PAR.yaw = PAR.tYaw; PAR.tilt = PAR.tTilt; }
  applyView();
}

/* ── the pose outlives the tab ──
   The operator's viewing angle is a browser-local preference, never server
   state: one entry, no identifiers, nothing else. Each field is validated and
   re-clamped on read, so a stale or hand-edited entry can only ever put the
   board back inside its own limits — never off screen. A hidden view reports
   a zero-size holder, so the px pan is also re-clamped by fit() on the way
   back in. Storage can be unavailable (private mode, blocked site data); then
   the board simply opens at home. */
const POSE_KEY = 'trizempire.city-pose';
let poseTimer = 0;

function readPose() {
  try {
    const raw = window.localStorage.getItem(POSE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    const num = (v, lo, hi, fallback) =>
      (typeof v === 'number' && Number.isFinite(v)) ? clamp(v, lo, hi) : fallback;
    return {
      zoom: num(p && p.zoom, ZOOM_MIN, ZOOM_MAX, 1),
      panX: num(p && p.panX, -1e6, 1e6, 0),
      panY: num(p && p.panY, -1e6, 1e6, 0),
      tilt: num(p && p.tilt, TILT_MIN, TILT_MAX, TILT_HOME),
      yaw: num(p && p.yaw, YAW_MIN, YAW_MAX, 0),
    };
  } catch (e) { return null; }          // unreadable or corrupt: open at home
}

function savePose() {
  try {
    window.localStorage.setItem(POSE_KEY, JSON.stringify({
      zoom: +VIEW.zoom.toFixed(4), panX: Math.round(VIEW.panX),
      panY: Math.round(VIEW.panY), tilt: +VIEW.tilt.toFixed(1),
      yaw: +VIEW.yaw.toFixed(1),
    }));
  } catch (e) { /* no storage: the pose lasts only as long as the page */ }
}

/* One write per gesture, not one per frame: every pose change funnels through
   applyView, and the write lands once the operator stops moving. */
function scheduleSave() {
  clearTimeout(poseTimer);
  poseTimer = setTimeout(savePose, 300);
}
window.addEventListener('pagehide', () => { clearTimeout(poseTimer); savePose(); });

function clampPan() {
  const c = wrap.getBoundingClientRect();
  VIEW.panX = clamp(VIEW.panX, -c.width / 2, c.width / 2);
  VIEW.panY = clamp(VIEW.panY, -c.height / 2, c.height / 2);
}

function applyView() {
  /* the pose the board actually shows: its own angle plus the pointer lean */
  const tilt = clamp(VIEW.tilt + PAR.tilt, TILT_MIN, TILT_MAX);
  const yaw = clamp(VIEW.yaw + PAR.yaw, YAW_MIN, YAW_MAX);
  stage.style.transform = 'translate(-50%,-50%) translate(' + VIEW.panX.toFixed(1) + 'px,'
    + VIEW.panY.toFixed(1) + 'px) rotateX(' + tilt.toFixed(2) + 'deg)'
    + ' rotateY(' + yaw.toFixed(2) + 'deg) scale(' + VIEW.zoom.toFixed(4) + ')';
  /* Chips hold their screen size while the board grows around them, the way
     map labels do — the buildings scale, the readouts stay legible. */
  stage.style.setProperty('--inv', (1 / VIEW.zoom).toFixed(4));
  scheduleSave();
}

/* A reset is a camera move: let the board swing home instead of snapping. */
let settleTimer = 0;
function settle(ms) {
  if (reducedMotion()) return;
  stage.style.transition = 'transform ' + ms + 'ms cubic-bezier(.2,.75,.25,1)';
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => { stage.style.transition = ''; }, ms + 80);
}

function resetView() {
  VIEW.zoom = 1; VIEW.panX = 0; VIEW.panY = 0; VIEW.tilt = TILT_HOME; VIEW.yaw = 0;
  settle(420);
  fit();                     /* the home board fits the view again */
  applyView();
}

/* ── fit the whole artwork inside the view, undistorted, at any size ──
   Contain (never cover): the live panels sit flush against the artwork's own
   left/right/bottom edges over the reference's baked cards, so cropping any
   of it would cut them. The surround stays app-dark; the board then tilts,
   orbits, zooms and pans within it.

   The board carries a real 3D pose (tilt + yaw) and perspective pushes its
   near side outward, so a board that exactly fills the view flat overflows
   the moment it turns. fit() therefore measures where the four corners of the
   board actually land — the same projection the browser performs — and
   shrinks until they all fit, allowing for the far extreme of the pointer
   lean so the board stays whole whatever the cursor is doing. */
const PERSPECTIVE = 1800, ORIGIN_Y = .44;    /* .cty perspective and its origin */

/* Worst-case ratios (available ÷ needed) for a board sized `s` source-px per
   CSS-px: width, then the far edge up, then the near edge down. */
function fitRatios(s, cw, ch) {
  const halfW = s * SW / 2, halfH = s * SH / 2;
  const tilt = clamp(VIEW.tilt + PARRY_TILT, TILT_MIN, TILT_MAX) * Math.PI / 180;
  const tSin = Math.sin(tilt), tCos = Math.cos(tilt);
  const originY = ch * ORIGIN_Y, below = ch / 2 - originY;
  let needHalfW = 0, minY = Infinity, maxY = -Infinity;
  for (const sy of [-1, 1]) for (const sx of [-1, 1]) for (const dy of [-PARRY_YAW, PARRY_YAW]) {
    const yaw = (VIEW.yaw + dy) * Math.PI / 180;     /* both extremes of the lean */
    const ySin = Math.sin(yaw), yCos = Math.cos(yaw);
    const px = sx * halfW, py = sy * halfH;
    const x1 = px * yCos;                 /* rotateY */
    const z1 = -px * ySin;
    const y2 = py * tCos - z1 * tSin;     /* rotateX on top of it */
    const z2 = py * tSin + z1 * tCos;
    const m = 1 / Math.max(.2, 1 - z2 / PERSPECTIVE);   /* perspective divide */
    needHalfW = Math.max(needHalfW, Math.abs(m * x1));
    const y = m * (below + y2);           /* distance below the perspective origin */
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    width: (cw / 2) / Math.max(needHalfW, 1e-6),
    up: originY / Math.max(0, -minY, 1e-6),
    down: (ch - originY) / Math.max(0, maxY, 1e-6),
  };
}

function fit() {
  const c = wrap.getBoundingClientRect();
  if (!c.width || !c.height) return;          // view hidden: nothing to fit yet
  let s = Math.min(c.width / SW, c.height / SH);   // contain, flat
  for (let i = 0; i < 5; i++) {               // shrink until the posed corners fit
    const r = fitRatios(s, c.width, c.height);
    const k = Math.min(1, r.width, r.up, r.down);
    if (k >= .9995) break;
    s *= k;
  }
  s = Math.max(s, .05);                       // never collapse the board
  stage.style.width = Math.round(SW * s) + 'px';
  stage.style.height = Math.round(SH * s) + 'px';
  stage.style.setProperty('--u', s + 'px');   // 1 source pixel, in CSS px
  clampPan();
  applyView();
}
new ResizeObserver(fit).observe(wrap);

/* ── navigation: wheel zoom, drag pan, shift/right-drag tilt + orbit ── */
let drag = null, dragged = false;
let vel = { x: 0, y: 0 }, coastFrame = 0;

function endDrag() {
  if (!drag) return;
  drag = null;
  wrap.classList.remove('dragging');
}

wrap.addEventListener('pointermove', e => {
  const r = wrap.getBoundingClientRect();
  parallaxTo((e.clientX - r.left - r.width / 2) / (r.width / 2),
             (e.clientY - r.top - r.height / 2) / (r.height / 2));
});
wrap.addEventListener('pointerleave', () => parallaxTo(0, 0));
wrap.addEventListener('wheel', () => parallaxTo(0, 0), { passive: true });   /* zooming is an operation, not a lean */

wrap.addEventListener('wheel', e => {
  e.preventDefault();
  const r = wrap.getBoundingClientRect();
  const cx = e.clientX - r.left - r.width / 2;      // cursor, from the board centre
  const cy = e.clientY - r.top - r.height / 2;
  const next = clamp(VIEW.zoom * Math.exp(-e.deltaY * 0.0016), ZOOM_MIN, ZOOM_MAX);
  const k = next / VIEW.zoom;                       // keep the point under the cursor
  const cy2 = cy / cosTilt();                       // the tilt squashes the plane vertically
  VIEW.panX = cx - (cx - VIEW.panX) * k;
  VIEW.panY = cy2 - (cy2 - VIEW.panY) * k;
  VIEW.zoom = next;
  clampPan();
  applyView();
}, { passive: false });

wrap.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.button !== 2) return;
  if (coastFrame) { cancelAnimationFrame(coastFrame); coastFrame = 0; }   /* grab it mid-glide */
  PAR.tYaw = 0; PAR.tTilt = 0;                /* the operator is moving it now */
  drag = {
    x: e.clientX, y: e.clientY, prevX: e.clientX, prevY: e.clientY,
    panX: VIEW.panX, panY: VIEW.panY, tilt: VIEW.tilt, yaw: VIEW.yaw,
    tiltMode: e.button === 2 || e.shiftKey,
  };
  dragged = false;
  vel.x = vel.y = 0;
  wrap.classList.add('dragging');
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragEnd);
  window.addEventListener('pointercancel', onDragEnd);
});

function onDragMove(e) {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) dragged = true;
  if (drag.tiltMode) {
    const tilt = clamp(drag.tilt - dy * 0.16, TILT_MIN, TILT_MAX);
    const yaw = clamp(drag.yaw + dx * 0.09, YAW_MIN, YAW_MAX);   /* orbit sideways */
    const turned = Math.abs(tilt - VIEW.tilt) >= .25 || Math.abs(yaw - VIEW.yaw) >= .25;
    VIEW.tilt = tilt; VIEW.yaw = yaw;
    if (turned) { fit(); return; }               /* the board re-fits as it turns */
  } else {
    VIEW.panX = drag.panX + dx;
    VIEW.panY = drag.panY + dy;
    /* velocity as a decaying average, so a flick still coasts even when the
       last pointer sample was slow */
    vel.x = vel.x * .7 + (e.clientX - drag.prevX) * .3;
    vel.y = vel.y * .7 + (e.clientY - drag.prevY) * .3;
    drag.prevX = e.clientX; drag.prevY = e.clientY;
    clampPan();
  }
  applyView();
}

/* Let go of a pan and the board keeps going for a moment, the way a real
   camera head does — a direct manipulation, not ambient motion, so reduced
   motion keeps the stop crisp. */
function stepCoast() {
  coastFrame = 0;
  vel.x *= .9; vel.y *= .9;
  if (Math.abs(vel.x) + Math.abs(vel.y) < .5) return;
  VIEW.panX += vel.x;
  VIEW.panY += vel.y;
  clampPan();
  applyView();
  coastFrame = requestAnimationFrame(stepCoast);
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove);
  window.removeEventListener('pointerup', onDragEnd);
  window.removeEventListener('pointercancel', onDragEnd);
  const wasTilting = drag && drag.tiltMode;
  endDrag();
  if (!wasTilting && !reducedMotion()
      && Math.abs(vel.x) + Math.abs(vel.y) > 2 && !coastFrame) {
    dragged = true;                             /* a glide is still a drag: no click from it */
    coastFrame = requestAnimationFrame(stepCoast);   /* coast, then let go */
  }
}

/* A pan must not also select a building: swallow the click that follows one. */
wrap.addEventListener('click', e => {
  if (!dragged) return;
  dragged = false;
  e.stopPropagation();
  e.preventDefault();
}, true);

wrap.addEventListener('contextmenu', e => e.preventDefault());
wrap.addEventListener('dblclick', resetView);

wrap.addEventListener('keydown', e => {
  const step = 44;
  let turned = false;
  const pan = { ArrowLeft: ['panX', -step], ArrowRight: ['panX', step], ArrowUp: ['panY', -step], ArrowDown: ['panY', step] }[e.key];
  if (e.key === '+' || e.key === '=') VIEW.zoom = clamp(VIEW.zoom * 1.15, ZOOM_MIN, ZOOM_MAX);
  else if (e.key === '-' || e.key === '_') VIEW.zoom = clamp(VIEW.zoom / 1.15, ZOOM_MIN, ZOOM_MAX);
  else if (e.key === '0' || e.key === 'r' || e.key === 'R') { resetView(); e.preventDefault(); return; }
  else if (e.key === 'q' || e.key === 'Q') { VIEW.yaw = clamp(VIEW.yaw - 8, YAW_MIN, YAW_MAX); turned = true; }
  else if (e.key === 'e' || e.key === 'E') { VIEW.yaw = clamp(VIEW.yaw + 8, YAW_MIN, YAW_MAX); turned = true; }
  else if (pan) { VIEW[pan[0]] += pan[1]; clampPan(); }
  else return;
  e.preventDefault();
  if (turned) fit(); else applyView();            /* turning changes what fits */
});

/* ── one station per building: its label pill is the target, its chip the
      live readout. The activity layer beneath carries the glow and the pulse
      (decorative, aria-hidden, and never in the way of a click) ── */
function activityLayer() {
  let layer = stage.querySelector('.cty-activity');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'cty-activity';
    layer.setAttribute('aria-hidden', 'true');
    stage.appendChild(layer);
  }
  return layer;
}

function buildStations() {
  stage.querySelectorAll('.cty-station').forEach(el => el.remove());
  const layer = activityLayer();
  layer.textContent = '';
  BUILDINGS.forEach(b => {
    const st = document.createElement('div');
    st.className = 'cty-station';
    st.dataset.id = b.id;
    st.dataset.profile = b.profile;
    st.style.left = 'calc(var(--u) * ' + b.x + ')';
    st.style.top = 'calc(var(--u) * ' + b.y + ')';
    st.style.width = 'calc(var(--u) * ' + b.w + ')';
    st.style.height = 'calc(var(--u) * ' + b.h + ')';

    /* the same box, in the layer below: one pool of light per building */
    const act = document.createElement('div');
    act.className = 'cty-act';
    act.dataset.id = b.id;
    act.style.left = st.style.left;
    act.style.top = st.style.top;
    act.style.width = st.style.width;
    act.style.height = st.style.height;
    const pool = document.createElement('span');    // the pool of light
    pool.className = 'g';
    const beat = document.createElement('span');    // the pulse ring
    beat.className = 'b';
    act.append(pool, beat);

    const hit = document.createElement('span');     // hover/active ring on the pill
    hit.className = 'cty-hit';
    hit.setAttribute('aria-hidden', 'true');

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'cty-chip';
    chip.innerHTML = '<span class="d"></span><b></b><i></i>';

    st.append(hit, chip);
    st.addEventListener('click', () => selectBuilding(b.id));
    layer.appendChild(act);
    stage.appendChild(st);
  });
}

function paintStations() {
  const selected = selectedBuilding();
  stage.querySelectorAll('.cty-station').forEach(st => {
    const b = buildingById(st.dataset.id);
    const key = statusKey(b.profile);
    const info = MODEL.statusInfo(key);
    const act = activityFor(b.profile);
    const line = act.heat > 0 ? factLine(b.profile) : '';
    const chip = st.querySelector('.cty-chip');
    chip.querySelector('b').textContent = nickOf(b.profile).toUpperCase();
    chip.querySelector('i').textContent = info.text;
    chip.querySelector('.d').style.color = info.css;
    /* the visual claim is available to a screen reader too: the same numbers
       that drive the glow are named on the control that carries the status */
    chip.setAttribute('aria-label', b.name + ' — ' + nickOf(b.profile) + ', ' + info.text.toLowerCase()
      + (line ? ', ' + line : ''));
    chip.title = b.name + ' · ' + nickOf(b.profile).toUpperCase()
      + (line ? ' — ' + line : ' · no live session facts');
    st.classList.toggle('dead', key === 'offline');
    st.classList.toggle('active', b.id === selected.id);

    /* the building beneath: warm while it is busy, beating while it runs */
    const glow = stage.querySelector('.cty-act[data-id="' + b.id + '"]');
    if (!glow) return;
    /* the alphas are computed here rather than in CSS: a var inside a
       calc() for opacity is dropped by the browser, and the glow silently
       never appears. Plain numbers substitute cleanly. */
    glow.style.setProperty('--rgb', rgbChannels(info.css));
    glow.style.setProperty('--heat', String(act.heat));
    glow.style.setProperty('--glow', (act.heat * .95).toFixed(3));
    glow.style.setProperty('--ring', (act.heat * .8).toFixed(3));
    glow.style.setProperty('--beat', act.beat + 'ms');
    glow.classList.toggle('live', act.heat > 0);
    glow.classList.toggle('pulsing', act.beat > 0);   // warm ≠ running: only a live count beats
  });
}

/* ── the live card covering the reference's baked agent card ── */
function paintCard() {
  const b = selectedBuilding();
  const info = MODEL.statusInfo(statusKey(b.profile));
  ccEyebrow.textContent = nickOf(b.profile).toUpperCase() + ' AGENT · ' + info.text;
  ccName.textContent = b.name;
  const line = window.TrizEmpire && window.TrizEmpire.factLine && window.TrizEmpire.factLine(b.profile);
  ccSub.textContent = line || 'No live session facts — Hermes unreachable.';
  const fact = window.TrizEmpire && window.TrizEmpire.factOf && window.TrizEmpire.factOf(b.profile);
  const sessions = fact && Number.isFinite(Number(fact.sessions)) ? Number(fact.sessions) : null;
  ccSessions.textContent = sessions === null ? '—' : String(sessions);
  ccTokens.textContent = '—';    /* Hermes exposes no token telemetry here */
}

function paint() { paintStations(); paintCard(); }
function rebuild() { buildStations(); fit(); paint(); }

window.City3D = {
  rebuild,
  updateStatus: paint,
  setOffline: paint,
  refresh() { fit(); paint(); },
};

/* initial paint from whatever the app already knows, at the operator's own
   angle when this browser has one saved */
const storedPose = readPose();
if (storedPose) {
  VIEW.zoom = storedPose.zoom; VIEW.panX = storedPose.panX;
  VIEW.panY = storedPose.panY; VIEW.tilt = storedPose.tilt;
}
rebuild();
applyView();
