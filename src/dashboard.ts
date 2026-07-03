import { type ActivityEntry, listActivities } from './activity.js';
import {
  listAllTickets,
  listRecentEvents,
  type EventRow,
} from './state.js';

interface TicketView {
  issue_id: string;
  identifier: string | null;
  title: string | null;
  state: string;
  pr_url: string | null;
  pr_repo: string | null;
  pr_number: number | null;
  total_cost_usd: number;
  parent_issue_id: string | null;
  has_session: boolean;
  has_plan: boolean;
  created_at: number;
  updated_at: number;
  /** Worker actively running for this ticket right now, if any. */
  activity: { kind: string; started_at: number; detail?: string } | null;
}

interface EventView {
  id: number;
  issue_id: string;
  identifier: string | null;
  type: string;
  payload: unknown;
  created_at: number;
}

export interface DashboardState {
  generated_at: number;
  stats: {
    total: number;
    by_state: Record<string, number>;
    total_cost_usd: number;
  };
  tickets: TicketView[];
  events: EventView[];
}

export function buildDashboardState(): DashboardState {
  const tickets = listAllTickets();
  const events = listRecentEvents(100);
  const activitiesByIssue = new Map<string, ActivityEntry>();
  for (const a of listActivities()) activitiesByIssue.set(a.issueId, a);
  const identifierByIssue = new Map<string, string | null>();
  for (const t of tickets) {
    identifierByIssue.set(t.issue_id, t.identifier);
  }

  const ticketViews: TicketView[] = tickets.map((t) => {
    const a = activitiesByIssue.get(t.issue_id);
    return {
      issue_id: t.issue_id,
      identifier: t.identifier,
      title: t.title,
      state: t.state,
      pr_url: t.pr_url,
      pr_repo: t.pr_repo,
      pr_number: t.pr_number,
      total_cost_usd: t.total_cost_usd ?? 0,
      parent_issue_id: t.parent_issue_id,
      has_session: !!t.executor_session_id,
      has_plan: !!t.last_plan,
      created_at: t.created_at,
      updated_at: t.updated_at,
      activity: a ? { kind: a.kind, started_at: a.startedAt, detail: a.detail } : null,
    };
  });

  const eventViews: EventView[] = events.map((e: EventRow) => {
    let payload: unknown = e.payload;
    try {
      payload = JSON.parse(e.payload);
    } catch {
      /* leave as string */
    }
    return {
      id: e.id,
      issue_id: e.issue_id,
      identifier: identifierByIssue.get(e.issue_id) ?? null,
      type: e.type,
      payload,
      created_at: e.created_at,
    };
  });

  const byState: Record<string, number> = {};
  let total = 0;
  for (const t of tickets) {
    byState[t.state] = (byState[t.state] ?? 0) + 1;
    total += t.total_cost_usd ?? 0;
  }

  return {
    generated_at: Math.floor(Date.now() / 1000),
    stats: {
      total: tickets.length,
      by_state: byState,
      // Parent totals already include child costs (recordCost bubbles), so summing
      // every row double-counts. Sum only top-level tickets for the headline.
      total_cost_usd: tickets
        .filter((t) => !t.parent_issue_id)
        .reduce((acc, t) => acc + (t.total_cost_usd ?? 0), 0),
    },
    tickets: ticketViews,
    events: eventViews,
  };
}

