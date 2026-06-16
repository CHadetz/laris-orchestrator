import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { withActivity } from './activity.js';
import { assertBudget, BudgetExceededError, budgetNote, recordCost } from './budget.js';
import { config } from './config.js';
import { pathExists, runGit } from './git.js';
import { createChildIssue, fetchIssueContext, type IssueContext, postComment, setIssueState } from './linear.js';
import { extractSubtasks, type ParsedSubtask } from './orchestrator.js';
import { createChildTicket, getTicket, listChildren, savePrInfo, setBaseBranch, setExecutorSessionId, type TicketRow, upsertTicket } from './state.js';

const VERIFICATION_FIX_SYSTEM_PROMPT = `You opened a PR for a Linear ticket, but the project's verification command failed afterward. Your job is to make the smallest changes needed to make verification pass — do NOT change the scope of the original work.

Your cwd is the same worktree where you committed your initial implementation; your earlier commits are there. The session has been resumed, so you remember the original plan and what you've done.

Do this:
1. Read the verification output in your user prompt to see what failed.
2. If CLAUDE.md or README.md document the failing checks, re-read the relevant sections.
3. Make the minimum fix. Do not refactor unrelated code.
4. Commit with a clear message describing the fix, then \`git push origin HEAD\`. The PR will auto-update.

Hard rules:
- Do NOT open a new PR.
- Do NOT amend or force-push.
- Do NOT push to or modify the base branch (${config.BASE_BRANCH}).
- Do NOT skip hooks (--no-verify) or signing.
- Do NOT silence failures with \`// @ts-ignore\`, \`// eslint-disable\`, \`# noqa\`, etc. unless absolutely necessary and explained in the commit message.

Output protocol — your FINAL line must be one of:
- \`FIXED: <one-line summary>\`  if you pushed a fix
- \`BLOCKED: <reason>\`  if you cannot resolve the failures

The orchestrator will re-run verification after you push. If it passes, you're done. If it still fails and retries remain, you'll be invoked again with the new output.`;

const FOLLOWUP_SUBAGENT_SYSTEM_PROMPT = `You are continuing work on a PR that has already been opened for a Linear ticket. Something happened on the PR that needs your response: a comment, a review, a line-anchored review comment, or a failed CI check. Your user prompt names which.

Your cwd is a freshly checked-out worktree on the same branch as the PR — your previous commits are already there. The session has been resumed if available, so you may remember the original plan; if not, the plan is in your prompt.

Do this:
1. Re-read CLAUDE.md and README.md in case anything has changed.
2. Read the input carefully. Decide: does it require code changes, or is it a question/discussion?
   - For PR comments and review summaries: judge intent and respond.
   - For line-anchored review comments: read the file and the surrounding code, not just the diff hunk in the prompt.
   - For CI failures: investigate the failure. If the output in the prompt isn't enough, run \`gh run view --log-failed\` against the details URL. Make the smallest possible fix.
3. If code changes are needed: implement them, run lint/format/typecheck/tests, commit, then push. Your HEAD is detached (so the user can have the same branch checked out elsewhere) — push with the explicit refspec in your user prompt. The existing PR will auto-update.
4. Do NOT post a comment on the PR yourself. The orchestrator will post your reply for you, using the text after the protocol marker on your final line (see below). For line-anchored comments your reply will be threaded under the original comment. Just make that reply text good.

The reply text the orchestrator posts:
- Directly addresses the reviewer's specific point — this is a real conversation.
- If you pushed code: briefly say what you changed.
- If no code change: explain why, or ask for clarification.
- Conversational and concise. Don't quote the reviewer back at them. No "Thanks for the feedback".

Hard rules:
- Do NOT push to or modify the base branch (${config.BASE_BRANCH}).
- Do NOT amend or force-push.
- Do NOT touch .git/config.
- Do NOT skip hooks (--no-verify).
- Do NOT run \`gh pr comment\` or \`gh api\` to post a comment — the orchestrator handles posting.

Output protocol — your FINAL line must be one of:
- \`UPDATED: <reply text>\`  if you pushed new commits. The reply text is what gets posted on the PR.
- \`NO_CHANGES: <reply text>\`  if no code change was warranted. The reply text is what gets posted on the PR.
- \`BLOCKED: <reason>\`  if a human needs to intervene. The reason gets posted on the PR.

Keep the text after the marker to ~1–3 sentences. Plain prose, no leading "Updated:" or "Reply:". Nothing after that line.`;

const SUBAGENT_SYSTEM_PROMPT = `You are an execution agent. The plan in your prompt has been approved by the user. Your cwd is a fresh git worktree on a dedicated branch for this Linear ticket.

Do the work:
1. Learn the project conventions FIRST. Read CLAUDE.md and README.md if they exist. Look at package.json scripts (or equivalent) to find lint, format, typecheck, and test commands. Skipping this step is not optional.
2. Read any files referenced in the plan to ground your changes.
3. Implement the changes described in the plan, matching the existing code style.
4. Before committing, run the project's lint/format/typecheck/test commands you found in step 1. Fix any issues. Run the formatter — incidental formatting fixes to other files are fine and welcome.
5. Commit with a clear message. Multiple commits are fine.
6. Push the branch: \`git push -u origin HEAD\`.
7. Open a PR with \`gh pr create\` — use the ticket title as PR title; in the body, summarize the changes, list the verification commands you ran, and include a line "Linear: <ticket-identifier>" so Linear auto-links.

Hard rules:
- Do NOT push to or modify the base branch (${config.BASE_BRANCH}).
- Do NOT amend or force-push.
- Do NOT touch .git/config or run \`git config --global\`.
- Do NOT skip hooks (--no-verify) or signing.

Output protocol — your FINAL line must be one of:
- \`PR_URL: <url>\`  on success
- \`BLOCKED: <reason>\`  if you cannot complete the task and a human needs to intervene

Nothing after that line.`;

