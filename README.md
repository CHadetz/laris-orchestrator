# laris-orchestrator

Linear → Claude → GitHub agent orchestrator. Listens for Linear webhooks, drafts plans on tickets via `claude -p`, lets you iterate via comments, and on approval spawns coding subagents that open PRs. PR comments, line-anchored review comments, review summaries, and failed CI checks all feed back into the same loop — the agent pushes commits and replies in place.

## End-to-end flow

1. **Ticket created** in Linear — webhook fires. The orchestrator clones a planning worktree, runs the planner against the real target repo, posts a plan as a Linear comment.
2. **You iterate** by replying in comments. The planner picks REVISE (rewrites the plan comment in place) or REPLY (threads under your comment). A short change-summary is threaded under your comment whenever the plan is revised. Sessions resume via `--resume` so the planner keeps context across iterations.
3. **You approve** by adding the `agent:approved` label. The ticket flips to **In Progress** in Linear.
4. The plan may contain hidden `SUBTASK_START / SUBTASK_END` blocks. If so, the orchestrator creates Linear sub-issues (each child flipped to **In Progress**), bakes a self-contained plan into each, and dispatches one executor per child. Parent stays as a rollup container.
5. **Executor** runs in its own detached-HEAD worktree, lints/formats/typechecks/tests per `CLAUDE.md` conventions, commits, pushes `agent/<ticket-id>`, opens a PR. Ticket flips to **In Review**.
6. **Verification** — if `VERIFICATION_COMMAND` is set (e.g. `npm run check`), the orchestrator runs it against the worktree after the PR is opened. On failure, an auto-fix subagent (resumed from the executor's session) gets the failure output and pushes a fix. Up to `VERIFICATION_MAX_RETRIES` attempts.
7. **Conversation continues on the PR.** Any of these dispatch a follow-up subagent that rehydrates the worktree, addresses the input, pushes if needed, and replies:
   - Regular PR comments (`issue_comment`) → top-level PR reply
   - Line-anchored review comments (`pull_request_review_comment`) → **threaded** reply under the line comment
   - PR review summaries with `changes_requested` / `commented` (`pull_request_review`) → top-level PR reply
   - Failed CI checks (`check_run` with `failure` / `timed_out`) → top-level PR reply with the fix summary
8. **Cost** is tracked cumulatively per ticket and bubbles up from children to the parent rollup. `MAX_COST_USD_PER_TICKET` is a hard cap — further subagent spawns are refused once spent.
9. **Rollup** — when all children of a split parent reach a terminal state, the orchestrator posts a `✅/❌` summary on the parent with the grand total.

## Locked design decisions

- Bot ignores its own Linear events (`actor` field) and GitHub events (`GITHUB_BOT_LOGIN`).
- The orchestrator uses a **separate bot GitHub account** (collaborator on the target repo). Fine-grained PATs don't span owners, so use a classic PAT with `repo` scope.
- One planning worktree per ticket, stable path, reused across iterations so Claude session resumption (which is cwd-scoped) keeps working. Synced to `origin/<base>` on every reuse.
- One execution worktree per execution, per branch `agent/<ticket-id>`. Detached HEAD on follow-up rehydration so it never conflicts with the user having the same branch checked out locally. Cleaned up on PR success.
- Subagent output protocols (the orchestrator parses the FINAL line):
  - Executor: `PR_URL: <url>` or `BLOCKED: <reason>`
  - Verification fix: `FIXED: <summary>` or `BLOCKED: <reason>`
  - Follow-up (any source): `UPDATED: <reply text>` / `NO_CHANGES: <reply text>` / `BLOCKED: <reason>`
- The orchestrator posts the PR reply itself (using the text after the protocol marker), so the subagent doesn't have to choose between "push code" and "reply" — it does both deterministically.
- Subagent session IDs are persisted **mid-stream** via `--output-format stream-json`. If the worker dies after the first event, the session id is already on disk and the next follow-up can resume.
- On worker startup, tickets stuck in `'executing'` are reconciled: if `gh pr list --head agent/<id>` finds a PR, the ticket is flipped to `done` and a recovery comment is posted on Linear.
- Auth for `claude -p`: long-lived OAuth token from `claude setup-token` (uses Max subscription). NOT an Anthropic API key.

## Status

- **A — planning loop**: done. Edit-in-place plan comment, REVISE/REPLY modes, change-summary threading, threaded replies, model-per-task picked by the planner, planner uses Opus by default.
- **B1 — execution**: done. Worktree → executor → PR → verification → optional auto-fix retries → cleanup.
- **B1.5 — PR follow-ups**: done. Handles `issue_comment`, `pull_request_review_comment` (threaded), `pull_request_review`, and `check_run` failures. Includes the original plan in the prompt so follow-ups work even if the session id is lost.
- **B2 — subtask splitting**: done. `SUBTASK_START/END` blocks → Linear sub-issues → parallel children → rollup comment + cost on parent. Children skip the approval cycle.
- **B3 — budget cap**: done as a hard cap (`MAX_COST_USD_PER_TICKET`). No soft mid-run warnings yet.
- **B4 — Docker DB isolation**: not implemented, parked.
- **Restart recovery**: done. Mid-stream session persistence + startup reconciliation of orphaned `executing` tickets.
- **Linear workflow state sync**: done. Approval → In Progress; child creation → In Progress; PR open → In Review. State names env-configurable.

## Stack

- Node 22+, TypeScript ESM, Express
- `@linear/sdk` for Linear API (issues, comments, workflow states)
- `better-sqlite3` for state (tickets table + events log; additive `ALTER TABLE` migrations on boot)
- `claude -p` with `--output-format stream-json --verbose` for all subagents — line-by-line parse for mid-run session capture
- `gh` CLI for PR creation, PR comments, and threaded review-comment replies (`gh api /repos/.../pulls/.../comments/<id>/replies`)
- Local dev: `ngrok` for webhook exposure

## Setup

Prereqs: Node 22+, `claude` CLI logged in (`claude setup-token`), `gh` CLI, `ngrok`, a Linear workspace, a dedicated bot GitHub account added as a collaborator on the target repo, classic PAT with `repo` scope for that bot.

```bash
cd ~/projects/laris-orchestrator
npm install
cp .env.example .env
```

### Required env

| Var | What it is |
|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token` |
| `LINEAR_API_KEY` | Linear → Settings → API → Personal API keys |
| `LINEAR_WEBHOOK_SECRET` | The secret you set when creating the Linear webhook |
| `REPO_PATH` | Absolute path to the target repo the agent should read/edit |

### GitHub config (required to react to PRs / CI / reviews)

| Var | What it is |
|---|---|
| `GITHUB_TOKEN` | Classic PAT of the **bot** account, scope `repo` |
| `GITHUB_WEBHOOK_SECRET` | The secret you set when creating the GitHub webhook |
| `GITHUB_BOT_LOGIN` | The bot account's login (case-sensitive) — used to skip self-loops |

GitHub webhook setup: target repo → Settings → Webhooks → Add. URL `<ngrok>/webhooks/github`, content type `application/json`, set a secret. **Subscribe to these events**: Issue comments, Pull request reviews, Pull request review comments, Check runs.

### Optional knobs

| Var | Default | Notes |
|---|---|---|
| `APPROVAL_LABEL` | `agent:approved` | Linear label that fires execution |
| `PORT` | `4000` | HTTP server port |
| `DB_PATH` | `./data/orchestrator.db` | SQLite file |
| `BASE_BRANCH` | `main` | Branch executor branches from and targets with PRs |
| `WORKTREE_ROOT` | sibling `.laris-worktrees/` of `REPO_PATH` | Where worktrees are created |
| `EXECUTION_TIMEOUT_MS` | 3,600,000 (1 h) | Hard timeout per subagent spawn |
| `VERIFICATION_COMMAND` | unset | Shell command run in the worktree after PR opens (e.g. `npm run check`). Unset = trust the agent's self-report |
| `VERIFICATION_TIMEOUT_MS` | 600,000 (10 min) | Hard timeout for the verification command |
| `VERIFICATION_MAX_RETRIES` | `2` | Number of auto-fix attempts when verification fails. `0` disables auto-retry |
| `PLANNER_MODEL` | `opus` | Model the planner uses (`opus` / `sonnet` / `haiku` / full id) |
| `MAX_COST_USD_PER_TICKET` | `0` | Hard cumulative cap (USD) per ticket. `0` = no cap |
| `IN_PROGRESS_STATE_NAME` | `In Progress` | Linear workflow state name for approved/in-flight |
| `IN_REVIEW_STATE_NAME` | `In Review` | Linear workflow state name once a PR is open |

## Run

Two terminals:

```bash
# Terminal A
npm run dev

# Terminal B
ngrok http 4000
```

Copy the ngrok https URL into the Linear and GitHub webhook configs, restart the daemon. Create a Linear ticket — the daemon logs the event and posts a plan comment. Add `agent:approved` when the plan looks right.

## Project layout

```
src/
├── index.ts             Express app, webhook route wiring, startup reconciliation
├── config.ts            Env validation (zod)
├── state.ts             SQLite schema + helpers (tickets, events, PR linkage, cost, parent/child)
├── budget.ts            Per-ticket spend cap + cumulative cost tracking
├── recovery.ts          Startup sweep: reconcile orphaned 'executing' tickets via `gh pr list`
├── linear.ts            Linear SDK wrapper: issue context, comments, sub-issue creation, workflow state transitions
├── webhooks.ts          Linear HMAC verify + event routing (Issue create / Comment / Issue update for label)
├── github-webhooks.ts   GitHub HMAC verify + routing for issue_comment, review_comment, review, check_run
├── github.ts            Bot login auto-detection (`GET /user`)
├── git.ts               Shared git helpers (`runGit`, `pathExists`)
├── orchestrator.ts      Planning subagent (claude -p, Read-only tools, stream-json session capture)
└── executor.ts          Execution + verification-fix + follow-up subagents, worktree mgmt, subtask split, rollup
data/                    SQLite file (gitignored)
```

## Caveat: Max plan credit allocation

As of **2026-06-15**, `claude -p` on Max plans draws from a separate monthly "Agent SDK credit" allocation, distinct from interactive Claude.ai usage. Heavy use may require migrating to an Anthropic API key.
