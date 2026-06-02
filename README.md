# laris-orchestrator

Linear → Claude → GitHub agent orchestrator. Listens for Linear webhooks, drafts plans on tickets via `claude -p`, lets you iterate via comments, and on approval spawns coding subagents that open PRs.

## Workflow

1. **Ticket created** in Linear — webhook fires.
2. **Orchestrator** reads the ticket, posts a plan as a Linear comment.
3. **You iterate** by replying in comments. Each human comment triggers the orchestrator to revise the plan (sessions resumed via `--resume` so context carries over).
4. **You approve** by adding the `agent:approved` label.
5. **Orchestrator** decides if the work splits into subtasks (creates them in Linear if so) and dispatches subagents — one per task, in isolated git worktrees with their own Docker DB.
6. **Subagent** does the work, opens a PR, links it back to Linear. Orchestrator posts a summary comment on the PR.

## Design decisions (locked)

- Bot ignores its own events via the `actor` field on Linear webhooks.
- Parent-ticket plan must enumerate every subtask in enough detail to auto-approve children — no per-child plan cycle.
- Subagents only talk to the orchestrator, never directly to the user. Orchestrator escalates if needed.
- Each subagent gets a 1h wall-clock budget with an external watchdog warning at ~50 min. On hard stop or self-judged blocker, subagent reports done/not-done/blocked to the orchestrator. Orchestrator decides: extend, open a draft PR with a TODO checklist, or spin off the remainder as a new subtask. **Never discard work.**
- On crash → escalate to user. On PR opened → orchestrator posts a summary comment.
- Auth: long-lived OAuth token from `claude setup-token` (uses Max subscription). NOT an Anthropic API key.

## Status

- **Phase A — planning loop**: implemented. Webhook → orchestrator → plan posted to Linear → iteration via comments.
- **Phase B1 — execution**: implemented. Approval label → worktree → subagent → PR opened → Linear comment. Worktree is cleaned up on success.
- **Phase B1.5 — PR comment loop**: implemented. GitHub `issue_comment` webhook → orchestrator rehydrates worktree, `--resume`s the executor session, pushes follow-up commits, posts outcome back to Linear.
- **Phase B2 — subtask splitting**: not yet built.
- **Phase B3 — watchdog/budget**: not yet built (hard 1h timeout exists, no mid-run warnings).
- **Phase B4 — Docker DB isolation**: not yet built.

## Stack

- Node + TypeScript, Express, ngrok (locally)
- `@linear/sdk` for Linear API
- `better-sqlite3` for state (tickets table + events log)
- `claude -p` subprocesses for agent thinking (`--output-format json`, `--resume`, `--allowedTools "Read"` for planning)

## Setup

Prerequisites: Node 22+, `claude` CLI logged in, `ngrok`, a Linear workspace, a GitHub PAT with `repo` scope (Phase B).

```bash
cd ~/projects/laris-orchestrator
npm install
cp .env.example .env
```

Fill in `.env`:

| Var | How to get it |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | Run `claude setup-token`, copy the token |
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API keys |
| `LINEAR_WEBHOOK_SECRET` | Linear → Settings → API → Webhooks → Create (URL = `<ngrok>/webhooks/linear`) |
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope |
| `GITHUB_WEBHOOK_SECRET` | GitHub repo → Settings → Webhooks → Add (URL = `<ngrok>/webhooks/github`, content type `application/json`, event = "Issue comments", set a secret). Needed to react to PR comments. |
| `GITHUB_BOT_LOGIN` | (Optional) login that should be treated as the bot for self-loop avoidance |
| `APPROVAL_LABEL` | Defaults to `agent:approved` |
| `PORT` | Defaults to `4000` |

## Run

Two terminals:

```bash
# Terminal A
npm run dev

# Terminal B
ngrok http 4000
```

Copy the ngrok https URL into the Linear webhook config, restart the daemon. Create a ticket — daemon logs the event and posts a plan comment.

## Project layout

```
src/
├── index.ts             Express app, webhook route wiring
├── config.ts            Env validation (zod)
├── state.ts             SQLite schema + helpers (tickets, events, PR linkage)
├── linear.ts            Linear SDK client, fetch issue context, post comment
├── webhooks.ts          Linear HMAC verify + event routing
├── github-webhooks.ts   GitHub HMAC verify + issue_comment routing → followup
├── orchestrator.ts      Planning subagent (claude -p with Read-only tools)
└── executor.ts          Execution + follow-up subagents (worktree, gh, --resume)
data/                    SQLite file lives here (gitignored)
```

## Caveat: Max plan credit allocation

Starting **2026-06-15**, `claude -p` on Max plans draws from a separate monthly "Agent SDK credit" allocation, distinct from interactive Claude.ai usage. Heavy use after that date may require migrating to an Anthropic API key.