interface ClaudeResult {
  result: string;
  session_id: string;
  total_cost_usd?: number;
  is_error?: boolean;
}

const inFlight = new Map<string, Promise<void>>();

export function dispatchExecution(issueId: string): Promise<void> {
  const prior = inFlight.get(issueId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => withActivity(issueId, 'executor', () => runExecution(issueId)))
    .finally(() => {
      if (inFlight.get(issueId) === next) {
        inFlight.delete(issueId);
      }
    });
  inFlight.set(issueId, next);
  return next;
}

async function runExecution(issueId: string): Promise<void> {
  const ticket = getTicket(issueId);
  if (!ticket?.last_plan) {
    throw new Error(`no stored plan for ${issueId} — cannot execute`);
  }

  const ctx = await fetchIssueContext(issueId);

  // B2: if the parent's plan contains SUBTASK blocks, materialize children and
  // hand off execution to each. Children inherit a self-contained plan body
  // and don't re-trigger splitting. Top-level only — child tickets have
  // parent_issue_id set, so we don't recurse.
  if (!ticket.parent_issue_id) {
    const subtasks = extractSubtasks(ticket.last_plan);
    if (subtasks.length > 0) {
      await splitIntoSubtasks(issueId, ctx, subtasks);
      return;
    }
  }

  try {
    assertBudget(issueId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await fail(issueId, ctx.identifier, err.message);
      return;
    }
    throw err;
  }

  const branch = branchFor(ctx.identifier);
  const worktreePath = path.join(config.WORKTREE_ROOT, ctx.identifier);
  const baseBranch = ticket.base_branch ?? config.BASE_BRANCH;

  console.log(`[executor] ${ctx.identifier}: preparing worktree at ${worktreePath} (base=${baseBranch})`);
  try {
    await prepareWorktree(branch, worktreePath, baseBranch);
  } catch (err) {
    await fail(issueId, ctx.identifier, `worktree setup failed: ${(err as Error).message}`, worktreePath);
    return;
  }

  // Tell the subagent which base branch to target. For B2 children this is the
  // parent's feature branch so all sibling PRs land in one testable place.
  const baseNote = baseBranch === config.BASE_BRANCH
    ? ''
    : `\n\nThis work targets base branch \`${baseBranch}\` (not \`${config.BASE_BRANCH}\`). Open the PR with \`gh pr create --base ${baseBranch}\` so it lands on the right branch.`;

  const userPrompt = `# Ticket ${ctx.identifier}: ${ctx.title}

## Approved plan
${ticket.last_plan}

## Ticket description (for reference)
${ctx.description || '(none)'}${baseNote}

Execute the plan. End with PR_URL: <url> or BLOCKED: <reason> on the final line.`;

  const model = extractRecommendedModel(ticket.last_plan);
  console.log(`[executor] ${ctx.identifier}: spawning subagent (model=${model ?? 'default'})`);
  let result: ClaudeResult;
  try {
    result = await runSubagent({
      prompt: userPrompt,
      cwd: worktreePath,
      systemPrompt: SUBAGENT_SYSTEM_PROMPT,
      model,
      // Persist the session id as soon as the stream emits it, so a worker
      // crash later in the run doesn't lose the resumption handle.
      onSessionId: (sid) => {
        setExecutorSessionId(issueId, sid);
        console.log(`[executor] ${ctx.identifier}: persisted session id ${sid}`);
      },
    });
  } catch (err) {
    await fail(issueId, ctx.identifier, `subagent crashed: ${(err as Error).message}`, worktreePath);
    return;
  }

  if (result.is_error || !result.result) {
    await fail(issueId, ctx.identifier, `subagent returned error: ${JSON.stringify(result)}`, worktreePath);
    return;
  }

  recordCost(issueId, result.total_cost_usd);

  const outcome = parseOutcome(result.result);
  if (outcome.kind === 'pr') {
    const prRef = parsePrUrl(outcome.url);
    if (prRef) {
      savePrInfo(issueId, outcome.url, prRef.repo, prRef.number, result.session_id);
    } else {
      console.warn(`[executor] ${ctx.identifier}: could not parse PR URL ${outcome.url} — follow-ups won't work`);
    }

    // PR exists — iteration moves to GitHub. Reflect that in Linear immediately,
    // before verification runs. If verification later fails, the ticket is still
    // in code-review territory (PR is open with the failing changes), so leaving
    // it in "In Review" matches reality better than reverting to "In Progress".
    void setIssueState(issueId, config.IN_REVIEW_STATE_NAME);

    // Verify independently and auto-retry if it fails. The subagent's
    // self-reported "I ran the checks" isn't trusted.
    let sessionId = result.session_id;
    let verification = await runVerification(worktreePath, ctx.identifier);
    let attempts = 0;
    let fixBlockReason: string | undefined;
    let budgetHit = false;

    while (
      !verification.ok &&
      attempts < config.VERIFICATION_MAX_RETRIES &&
      config.VERIFICATION_COMMAND
    ) {
      try {
        assertBudget(issueId);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          fixBlockReason = err.message;
          budgetHit = true;
          break;
        }
        throw err;
      }
      attempts++;
      console.log(
        `[executor] ${ctx.identifier}: verification failed, auto-fix attempt ${attempts}/${config.VERIFICATION_MAX_RETRIES}`,
      );
      const fix = await runVerificationFix(
        worktreePath,
        issueId,
        ctx.identifier,
        ticket.last_plan,
        sessionId,
        verification,
        attempts,
        config.VERIFICATION_MAX_RETRIES,
      );
      recordCost(issueId, fix.cost);
      if (fix.sessionId) sessionId = fix.sessionId;
      if (fix.kind === 'blocked') {
        fixBlockReason = fix.reason;
        break;
      }
      verification = await runVerification(worktreePath, ctx.identifier);
    }

    // Persist the latest session id so future PR-comment follow-ups resume from the freshest point.
    if (prRef && sessionId !== result.session_id) {
      savePrInfo(issueId, outcome.url, prRef.repo, prRef.number, sessionId);
    }

    if (!verification.ok) {
      upsertTicket(issueId, 'failed');
      const tail = verification.output.slice(-2000);
      const reason = budgetHit
        ? `auto-fix halted: ${fixBlockReason}`
        : fixBlockReason
          ? `auto-fix gave up: ${fixBlockReason}`
          : `auto-fix exhausted ${attempts} retries`;
      await postComment(
        issueId,
        `PR opened (${outcome.url}) but verification command \`${config.VERIFICATION_COMMAND}\` still failing — ${reason}. PR left open; worktree left at \`${worktreePath}\` for inspection.\n\nLast ${tail.length} chars of output:\n\`\`\`\n${tail}\n\`\`\`\n\n${budgetNote(issueId)}`,
      );
      console.error(`[executor] ${ctx.identifier}: verification ultimately failed after ${attempts} attempt(s)`);
      await rollupParentIfComplete(issueId);
      return;
    }

    upsertTicket(issueId, 'done');
    await cleanupWorktree(worktreePath, branch);
    const retryNote = attempts > 0
      ? ` after ${attempts} auto-fix ${attempts === 1 ? 'attempt' : 'attempts'}`
      : '';
    await postComment(
      issueId,
      `Execution complete${retryNote}. PR opened: ${outcome.url}\n\n${budgetNote(issueId)}`,
    );
    console.log(`[executor] ${ctx.identifier}: PR opened ${outcome.url}${retryNote}`);
    await rollupParentIfComplete(issueId);
    return;
  }

  if (outcome.kind === 'blocked') {
    upsertTicket(issueId, 'failed');
    await postComment(
      issueId,
      `Execution blocked by subagent: ${outcome.reason}\n\nWorktree left at \`${worktreePath}\` for inspection. To retry, clean up first:\n\`\`\`\ngit -C ${config.REPO_PATH} worktree remove --force ${worktreePath}\nsqlite3 ${config.DB_PATH} "UPDATE tickets SET state='planning' WHERE issue_id='${issueId}';"\n\`\`\``,
    );
    console.log(`[executor] ${ctx.identifier}: blocked — ${outcome.reason}`);
    await rollupParentIfComplete(issueId);
    return;
  }

  await fail(
    issueId,
    ctx.identifier,
    `subagent finished without PR_URL or BLOCKED line. Last 500 chars:\n${result.result.slice(-500)}`,
    worktreePath,
  );
}

