'use strict';

/* ══════════════════════════════════════════════════════════════════════
 * CHAT MODEL — pure, DOM-free conversation logic for the Chat view.
 *
 * Loaded two ways:
 *   - in the browser as a classic script (window.CHAT_MODEL)
 *   - in node tests via require() — the exact same code the UI runs.
 *
 * What lives here:
 *   - PERSONAS        : the crew's conversational identity (domain, voice,
 *                       opening line) — presentation only, no backend claims.
 *   - classifyIntent() : greeting | question | mission | thanks | other.
 *   - reply()         : the 1:1 answer one agent gives the operator.
 *   - planDiscussion(): the agent-to-agent transcript produced when the
 *                       operator hands the crew a project task / mission —
 *                       each agent speaks in its own domain, in order,
 *                       reacting to what the others just said.
 *
 * Honesty rules (same as the rest of this project): nothing here invents
 * backend state. Replies are local conversational responses, explicitly
 * framed as such; per-agent live facts stay with the real Hermes proxy.
 * ══════════════════════════════════════════════════════════════════════ */

/* ── the conversational roster ─────────────────────────────────────── */
/* id matches the crew ids (backend profiles) and staff:… ids from the
 * crew sidebar, so one selection state drives both views. */
const PERSONAS = {
  'default':        { name: 'Orchestrator', domain: 'command',        voice: 'delegating' },
  'research':       { name: 'Research',      domain: 'research',       voice: 'methodical' },
  'writer':         { name: 'Writer',        domain: 'writing',        voice: 'concise' },
  'developer':      { name: 'Developer',     domain: 'engineering',    voice: 'pragmatic' },
  'data':           { name: 'Data',          domain: 'analytics',      voice: 'precise' },
  'staff:email':    { name: 'Email',         domain: 'email',          voice: 'polished' },
  'staff:marketing':{ name: 'Marketing',     domain: 'marketing',      voice: 'punchy' },
  'staff:seo':      { name: 'SEO',           domain: 'seo',            voice: 'technical' },
  'staff:social':   { name: 'Social',        domain: 'social',         voice: 'casual' },
  'staff:design':   { name: 'Design',        domain: 'design',         voice: 'visual' },
  'staff:video':    { name: 'Video',         domain: 'video',          voice: 'story-driven' },
  'staff:finance':  { name: 'Finance',       domain: 'finance',        voice: 'cautious' },
  'staff:sales':    { name: 'Sales',         domain: 'sales',          voice: 'direct' },
  'staff:support':  { name: 'Support',       domain: 'support',        voice: 'empathetic' },
  'staff:travel':   { name: 'Travel',        domain: 'travel',         voice: 'practical' },
};

function personaFor(id) {
  return PERSONAS[id] || {
    name: String(id || 'Agent').replace(/^staff:/, ''),
    domain: 'general',
    voice: 'neutral',
  };
}

/* ── intent detection ──────────────────────────────────────────────── */

function classifyIntent(text) {
  const t = String(text || '').trim();
  if (!t) return 'other';
  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening))\b/i.test(t)) return 'greeting';
  if (/\b(thanks|thank you|cheers|appreciate|got it)\b/i.test(t) && t.length < 60) return 'thanks';
  if (/\b(mission|task|project|goal|objective|assign|delegate|plan|sprint|roadmap)\b/i.test(t)
      && t.length > 24) return 'mission';
  if (/\?$/.test(t) || /^(what|how|why|when|where|who|can|could|should|do|does|is|are)\b/i.test(t)) {
    return 'question';
  }
  return 'other';
}