export const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>laris-orchestrator</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0e0f12;
    --panel: #15171c;
    --panel-2: #1c1f26;
    --border: #2a2e38;
    --text: #e6e9ef;
    --muted: #8b93a7;
    --accent: #7aa2f7;
    --green: #9ece6a;
    --yellow: #e0af68;
    --red: #f7768e;
    --purple: #bb9af7;
    --cyan: #7dcfff;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f7f8fa;
      --panel: #ffffff;
      --panel-2: #f1f3f6;
      --border: #d8dce3;
      --text: #1a1d23;
      --muted: #5a6275;
      --accent: #3b6bcc;
      --green: #2f7a2f;
      --yellow: #a87a13;
      --red: #c9434b;
      --purple: #8a5fc4;
      --cyan: #2a8caa;
    }
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body { font-family: ui-sans-serif, -apple-system, "Inter", "Segoe UI", sans-serif; font-size: 14px; line-height: 1.45; }
  header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    background: var(--panel);
  }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  header .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  main { padding: 16px 24px 48px; display: grid; grid-template-columns: minmax(0,2fr) minmax(0,1fr); gap: 16px; max-width: 1600px; margin: 0 auto; }
  @media (max-width: 1000px) { main { grid-template-columns: 1fr; } }
  .panel { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .panel-header { padding: 10px 14px; border-bottom: 1px solid var(--border); font-weight: 600; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; display: flex; gap: 8px; align-items: center; }
  .panel-header .count { color: var(--text); background: var(--panel-2); padding: 1px 6px; border-radius: 999px; font-weight: 500; }
  .stats { display: flex; flex-wrap: wrap; gap: 14px; padding: 12px 14px; }
  .stat { display: flex; flex-direction: column; gap: 2px; min-width: 80px; }
  .stat .label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
  .stat .value { font-size: 18px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat .value.cost { color: var(--accent); }
  .pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11px; font-weight: 500; line-height: 1.6; border: 1px solid transparent; white-space: nowrap; }
  .pill.planning { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 30%, transparent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .pill.executing { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 30%, transparent); background: color-mix(in srgb, var(--yellow) 10%, transparent); }
  .pill.done { color: var(--green); border-color: color-mix(in srgb, var(--green) 30%, transparent); background: color-mix(in srgb, var(--green) 10%, transparent); }
  .pill.failed { color: var(--red); border-color: color-mix(in srgb, var(--red) 30%, transparent); background: color-mix(in srgb, var(--red) 10%, transparent); }
  .pill.split { color: var(--purple); border-color: color-mix(in srgb, var(--purple) 30%, transparent); background: color-mix(in srgb, var(--purple) 10%, transparent); }
  .pill.waiting { color: var(--muted); border-color: var(--border); background: var(--panel-2); }
  .ticket { padding: 12px 14px; border-bottom: 1px solid var(--border); display: flex; gap: 12px; align-items: flex-start; }
  .ticket:last-child { border-bottom: 0; }
  .ticket.child { padding-left: 38px; background: color-mix(in srgb, var(--panel-2) 50%, transparent); }
  .ticket .main { flex: 1; min-width: 0; }
  .ticket .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; color: var(--accent); }
  .ticket .title { color: var(--text); }
  .ticket .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .ticket .meta { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; margin-top: 4px; display: flex; gap: 12px; flex-wrap: wrap; }
  .ticket .meta .cost { color: var(--accent); }
  .ticket a { color: var(--cyan); text-decoration: none; }
  .ticket a:hover { text-decoration: underline; }
  .event { padding: 8px 14px; border-bottom: 1px solid var(--border); font-size: 13px; display: grid; grid-template-columns: 78px 110px 1fr; gap: 10px; align-items: baseline; }
  .event:last-child { border-bottom: 0; }
  .event .ts { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
  .event .id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--accent); font-size: 12px; }
  .event .type { color: var(--text); }
  .empty { padding: 20px 14px; color: var(--muted); text-align: center; font-style: italic; }
  .updated-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--green); margin-right: 6px; vertical-align: middle; opacity: 0; transition: opacity 0.6s; }
  .updated-dot.on { opacity: 1; }
  /* Live activity indicator on a ticket row */
  .live-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--yellow); box-shadow: 0 0 0 0 color-mix(in srgb, var(--yellow) 60%, transparent); animation: pulse 1.4s ease-out infinite; margin-right: 2px; vertical-align: middle; }
  @keyframes pulse {
    0%   { box-shadow: 0 0 0 0   color-mix(in srgb, var(--yellow) 60%, transparent); }
    70%  { box-shadow: 0 0 0 8px color-mix(in srgb, var(--yellow) 0%,  transparent); }
    100% { box-shadow: 0 0 0 0   color-mix(in srgb, var(--yellow) 0%,  transparent); }
  }
  .pill.activity { color: var(--yellow); border-color: color-mix(in srgb, var(--yellow) 30%, transparent); background: color-mix(in srgb, var(--yellow) 12%, transparent); font-variant-numeric: tabular-nums; }
  .ticket.active { background: color-mix(in srgb, var(--yellow) 5%, transparent); }
  .retry { margin-left: auto; display: flex; gap: 6px; }
  .retry button {
    font: inherit; font-size: 11px; line-height: 1.4;
    padding: 2px 8px; border-radius: 999px;
    border: 1px solid var(--border); background: var(--panel-2); color: var(--muted);
    cursor: pointer; transition: color .15s, border-color .15s, background .15s;
  }
  .retry button:hover { color: var(--text); border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
  .retry button:disabled { opacity: 0.5; cursor: not-allowed; }
  .retry button.spinning { color: var(--yellow); border-color: var(--yellow); }
</style>
</head>
<body>
<header>
  <h1>laris-orchestrator</h1>
  <div class="meta">
    <span class="updated-dot" id="dot"></span>
    <span id="status">connecting…</span>
  </div>
</header>
<main>
  <section>
    <div class="panel" style="margin-bottom: 16px;">
      <div class="panel-header">Stats</div>
      <div class="stats" id="stats"></div>
    </div>
    <div class="panel">
      <div class="panel-header">Tickets <span class="count" id="ticket-count">0</span></div>
      <div id="tickets"></div>
    </div>
  </section>
  <section>
    <div class="panel">
      <div class="panel-header">Recent events <span class="count" id="event-count">0</span></div>
      <div id="events"></div>
    </div>
  </section>
</main>
<script>
const POLL_MS = 2000;
const $ = (id) => document.getElementById(id);
const dot = $('dot');
const status = $('status');

function fmtCost(n) {
  if (!n) return '$0.00';
  return '$' + n.toFixed(n < 1 ? 4 : 2);
}
function fmtRelative(ts) {
  const now = Math.floor(Date.now() / 1000);
  const d = now - ts;
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}
function fmtElapsed(ts) {
  const now = Math.floor(Date.now() / 1000);
  const d = Math.max(0, now - ts);
  if (d < 60) return d + 's';
  const m = Math.floor(d / 60);
  if (m < 60) return m + 'm ' + (d % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}
function htmlEscape(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderStats(s, activeCount) {
  const states = Object.keys(s.by_state).sort();
  const stateChips = states
    .map((st) => '<span class="pill ' + st + '">' + st + ' ' + s.by_state[st] + '</span>')
    .join(' ');
  const activeBlock = activeCount > 0
    ? '<div class="stat"><div class="label">Active workers</div><div class="value" style="color:var(--yellow);"><span class="live-dot"></span> ' + activeCount + '</div></div>'
    : '';
  $('stats').innerHTML =
    '<div class="stat"><div class="label">Tickets</div><div class="value">' + s.total + '</div></div>' +
    activeBlock +
    '<div class="stat"><div class="label">Total cost</div><div class="value cost">' + fmtCost(s.total_cost_usd) + '</div></div>' +
    '<div class="stat" style="flex:1;"><div class="label">By state</div><div class="value" style="font-size:14px;">' + (stateChips || '<span style="color:var(--muted);">—</span>') + '</div></div>';
}

function renderTickets(tickets) {
  $('ticket-count').textContent = tickets.length;
  if (!tickets.length) {
    $('tickets').innerHTML = '<div class="empty">No tickets yet.</div>';
    return;
  }
  // Group children under their parents; sort top-level by updated_at desc.
  const byId = new Map(tickets.map((t) => [t.issue_id, t]));
  const childrenOf = new Map();
  const topLevel = [];
  for (const t of tickets) {
    if (t.parent_issue_id && byId.has(t.parent_issue_id)) {
      const arr = childrenOf.get(t.parent_issue_id) ?? [];
      arr.push(t);
      childrenOf.set(t.parent_issue_id, arr);
    } else {
      topLevel.push(t);
    }
  }
  topLevel.sort((a, b) => b.updated_at - a.updated_at);

  const renderOne = (t, isChild) => {
    const pr = t.pr_url
      ? '<a href="' + htmlEscape(t.pr_url) + '" target="_blank" rel="noopener">' + htmlEscape(t.pr_repo + '#' + t.pr_number) + '</a>'
      : '';
    const ident = t.identifier ? htmlEscape(t.identifier) : '<span style="color:var(--muted);">' + htmlEscape(t.issue_id.slice(0, 8)) + '</span>';
    const active = !!t.activity;
    const activityPill = active
      ? '<span class="pill activity" title="' + htmlEscape(t.activity.detail || '') + '"><span class="live-dot"></span>' + htmlEscape(t.activity.kind) + ' (' + fmtElapsed(t.activity.started_at) + ')</span>'
      : '';
    // Retrigger buttons: only when nothing is running and the action makes sense.
    // - Re-plan: always available (planner is idempotent on the plan comment).
    // - Re-execute: only if a plan exists and the ticket isn't a 'split' parent.
    const retryButtons = active ? '' :
      '<div class="retry">' +
        '<button data-act="plan" data-id="' + htmlEscape(t.issue_id) + '" title="Re-run the planner against this ticket">↻ plan</button>' +
        (t.has_plan && t.state !== 'split'
          ? '<button data-act="execute" data-id="' + htmlEscape(t.issue_id) + '" title="Re-dispatch the executor (cleans up any leftover worktree first)">↻ execute</button>'
          : '') +
      '</div>';
    return '<div class="ticket' + (isChild ? ' child' : '') + (active ? ' active' : '') + '">' +
      '<div class="main">' +
        '<div class="row">' +
          '<span class="id">' + ident + '</span>' +
          '<span class="title">' + htmlEscape(t.title || '(no title cached)') + '</span>' +
          '<span class="pill ' + t.state + '">' + t.state + '</span>' +
          activityPill +
          retryButtons +
        '</div>' +
        '<div class="meta">' +
          '<span>updated ' + fmtRelative(t.updated_at) + '</span>' +
          (pr ? '<span>' + pr + '</span>' : '') +
          '<span class="cost">' + fmtCost(t.total_cost_usd) + '</span>' +
          (t.has_session ? '' : '<span style="color:var(--muted);">no session</span>') +
        '</div>' +
      '</div>' +
    '</div>';
  };

  let html = '';
  for (const t of topLevel) {
    html += renderOne(t, false);
    const kids = childrenOf.get(t.issue_id) ?? [];
    kids.sort((a, b) => b.updated_at - a.updated_at);
    for (const c of kids) html += renderOne(c, true);
  }
  $('tickets').innerHTML = html;
}

function renderEvents(events) {
  $('event-count').textContent = events.length;
  if (!events.length) {
    $('events').innerHTML = '<div class="empty">No events yet.</div>';
    return;
  }
  $('events').innerHTML = events.map((e) => {
    const ident = e.identifier ? htmlEscape(e.identifier) : htmlEscape(e.issue_id.slice(0, 8));
    return '<div class="event">' +
      '<span class="ts">' + fmtRelative(e.created_at) + '</span>' +
      '<span class="id">' + ident + '</span>' +
      '<span class="type">' + htmlEscape(e.type) + '</span>' +
    '</div>';
  }).join('');
}

// Delegate clicks on retry buttons. Re-render replaces the DOM every poll, so
// listening on the container survives that.
document.getElementById('tickets').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const act = btn.getAttribute('data-act');
  const id = btn.getAttribute('data-id');
  btn.disabled = true;
  btn.classList.add('spinning');
  const original = btn.textContent;
  btn.textContent = '…';
  try {
    const r = await fetch('/api/retry/' + encodeURIComponent(id) + '?kind=' + encodeURIComponent(act), { method: 'POST' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      btn.textContent = original;
      btn.classList.remove('spinning');
      btn.disabled = false;
      alert('Retry failed: ' + (j.error || ('HTTP ' + r.status)));
      return;
    }
    // Force an immediate poll so the new activity shows up.
    poll();
  } catch (err) {
    btn.textContent = original;
    btn.classList.remove('spinning');
    btn.disabled = false;
    alert('Retry failed: ' + err.message);
  }
});

let lastGeneratedAt = 0;
async function poll() {
  try {
    const r = await fetch('/api/state', { cache: 'no-store' });
    if (!r.ok) throw new Error('http ' + r.status);
    const s = await r.json();
    const activeCount = s.tickets.filter((t) => t.activity).length;
    renderStats(s.stats, activeCount);
    renderTickets(s.tickets);
    renderEvents(s.events);
    status.textContent = 'updated ' + new Date().toLocaleTimeString();
    if (s.generated_at !== lastGeneratedAt) {
      dot.classList.add('on');
      setTimeout(() => dot.classList.remove('on'), 400);
      lastGeneratedAt = s.generated_at;
    }
  } catch (err) {
    status.textContent = 'offline (' + err.message + ')';
    dot.classList.remove('on');
  }
}
poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