async function prepareWorktree(
  branch: string,
  worktreePath: string,
  baseBranch: string,
): Promise<void> {
  await mkdir(config.WORKTREE_ROOT, { recursive: true });
  if (await pathExists(worktreePath)) {
    throw new Error(
      `worktree already exists at ${worktreePath}. A prior run for this ticket did not clean up. Remove it with: git -C ${config.REPO_PATH} worktree remove --force ${worktreePath}`,
    );
  }
  await runGit(['fetch', '--prune', 'origin']);
  await runGit(['worktree', 'add', worktreePath, '-b', branch, `origin/${baseBranch}`]);
}

async function cleanupWorktree(worktreePath: string, branch: string): Promise<void> {
  try {
    await runGit(['worktree', 'remove', '--force', worktreePath]);
    console.log(`[executor] cleaned up worktree at ${worktreePath}`);
  } catch (err) {
    console.warn(`[executor] failed to clean up worktree at ${worktreePath}: ${(err as Error).message}`);
    return;
  }
  try {
    await runGit(['branch', '-D', branch]);
    console.log(`[executor] deleted local branch ${branch}`);
  } catch (err) {
    console.warn(`[executor] failed to delete local branch ${branch}: ${(err as Error).message}`);
  }
}

function branchFor(identifier: string): string {
  return `agent/${identifier.toLowerCase()}`;
}

interface VerificationResult {
  ok: boolean;
  code: number | null;
  output: string;
}

interface VerificationFixResult {
  kind: 'fixed' | 'blocked' | 'unknown';
  reason?: string;
  sessionId?: string;
  cost?: number;
}