/* Shorten a user string for echoing back inside a reply. */
function clip(text, max = 90) {
  const s = String(text || '').trim().replace(/\s+/g, ' ');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ── 1:1 reply ─────────────────────────────────────────────────────── */
/* context: { profile: bool, status: 'working'|'ready'|'idle'|'offline'|null } —
 * whatever the real backend currently evidences. Never fabricated. */
function reply(id, text, context = {}) {
  const p = personaFor(id);
  const intent = classifyIntent(text);
  const said = clip(text);
  const linked = context.profile === true;
  const statusLine = context.status
    ? ` Right now my backend session reads ${String(context.status).toUpperCase()}.`
    : '';

  switch (intent) {
    case 'greeting':
      return `${p.name} here — ${p.domain} seat.${statusLine} Give me the short version of what you need.`;
    case 'thanks':
      return `Anytime. ${p.name} stays on the ${p.domain} thread — ping me when it moves.`;
    case 'mission':
      return linked
        ? `Logged: “${said}”. I own the ${p.domain} slice — send it to the Mission Room and I'll take it up with the crew.${statusLine}`
        : `Logged: “${said}”. I'm the ${p.domain} seat on this crew. I don't have a live backend session of my own, so I'll hold it here — open a linked agent (Research, Writer, Developer, Data or Orchestrator) to run it for real.`;
    case 'question':
      return `${p.name} answering from the ${p.domain} seat: give me one more constraint (deadline, scope, or audience) and I'll commit to a position instead of hedging. About “${said}” — that's on my desk.${statusLine}`;
    default:
      return `Copy — “${said}”. Filed under ${p.domain}.${linked ? statusLine : ' No live session is linked to this seat, so nothing beyond this transcript is implied.'}`;
  }
}

/* ── agent-to-agent mission discussion ─────────────────────────────── */
/* planDiscussion(mission, opts) → ordered turns [{id, name, line}].
 * The crew takes a project task/mission and works it out among
 * themselves: the orchestrator splits it, the relevant seats answer in
 * their own domain, and they react to each other before converging. */
function planDiscussion(mission, opts = {}) {
  const m = clip(mission, 120);
  const seats = Array.isArray(opts.seats) && opts.seats.length
    ? opts.seats.slice(0, 6)
    : ['default', 'research', 'writer', 'developer', 'data'];
  const names = seats.map(id => personaFor(id).name);

  const SPLITS = {
    default: `Mission on the table: “${m}”. I'm splitting it ${names.length - 1} ways — ${names.slice(1).join(', ')} — take your slices and answer each other, not me.`,
    research: `My slice: I'll establish what's already known about “${m}” — sources, prior art, anything that changes the answer. ${seats.includes('data') ? "Data, I'll hand you the raw list to pressure-test." : 'First facts land before anyone drafts.'}`,
    writer: `Drafting slice. Once Research posts facts I'll turn them into the narrative — headline, angles, the version people actually read. ${seats.includes('marketing') ? "Marketing, tell me the voice and I'll match it." : 'I keep it tight until the facts settle.'}`,
    developer: `Engineering slice. I'll size the build behind “${m}”, name the moving parts, and flag what breaks first. ${seats.includes('data') ? "Data — tell me which numbers you need instrumented and I'll wire them in from the start." : "I'll instrument as I go so we can see it working."}`,
    data: `Analytics slice. I'll define the metrics that prove “${m}” worked — baseline now, targets we commit to. ${seats.includes('developer') ? 'Developer, I need those events captured on day one, not retrofitted.' : 'Nothing ships without a measurement plan.'}`,
    'staff:marketing': `Marketing slice. Research's findings become positioning — who this is for, why now, the one line they remember. ${seats.includes('writer') ? 'Writer and I will iterate the copy until it sounds like us, not a brochure.' : 'I keep the message sharp.'}`,
    'staff:seo': `SEO slice. I'll map the query demand around “${m}” and make sure the structure answers it — titles, headings, internal links. ${seats.includes('writer') ? "Writer: write first, I'll shape the search layer on top." : 'Demand first, then the page.'}`,
    'staff:social': `Social slice. I'll cut the story into platform-native posts and a cadence — what goes out Monday, what waits. ${seats.includes('marketing') ? 'Marketing sets the angle, I make it travel.' : 'Short, frequent, on-message.'}`,
    'staff:design': `Design slice. I'll take the message to a visual system — layout, hierarchy, the look that makes it credible. ${seats.includes('writer') ? 'Writer, send copy early; I design around real words, not lorem.' : 'I build from the real content.'}`,
    'staff:finance': `Finance slice. I'll cost “${m}” — budget, burn, and the point where it has to pay for itself. ${seats.includes('sales') ? "Sales, your revenue assumptions go through me before they land in the plan." : "I'll flag anything we can't sustain."}`,
    'staff:sales': `Sales slice. I'll line up who we talk to first and what we say — the pipeline this mission has to feed. ${seats.includes('marketing') ? "Marketing, warm them up and I'll close the gap." : 'I start with the hottest ten.'}`,
    'staff:support': `Support slice. I'll carry the customer voice in — the questions they always ask, where they get stuck. ${seats.includes('writer') ? 'Writer: those become the docs and the FAQ.' : 'I keep us answering real questions.'}`,
    'staff:email': `Email slice. I'll build the sequence — subject, cadence, the follow-up that doesn't annoy. ${seats.includes('writer') ? 'Writer drafts, I tune for the inbox.' : 'Tight copy, one ask per mail.'}`,
    'staff:video': `Video slice. I'll storyboard the version that explains “${m}” in ninety seconds — hook, proof, call to action. ${seats.includes('design') ? 'Design and I will keep the frames on brand.' : 'One idea per cut.'}`,
    'staff:travel': `Logistics slice. If this mission needs anyone on the move, I'll handle routes, timing and the paperwork so the work itself stays uninterrupted.`,
  };

  const REACT = {
    default: `Good — ${names.length - 1} slices moving at once. ${names.slice(1, 3).join(' and ')}, answer each other's open points now; I want one plan, not four.`,
    research: `Posting sources as they land. ${seats.includes('writer') ? 'Writer — the second link is the one your headline needs.' : 'Facts first, claims second.'}`,
    writer: `Received. ${seats.includes('research') ? "Research's angle tightens the hook — I'll lead with the finding, not the flourish." : 'I write from the facts we have and mark the gaps.'}`,
    developer: `${seats.includes('data') ? "Data's event list is doable — I'll ship the tracking with the feature, not after it." : 'Build order set; I show working slices, not a big reveal.'}`,
    data: `${seats.includes('developer') ? "Confirmed — Developer wires the events, I own the dashboard and the target numbers." : 'Targets agreed; I report against them weekly.'}`,
    'staff:marketing': `${seats.includes('writer') ? "Writer's draft plus my positioning — that's the campaign in one pass." : 'Positioning locked; everything else ladders up to it.'}`,
    'staff:seo': `${seats.includes('writer') ? "Writer's outline maps cleanly onto the query clusters — no rewrite needed." : 'Structure confirmed against demand.'}`,
    'staff:social': `${seats.includes('marketing') ? "Marketing's line becomes the post; I'll thread the rest across the week." : 'Cadence set, starting with the strongest hook.'}`,
    'staff:design': `${seats.includes('writer') ? "Copy and layout are converging — one more pass and it's ready to ship." : 'Visual system drafted from the real content.'}`,
    'staff:finance': `${seats.includes('sales') ? "Sales' numbers hold up against my model — the mission pays back inside the quarter." : 'Costs bounded; I watch the burn weekly.'}`,
    'staff:sales': `${seats.includes('marketing') ? "Marketing's angle is landing with the first ten conversations — pipeline is warm." : 'First conversations booked against the plan.'}`,
    'staff:support': `${seats.includes('writer') ? "Writer turned my top five questions into docs — ticket volume will drop before it rises." : 'FAQ rewritten from real tickets.'}`,
    'staff:email': `${seats.includes('writer') ? "Writer's subject lines plus my send times — sequence is ready to stage." : 'Sequence staged, one ask per mail.'}`,
    'staff:video': `${seats.includes('design') ? "Design's frames are in — the cut is storyboarded and ready to record." : 'Boards drafted against the message.'}`,
    'staff:travel': 'Routes and timing confirmed — nothing on the calendar collides with the delivery dates.',
  };

  const CLOSE = `Plan converged: ${names.slice(1).join(' → ')} → me for sign-off. One mission, one plan, no duplicate work. ${seats.length > 3 ? 'Slices run in parallel and check in here.' : 'We move on your go.'}`;

  const turns = [];
  seats.forEach(id => {
    const p = personaFor(id);
    const line = SPLITS[id] || `“${m}” — ${p.name} takes the ${p.domain} slice and reports back here.`;
    turns.push({ id, name: p.name, line });
  });
  seats.forEach(id => {
    const p = personaFor(id);
    const line = REACT[id] || `${p.name} aligns with the plan above — no blockers from the ${p.domain} seat.`;
    turns.push({ id, name: p.name, line });
  });
  turns.push({ id: 'default', name: personaFor('default').name, line: CLOSE });
  return turns;
}

const CHAT_MODEL = {
  PERSONAS,
  personaFor,
  classifyIntent,
  clip,
  reply,
  planDiscussion,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CHAT_MODEL;
}
if (typeof window !== 'undefined') {
  window.CHAT_MODEL = CHAT_MODEL;
}