async function runVerificationFix(
  worktreePath: string,
  issueId: string,
  identifier: string,
  lastPlan: string | null,
  sessionId: string,
  verification: VerificationResult,
  attempt: number,
  maxAttempts: number,
): Promise<VerificationFixResult> {
  const model = lastPlan ? extractRecommendedModel(lastPlan) : undefined;
  const tail = verification.output.slice(-4000);
  const prompt = `Verification command \`${config.VERIFICATION_COMMAND}\` failed (exit ${verification.code}). Last output:

\`\`\`
${tail}
\`\`\`

This is auto-fix attempt ${attempt}/${maxAttempts}. Fix the failures, commit, and push. End with FIXED: <summary> or BLOCKED: <reason> on the final line.`;

  let result: ClaudeResult;
  try {
    result = await runSubagent({
      prompt,
      cwd: worktreePath,
      systemPrompt: VERIFICATION_FIX_SYSTEM_PROMPT,
      resumeSessionId: sessionId,
      model,
      onSessionId: (sid) => setExecutorSessionId(issueId, sid),
    });
  } catch (err) {
    console.error(`[executor] ${identifier}: verification-fix subagent crashed: ${(err as Error).message}`);
    return { kind: 'blocked', reason: `subagent crashed: ${(err as Error).message}` };
  }

  if (result.is_error || !result.result) {
    return { kind: 'blocked', reason: `subagent returned error: ${JSON.stringify(result)}`, cost: result.total_cost_usd, sessionId: result.session_id };
  }

  const lines = result.result.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const fixed = line.match(/^FIXED:\s*(.+)/);
    if (fixed) return { kind: 'fixed', reason: fixed[1], sessionId: result.session_id, cost: result.total_cost_usd };
    const blocked = line.match(/^BLOCKED:\s*(.+)/);
    if (blocked) return { kind: 'blocked', reason: blocked[1], sessionId: result.session_id, cost: result.total_cost_usd };
    break;
  }
  return { kind: 'unknown', sessionId: result.session_id, cost: result.total_cost_usd };
}

function runVerification(worktreePath: string, identifier: string): Promise<VerificationResult> {
  return new Promise((resolve) => {
    if (!config.VERIFICATION_COMMAND) {
      resolve({ ok: true, code: 0, output: '' });
      return;
    }
    console.log(`[executor] ${identifier}: running verification \`${config.VERIFICATION_COMMAND}\``);
    const child = spawn(config.VERIFICATION_COMMAND, {
      cwd: worktreePath,
      shell: true,
      env: { ...process.env },
    });
    let output = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, config.VERIFICATION_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ ok: false, code, output: `${output}\n\n[verification timed out after ${config.VERIFICATION_TIMEOUT_MS}ms]` });
        return;
      }
      resolve({ ok: code === 0, code, output });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: `verification command failed to spawn: ${err.message}` });
    });
  });
}

interface SubagentOptions {
  prompt: string;
  cwd: string;
  systemPrompt: string;
  resumeSessionId?: string;
  model?: string;
  /** Fired as soon as the session id is observable in the output stream. Used to
   *  persist it before the run completes, so a worker crash mid-run doesn't lose it. */
  onSessionId?: (sessionId: string) => void;
}

interface StreamEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  total_cost_usd?: number;
  is_error?: boolean;
}

function runSubagent(opts: SubagentOptions): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', opts.prompt,
      // stream-json lets us observe (and persist) the session id mid-run, before
      // the subagent finishes — so a worker crash doesn't lose it.
      '--output-format', 'stream-json',
      '--verbose',
      '--allowedTools', 'Read,Edit,Write,Bash,Glob,Grep',
      '--append-system-prompt', opts.systemPrompt,
    ];
    if (opts.model) {
      args.push('--model', opts.model);
    }
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }

    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: config.CLAUDE_CODE_OAUTH_TOKEN,
        ...(config.GITHUB_TOKEN ? { GITHUB_TOKEN: config.GITHUB_TOKEN, GH_TOKEN: config.GITHUB_TOKEN } : {}),
      },
    });

    let stderr = '';
    let buffer = '';
    let timedOut = false;
    let sessionIdFired = false;
    let final: ClaudeResult | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, config.EXECUTION_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const trimmed = line.trim();
        if (!trimmed) continue;
        let event: StreamEvent;
        try {
          event = JSON.parse(trimmed);
        } catch {
          // Non-JSON line, ignore. Claude's stream-json should not emit any.
          continue;
        }
        if (!sessionIdFired && event.session_id && opts.onSessionId) {
          sessionIdFired = true;
          try {
            opts.onSessionId(event.session_id);
          } catch (err) {
            console.error('[runSubagent] onSessionId callback threw:', err);
          }
        }
        if (event.type === 'result') {
          final = {
            result: event.result ?? '',
            session_id: event.session_id ?? '',
            total_cost_usd: event.total_cost_usd,
            is_error: event.is_error,
          };
        }
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`subagent timed out after ${config.EXECUTION_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${stderr}`));
        return;
      }
      if (!final) {
        reject(new Error(`subagent exited 0 but no final result event was seen.\nstderr:\n${stderr}`));
        return;
      }
      resolve(final);
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

type Outcome =
  | { kind: 'pr'; url: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unknown' };

function parseOutcome(text: string): Outcome {
  const lines = text.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const prMatch = line.match(/^PR_URL:\s*(\S+)/);
    if (prMatch) return { kind: 'pr', url: prMatch[1] };
    const blockedMatch = line.match(/^BLOCKED:\s*(.+)/);
    if (blockedMatch) return { kind: 'blocked', reason: blockedMatch[1] };
    break;
  }
  return { kind: 'unknown' };
}

type FollowupOutcome =
  | { kind: 'updated'; summary: string }
  | { kind: 'no_changes'; reason: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'unknown' };

function parseFollowupOutcome(text: string): FollowupOutcome {
  const lines = text.trimEnd().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const updated = line.match(/^UPDATED:\s*(.+)/);
    if (updated) return { kind: 'updated', summary: updated[1] };
    const noChanges = line.match(/^NO_CHANGES:\s*(.+)/);
    if (noChanges) return { kind: 'no_changes', reason: noChanges[1] };
    const blocked = line.match(/^BLOCKED:\s*(.+)/);
    if (blocked) return { kind: 'blocked', reason: blocked[1] };
    break;
  }
  return { kind: 'unknown' };
}

function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  return { repo: m[1], number: parseInt(m[2], 10) };
}

function extractRecommendedModel(plan: string): string | undefined {
  const m = plan.match(/\*\*Recommended execution model:\*\*\s*(\S+)/i);
  return m?.[1];
}

export type FollowupSource =
  | { kind: 'pr_comment'; commenter: string; body: string }
  | {
      kind: 'review_comment';
      commenter: string;
      body: string;
      filePath: string;
      line?: number;
      diffHunk?: string;
      commentId: number;
    }
  | { kind: 'review'; commenter: string; body: string; state: string }
  | {
      kind: 'ci_failure';
      checkName: string;
      conclusion: string;
      output: string;
      detailsUrl?: string;
    };

export function dispatchFollowup(issueId: string, source: FollowupSource): Promise<void> {
  const prior = inFlight.get(issueId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => withActivity(issueId, 'followup', () => runFollowup(issueId, source), describeSource(source)))
    .finally(() => {
      if (inFlight.get(issueId) === next) {
        inFlight.delete(issueId);
      }
    });
  inFlight.set(issueId, next);
  return next;
}

function describeSource(source: FollowupSource): string {
  switch (source.kind) {
    case 'pr_comment':
      return `PR comment from @${source.commenter}`;
    case 'review_comment':
      return `line-anchored review comment from @${source.commenter} on ${source.filePath}${source.line ? `:${source.line}` : ''}`;
    case 'review':
      return `PR review (${source.state}) from @${source.commenter}`;
    case 'ci_failure':
      return `CI check failed: ${source.checkName}`;
  }
}

function buildFollowupPrompt(
  source: FollowupSource,
  ticket: TicketRow,
  ctx: IssueContext,
  branch: string,
  haveSession: boolean,
): string {
  const planContext = ticket.last_plan
    ? `## Original approved plan\n${ticket.last_plan}\n\n## Ticket description\n${ctx.description || '(none)'}\n\n---\n\n`
    : '';
  const sessionHint = haveSession
    ? ''
    : `_(No prior session is being resumed for this PR — start fresh. Read the diff with \`git diff origin/${config.BASE_BRANCH}...HEAD\` to see what was already implemented.)_\n\n`;
  const pushHint = `If you need to push commits, your HEAD is detached. Push with:
\`\`\`
git push origin HEAD:${branch}
\`\`\``;

  switch (source.kind) {
    case 'pr_comment':
      return `# PR comment from @${source.commenter} on ${ticket.pr_url}

${planContext}${sessionHint}> ${source.body.replace(/\n/g, '\n> ')}

Address this. The orchestrator will post your reply on the PR — do NOT post one yourself.

${pushHint}

End with UPDATED: <reply text>, NO_CHANGES: <reply text>, or BLOCKED: <reason> on the final line.`;

    case 'review_comment': {
      const loc = source.line ? `${source.filePath}:${source.line}` : source.filePath;
      const hunk = source.diffHunk
        ? `\n\nDiff hunk the comment refers to:\n\`\`\`diff\n${source.diffHunk}\n\`\`\`\n`
        : '\n';
      return `# Line-anchored review comment on PR ${ticket.pr_url}

${planContext}${sessionHint}From @${source.commenter} on \`${loc}\`:${hunk}
> ${source.body.replace(/\n/g, '\n> ')}

Address this. The orchestrator will thread your reply UNDER the line comment — do NOT post one yourself.

${pushHint}

End with UPDATED: <reply text>, NO_CHANGES: <reply text>, or BLOCKED: <reason> on the final line.`;
    }

    case 'review':
      return `# Pull request review from @${source.commenter} (state: ${source.state}) on ${ticket.pr_url}

${planContext}${sessionHint}Review body:

> ${source.body.replace(/\n/g, '\n> ')}

This is the overall review summary. Any line-anchored comments arrive as separate events you may already have handled or will handle next.

Address this. The orchestrator will post your reply on the PR — do NOT post one yourself.

${pushHint}

End with UPDATED: <reply text>, NO_CHANGES: <reply text>, or BLOCKED: <reason> on the final line.`;

    case 'ci_failure': {
      const tail = source.output.slice(-4000);
      const detailsLine = source.detailsUrl ? `\nDetails: ${source.detailsUrl}` : '';
      return `# CI check failed on PR ${ticket.pr_url}

${planContext}${sessionHint}Check: \`${source.checkName}\` (conclusion: ${source.conclusion})${detailsLine}

Last ~4KB of check output:
\`\`\`
${tail}
\`\`\`

Investigate. If the check output is not enough, run \`gh run view --log-failed\` (or follow the details URL) to see full logs. Fix the failure with the minimum change needed — do NOT widen scope. Then commit and push.

${pushHint}

End with UPDATED: <reply text>, NO_CHANGES: <reply text>, or BLOCKED: <reason> on the final line. The reply text will be posted on the PR.`;
    }
  }
}

async function runFollowup(issueId: string, source: FollowupSource): Promise<void> {
  const ticket = getTicket(issueId);
  if (!ticket?.pr_url) {
    console.warn(`[followup] ${issueId}: no PR info on file, skipping`);
    return;
  }
  const haveSession = !!ticket.executor_session_id;

  const ctx = await fetchIssueContext(issueId);
  const branch = branchFor(ctx.identifier);
  const worktreePath = path.join(config.WORKTREE_ROOT, ctx.identifier);

  const prRepo = ticket.pr_repo!;
  const prNumber = ticket.pr_number!;
  const sourceDesc = describeSource(source);

  try {
    assertBudget(issueId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      await replyToSource(source, prRepo, prNumber, `Cannot respond: ${err.message}.`, ctx.identifier);
      return;
    }
    throw err;
  }

  console.log(`[followup] ${ctx.identifier}: rehydrating worktree for ${sourceDesc}`);
  try {
    await prepareFollowupWorktree(branch, worktreePath);
  } catch (err) {
    console.error(`[followup] ${ctx.identifier}: worktree rehydration failed: ${(err as Error).message}`);
    await replyToSource(
      source,
      prRepo,
      prNumber,
      `Could not act on this: worktree rehydration failed (${(err as Error).message}).`,
      ctx.identifier,
    );
    return;
  }

  const prompt = buildFollowupPrompt(source, ticket, ctx, branch, haveSession);
  const model = ticket.last_plan ? extractRecommendedModel(ticket.last_plan) : undefined;
  console.log(`[followup] ${ctx.identifier}: spawning subagent for ${sourceDesc} (session=${haveSession ? 'resumed' : 'fresh'}, model=${model ?? 'default'})`);
  let result: ClaudeResult;
  try {
    result = await runSubagent({
      prompt,
      cwd: worktreePath,
      systemPrompt: FOLLOWUP_SUBAGENT_SYSTEM_PROMPT,
      resumeSessionId: haveSession ? ticket.executor_session_id! : undefined,
      model,
      onSessionId: (sid) => setExecutorSessionId(issueId, sid),
    });
  } catch (err) {
    await cleanupWorktree(worktreePath, branch);
    await replyToSource(source, prRepo, prNumber, `Subagent crashed: ${(err as Error).message}`, ctx.identifier);
    return;
  }

  if (result.is_error || !result.result) {
    await cleanupWorktree(worktreePath, branch);
    await replyToSource(source, prRepo, prNumber, `Subagent returned error: ${JSON.stringify(result)}`, ctx.identifier);
    return;
  }

  savePrInfo(issueId, ticket.pr_url, prRepo, prNumber, result.session_id);
  recordCost(issueId, result.total_cost_usd);

  const outcome = parseFollowupOutcome(result.result);
  await cleanupWorktree(worktreePath, branch);

  const auditPrefix = `[audit] ${sourceDesc} on ${ticket.pr_url} —`;

  if (outcome.kind === 'updated') {
    const r = await replyToSource(source, prRepo, prNumber, outcome.summary, ctx.identifier);
    await postComment(issueId, `${auditPrefix} pushed update: ${outcome.summary}${prPostNote(r)} ${budgetNote(issueId)}`);
    console.log(`[followup] ${ctx.identifier}: updated — ${outcome.summary}`);
  } else if (outcome.kind === 'no_changes') {
    const r = await replyToSource(source, prRepo, prNumber, outcome.reason, ctx.identifier);
    await postComment(issueId, `${auditPrefix} no code change: ${outcome.reason}${prPostNote(r)}`);
    console.log(`[followup] ${ctx.identifier}: no_changes — ${outcome.reason}`);
  } else if (outcome.kind === 'blocked') {
    const r = await replyToSource(source, prRepo, prNumber, `Blocked: ${outcome.reason}`, ctx.identifier);
    await postComment(issueId, `${auditPrefix} blocked: ${outcome.reason}${prPostNote(r)}`);
    console.log(`[followup] ${ctx.identifier}: blocked — ${outcome.reason}`);
  } else {
    const r = await replyToSource(
      source,
      prRepo,
      prNumber,
      `Subagent finished without an UPDATED/NO_CHANGES/BLOCKED marker — see Linear ticket for details.`,
      ctx.identifier,
    );
    await postComment(
      issueId,
      `${auditPrefix} subagent finished without UPDATED/NO_CHANGES/BLOCKED marker.${prPostNote(r)} Last 500 chars:\n${result.result.slice(-500)}`,
    );
  }
}

/** Route the reply to the right place: thread it under a line comment, or post
 *  top-level on the PR for everything else. */
async function replyToSource(
  source: FollowupSource,
  repo: string,
  prNumber: number,
  body: string,
  identifier: string,
): Promise<PrPostResult> {
  if (source.kind === 'review_comment') {
    try {
      await postPrReviewCommentReply(repo, prNumber, source.commentId, body);
      console.log(`[followup] ${identifier}: posted threaded reply on PR ${repo}#${prNumber} (comment ${source.commentId})`);
      return { ok: true };
    } catch (err) {
      const msg = (err as Error).message;
      console.error(`[followup] ${identifier}: threaded reply failed, falling back to top-level: ${msg}`);
      // Fall through to top-level post so the reply isn't lost.
      const top = await tryPostPrComment(repo, prNumber, body, identifier);
      return top.ok ? top : { ok: false, error: `threaded: ${msg}; top-level: ${top.error}` };
    }
  }
  return tryPostPrComment(repo, prNumber, body, identifier);
}

interface PrPostResult {
  ok: boolean;
  error?: string;
}

function prPostNote(r: PrPostResult): string {
  return r.ok ? '' : `\n\n_(failed to post reply on PR: ${r.error})_`;
}

async function tryPostPrComment(
  repo: string,
  number: number,
  body: string,
  identifier: string,
): Promise<PrPostResult> {
  try {
    await postPrComment(repo, number, body);
    console.log(`[followup] ${identifier}: posted reply on PR ${repo}#${number}`);
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[followup] ${identifier}: failed to post PR reply: ${msg}`);
    return { ok: false, error: msg };
  }
}

function postPrComment(repo: string, number: number, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      ['pr', 'comment', String(number), '--repo', repo, '--body-file', '-'],
      {
        env: {
          ...process.env,
          ...(config.GITHUB_TOKEN
            ? { GITHUB_TOKEN: config.GITHUB_TOKEN, GH_TOKEN: config.GITHUB_TOKEN }
            : {}),
        },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh pr comment exited ${code}: ${stderr}`));
    });
    child.on('error', reject);
    child.stdin.end(body);
  });
}

/** Post a threaded reply to a PR line-anchored review comment, via the GitHub
 *  REST API. Uses `gh api --input -` and pipes JSON through stdin so multi-line
 *  bodies survive shell quoting. */
function postPrReviewCommentReply(
  repo: string,
  prNumber: number,
  commentId: number,
  body: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'gh',
      [
        'api',
        '--method', 'POST',
        `/repos/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
        '--input', '-',
      ],
      {
        env: {
          ...process.env,
          ...(config.GITHUB_TOKEN
            ? { GITHUB_TOKEN: config.GITHUB_TOKEN, GH_TOKEN: config.GITHUB_TOKEN }
            : {}),
        },
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`gh api (review-comment reply) exited ${code}: ${stderr}`));
    });
    child.on('error', reject);
    child.stdin.end(JSON.stringify({ body }));
  });
}

async function prepareFollowupWorktree(branch: string, worktreePath: string): Promise<void> {
  await mkdir(config.WORKTREE_ROOT, { recursive: true });
  if (await pathExists(worktreePath)) {
    // Leftover from a previous failed run — clean it.
    await cleanupWorktree(worktreePath, branch);
  }
  await runGit(['fetch', '--prune', 'origin']);
  // Detached HEAD — never conflicts with whatever the user has checked out
  // at REPO_PATH (including this same branch). The subagent must push with an
  // explicit refspec (HEAD:<branch>); see FOLLOWUP_SUBAGENT_SYSTEM_PROMPT.
  await runGit(['worktree', 'add', '--detach', worktreePath, `origin/${branch}`]);
}

/** Called after a child reaches a terminal state. If this was the last sibling
 *  to finish, post a rollup comment on the parent and mark it 'done' so we don't
 *  post again. No-op for tickets that aren't children. */
async function rollupParentIfComplete(childIssueId: string): Promise<void> {
  const child = getTicket(childIssueId);
  if (!child?.parent_issue_id) return;

  const parent = getTicket(child.parent_issue_id);
  // 'split' is the post-split state; if it's already 'done' we've rolled up.
  if (!parent || parent.state !== 'split') return;

  const siblings = listChildren(child.parent_issue_id);
  if (siblings.length === 0) return;
  const allTerminal = siblings.every((s) => s.state === 'done' || s.state === 'failed');
  if (!allTerminal) return;

  upsertTicket(child.parent_issue_id, 'done');

  // Fetch each child's Linear identifier for the rollup. One call per child —
  // acceptable for the one-time rollup posting.
  const lines: string[] = [];
  for (const s of siblings) {
    let identifier = s.issue_id.slice(0, 8);
    try {
      const ctx = await fetchIssueContext(s.issue_id);
      identifier = ctx.identifier;
    } catch {
      // fall back to UUID prefix
    }
    const icon = s.state === 'done' ? '✅' : '❌';
    const ref = s.pr_url ?? '_no PR_';
    lines.push(`${icon} ${identifier} — ${ref}`);
  }

  const succeeded = siblings.filter((s) => s.state === 'done').length;
  const failed = siblings.length - succeeded;
  const summary =
    failed === 0
      ? `All ${siblings.length} subtasks finished successfully.`
      : `${succeeded}/${siblings.length} subtasks succeeded, ${failed} failed.`;

  // If this split used a feature branch, point the reviewer at the integrated
  // result they can test in one place.
  const featureBranch = parent.base_branch;
  const featureNote = featureBranch
    ? `\n\nAll child PRs target feature branch \`${featureBranch}\`. Once they're merged you can review the integrated result there, then open a PR \`${featureBranch}\` → \`${config.BASE_BRANCH}\`.`
    : '';

  try {
    await postComment(
      child.parent_issue_id,
      `${summary}\n\n${lines.join('\n')}${featureNote}\n\n${budgetNote(child.parent_issue_id)}`,
    );
  } catch (err) {
    console.error(`[rollup] failed to post rollup comment on parent ${child.parent_issue_id}:`, err);
  }
}

async function splitIntoSubtasks(
  parentIssueId: string,
  parentCtx: IssueContext,
  subtasks: ParsedSubtask[],
): Promise<void> {
  if (!parentCtx.teamId) {
    await fail(parentIssueId, parentCtx.identifier, 'cannot split into subtasks: Linear team id not found on parent ticket');
    return;
  }

  // Create a single feature branch off BASE_BRANCH that all sibling PRs will
  // target. Reviewing children's PRs merges them here; the feature branch
  // becomes the single testable, reviewable state for the whole ticket.
  const featureBranch = branchFor(parentCtx.identifier);
  try {
    await ensureFeatureBranchOnRemote(featureBranch);
    setBaseBranch(parentIssueId, featureBranch);
  } catch (err) {
    await fail(
      parentIssueId,
      parentCtx.identifier,
      `could not create feature branch \`${featureBranch}\` on origin: ${(err as Error).message}`,
    );
    return;
  }

  const created: Array<{ id: string; identifier: string; title: string }> = [];
  const failures: Array<{ title: string; reason: string }> = [];

  for (const sub of subtasks) {
    try {
      const child = await createChildIssue({
        teamId: parentCtx.teamId,
        parentId: parentIssueId,
        title: sub.title,
        description: sub.body,
      });
      if (!child) {
        failures.push({ title: sub.title, reason: 'Linear createIssue returned no issue' });
        continue;
      }
      // Bake the model override (if any) into the child's plan so extractRecommendedModel finds it.
      const planBody = sub.model
        ? `${sub.body}\n\n**Recommended execution model:** ${sub.model}`
        : sub.body;
      createChildTicket(child.id, parentIssueId, planBody, featureBranch);
      created.push({ id: child.id, identifier: child.identifier, title: sub.title });
      // Children skip approval, so flip them straight to In Progress.
      void setIssueState(child.id, config.IN_PROGRESS_STATE_NAME);
      console.log(`[split] ${parentCtx.identifier} → ${child.identifier}: ${sub.title}`);
    } catch (err) {
      failures.push({ title: sub.title, reason: (err as Error).message });
    }
  }

  if (created.length === 0) {
    await fail(
      parentIssueId,
      parentCtx.identifier,
      `Failed to create any child subtasks:\n${failures.map((f) => `- ${f.title}: ${f.reason}`).join('\n')}`,
    );
    return;
  }

  upsertTicket(parentIssueId, 'split');
  const childList = created.map((c) => `- ${c.identifier}: ${c.title}`).join('\n');
  const failTail = failures.length
    ? `\n\n⚠️ ${failures.length} subtask${failures.length === 1 ? '' : 's'} failed to create:\n${failures.map((f) => `- ${f.title}: ${f.reason}`).join('\n')}`
    : '';
  await postComment(
    parentIssueId,
    `Split into ${created.length} subtask${created.length === 1 ? '' : 's'}, all targeting feature branch \`${featureBranch}\` (off \`${config.BASE_BRANCH}\`):\n${childList}${failTail}\n\nEach child executes independently — no further approval needed. Children's PRs land on the feature branch so you can review and test them together; merge the feature branch to \`${config.BASE_BRANCH}\` when satisfied.\n\n${budgetNote(parentIssueId)}`,
  );

  for (const child of created) {
    void dispatchExecution(child.id).catch((err) => {
      console.error(`[split] ${parentCtx.identifier} → ${child.identifier}: dispatch failed:`, err);
    });
  }
}

/** Create the feature branch on origin if it doesn't already exist. Idempotent. */
async function ensureFeatureBranchOnRemote(featureBranch: string): Promise<void> {
  await runGit(['fetch', '--prune', 'origin']);
  try {
    // Push origin/<base> to a new remote branch. Fails if the branch already
    // exists, which we treat as "fine, reuse it" (could be a re-split or a
    // human-initiated branch with the same name).
    await runGit([
      'push',
      'origin',
      `refs/remotes/origin/${config.BASE_BRANCH}:refs/heads/${featureBranch}`,
    ]);
    console.log(`[split] created feature branch ${featureBranch} on origin off ${config.BASE_BRANCH}`);
  } catch (err) {
    const msg = (err as Error).message;
    // "already exists" / "non-fast-forward" — assume it's there and we'll reuse.
    if (/already exists|non-fast-forward|rejected/i.test(msg)) {
      console.log(`[split] feature branch ${featureBranch} already exists on origin, reusing`);
      return;
    }
    throw err;
  }
}

async function fail(
  issueId: string,
  identifier: string,
  reason: string,
  worktreePath?: string,
): Promise<void> {
  console.error(`[executor] ${identifier}: ${reason}`);
  upsertTicket(issueId, 'failed');
  const cleanupHint =
    worktreePath && (await pathExists(worktreePath))
      ? `\n\nWorktree left at \`${worktreePath}\` for inspection. To retry, clean up first:\n\`\`\`\ngit -C ${config.REPO_PATH} worktree remove --force ${worktreePath}\ngit -C ${config.REPO_PATH} branch -D ${branchFor(identifier)}\nsqlite3 ${config.DB_PATH} "UPDATE tickets SET state='planning' WHERE issue_id='${issueId}';"\n\`\`\``
      : '';
  try {
    await postComment(issueId, `Execution failed: ${reason}${cleanupHint}`);
  } catch (err) {
    console.error(`[executor] also failed to post failure comment: ${err}`);
  }
  await rollupParentIfComplete(issueId);
}
