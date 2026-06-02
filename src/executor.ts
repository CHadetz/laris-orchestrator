import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { pathExists, runGit } from './git.js';
import { fetchIssueContext, postComment } from './linear.js';
import { getTicket, savePrInfo, upsertTicket } from './state.js';

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

const FOLLOWUP_SUBAGENT_SYSTEM_PROMPT = `You are continuing work on a PR that has already been opened for a Linear ticket. A reviewer has commented on the PR and you need to respond on the PR.

Your cwd is a freshly checked-out worktree on the same branch as the PR — your previous commits are already there. The session has been resumed, so you remember the original plan.

Do this:
1. Re-read CLAUDE.md and README.md in case anything has changed.
2. Read the reviewer's comment carefully. Decide: does it require code changes, or is it a question/discussion?
3. If code changes are needed: implement them, run lint/format/typecheck/tests, commit, then \`git push origin HEAD\`. The existing PR will auto-update.
4. Post a reply on the PR with \`gh pr comment <PR_NUMBER> --body "..."\` (the PR number is in your user prompt). Your reply:
   - Should directly address the reviewer's specific point — this is a real conversation, not a status report.
   - If you pushed code: briefly say what you changed.
   - If no code change: explain why you decided not to change anything, or ask for clarification if the comment was ambiguous.
   - Keep it conversational and concise. Don't quote the reviewer back at them. Don't add boilerplate like "Thank you for the feedback".
   - Use \`--body-file\` (or a heredoc) if the reply has multiple lines, to avoid shell quoting issues.

Hard rules:
- Do NOT push to or modify the base branch (${config.BASE_BRANCH}).
- Do NOT amend or force-push.
- Do NOT touch .git/config.
- Do NOT skip hooks (--no-verify).
- Post the PR comment exactly once.

Output protocol — your FINAL line must be one of:
- \`UPDATED: <one-line summary>\`  if you pushed new commits
- \`NO_CHANGES: <one-line explanation>\`  if you decided no code change was warranted
- \`BLOCKED: <reason>\`  if you cannot proceed and a human needs to intervene

Nothing after that line.`;

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
    .then(() => runExecution(issueId))
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
  const branch = branchFor(ctx.identifier);
  const worktreePath = path.join(config.WORKTREE_ROOT, ctx.identifier);

  console.log(`[executor] ${ctx.identifier}: preparing worktree at ${worktreePath}`);
  try {
    await prepareWorktree(branch, worktreePath);
  } catch (err) {
    await fail(issueId, ctx.identifier, `worktree setup failed: ${(err as Error).message}`, worktreePath);
    return;
  }

  const userPrompt = `# Ticket ${ctx.identifier}: ${ctx.title}

## Approved plan
${ticket.last_plan}

## Ticket description (for reference)
${ctx.description || '(none)'}

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
    });
  } catch (err) {
    await fail(issueId, ctx.identifier, `subagent crashed: ${(err as Error).message}`, worktreePath);
    return;
  }

  if (result.is_error || !result.result) {
    await fail(issueId, ctx.identifier, `subagent returned error: ${JSON.stringify(result)}`, worktreePath);
    return;
  }

  const outcome = parseOutcome(result.result);
  if (outcome.kind === 'pr') {
    const prRef = parsePrUrl(outcome.url);
    if (prRef) {
      savePrInfo(issueId, outcome.url, prRef.repo, prRef.number, result.session_id);
    } else {
      console.warn(`[executor] ${ctx.identifier}: could not parse PR URL ${outcome.url} — follow-ups won't work`);
    }

    // Verify independently and auto-retry if it fails. The subagent's
    // self-reported "I ran the checks" isn't trusted.
    let totalCost = result.total_cost_usd ?? 0;
    let sessionId = result.session_id;
    let verification = await runVerification(worktreePath, ctx.identifier);
    let attempts = 0;
    let fixBlockReason: string | undefined;

    while (
      !verification.ok &&
      attempts < config.VERIFICATION_MAX_RETRIES &&
      config.VERIFICATION_COMMAND
    ) {
      attempts++;
      console.log(
        `[executor] ${ctx.identifier}: verification failed, auto-fix attempt ${attempts}/${config.VERIFICATION_MAX_RETRIES}`,
      );
      const fix = await runVerificationFix(
        worktreePath,
        ctx.identifier,
        ticket.last_plan,
        sessionId,
        verification,
        attempts,
        config.VERIFICATION_MAX_RETRIES,
      );
      if (fix.cost) totalCost += fix.cost;
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
      const reason = fixBlockReason
        ? `auto-fix gave up: ${fixBlockReason}`
        : `auto-fix exhausted ${attempts} retries`;
      await postComment(
        issueId,
        `PR opened (${outcome.url}) but verification command \`${config.VERIFICATION_COMMAND}\` still failing — ${reason}. PR left open; worktree left at \`${worktreePath}\` for inspection.\n\nLast ${tail.length} chars of output:\n\`\`\`\n${tail}\n\`\`\`\n\n(cost: $${totalCost.toFixed(4)})`,
      );
      console.error(`[executor] ${ctx.identifier}: verification ultimately failed after ${attempts} attempt(s)`);
      return;
    }

    upsertTicket(issueId, 'done');
    await cleanupWorktree(worktreePath, branch);
    const retryNote = attempts > 0
      ? ` after ${attempts} auto-fix ${attempts === 1 ? 'attempt' : 'attempts'}`
      : '';
    await postComment(
      issueId,
      `Execution complete${retryNote}. PR opened: ${outcome.url}\n\n(cost: $${totalCost.toFixed(4)})`,
    );
    console.log(`[executor] ${ctx.identifier}: PR opened ${outcome.url}${retryNote}`);
    return;
  }

  if (outcome.kind === 'blocked') {
    upsertTicket(issueId, 'failed');
    await postComment(
      issueId,
      `Execution blocked by subagent: ${outcome.reason}\n\nWorktree left at \`${worktreePath}\` for inspection. To retry, clean up first:\n\`\`\`\ngit -C ${config.REPO_PATH} worktree remove --force ${worktreePath}\nsqlite3 ${config.DB_PATH} "UPDATE tickets SET state='planning' WHERE issue_id='${issueId}';"\n\`\`\``,
    );
    console.log(`[executor] ${ctx.identifier}: blocked — ${outcome.reason}`);
    return;
  }

  await fail(
    issueId,
    ctx.identifier,
    `subagent finished without PR_URL or BLOCKED line. Last 500 chars:\n${result.result.slice(-500)}`,
    worktreePath,
  );
}

async function prepareWorktree(branch: string, worktreePath: string): Promise<void> {
  await mkdir(config.WORKTREE_ROOT, { recursive: true });
  if (await pathExists(worktreePath)) {
    throw new Error(
      `worktree already exists at ${worktreePath}. A prior run for this ticket did not clean up. Remove it with: git -C ${config.REPO_PATH} worktree remove --force ${worktreePath}`,
    );
  }
  await runGit(['fetch', '--prune', 'origin']);
  await runGit(['worktree', 'add', worktreePath, '-b', branch, `origin/${config.BASE_BRANCH}`]);
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
}

function runSubagent(opts: SubagentOptions): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', opts.prompt,
      '--output-format', 'json',
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

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, config.EXECUTION_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
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
      try {
        resolve(JSON.parse(stdout) as ClaudeResult);
      } catch (e) {
        reject(new Error(`failed to parse claude -p JSON output: ${e}\nstdout:\n${stdout}`));
      }
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

export function dispatchFollowup(
  issueId: string,
  commenter: string,
  commentBody: string,
): Promise<void> {
  const prior = inFlight.get(issueId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => runFollowup(issueId, commenter, commentBody))
    .finally(() => {
      if (inFlight.get(issueId) === next) {
        inFlight.delete(issueId);
      }
    });
  inFlight.set(issueId, next);
  return next;
}

async function runFollowup(issueId: string, commenter: string, commentBody: string): Promise<void> {
  const ticket = getTicket(issueId);
  if (!ticket?.executor_session_id || !ticket.pr_url) {
    console.warn(`[followup] ${issueId}: no executor session or PR info on file, skipping`);
    return;
  }

  const ctx = await fetchIssueContext(issueId);
  const branch = branchFor(ctx.identifier);
  const worktreePath = path.join(config.WORKTREE_ROOT, ctx.identifier);

  console.log(`[followup] ${ctx.identifier}: rehydrating worktree for PR comment from ${commenter}`);
  try {
    await prepareFollowupWorktree(branch, worktreePath);
  } catch (err) {
    console.error(`[followup] ${ctx.identifier}: worktree rehydration failed: ${(err as Error).message}`);
    await postComment(issueId, `Could not respond to PR feedback from @${commenter}: worktree rehydration failed (${(err as Error).message})`);
    return;
  }

  const prompt = `# Reviewer feedback on PR ${ticket.pr_url}

PR_NUMBER: ${ticket.pr_number}
PR_REPO: ${ticket.pr_repo}

From @${commenter}:

> ${commentBody.replace(/\n/g, '\n> ')}

Address this and reply on the PR via \`gh pr comment ${ticket.pr_number}\`. End with UPDATED: <summary>, NO_CHANGES: <reason>, or BLOCKED: <reason> on the final line.`;

  const model = ticket.last_plan ? extractRecommendedModel(ticket.last_plan) : undefined;
  let result: ClaudeResult;
  try {
    result = await runSubagent({
      prompt,
      cwd: worktreePath,
      systemPrompt: FOLLOWUP_SUBAGENT_SYSTEM_PROMPT,
      resumeSessionId: ticket.executor_session_id,
      model,
    });
  } catch (err) {
    await cleanupWorktree(worktreePath, branch);
    await postComment(issueId, `Follow-up subagent crashed responding to @${commenter}: ${(err as Error).message}`);
    return;
  }

  if (result.is_error || !result.result) {
    await cleanupWorktree(worktreePath, branch);
    await postComment(issueId, `Follow-up subagent returned error responding to @${commenter}: ${JSON.stringify(result)}`);
    return;
  }

  // Persist the new session id so the conversation thread keeps growing across follow-ups.
  savePrInfo(issueId, ticket.pr_url, ticket.pr_repo!, ticket.pr_number!, result.session_id);

  const outcome = parseFollowupOutcome(result.result);
  await cleanupWorktree(worktreePath, branch);

  const auditPrefix = `[audit] PR feedback from @${commenter} on ${ticket.pr_url} —`;
  if (outcome.kind === 'updated') {
    await postComment(issueId, `${auditPrefix} pushed update: ${outcome.summary} (cost: $${result.total_cost_usd ?? '?'})`);
    console.log(`[followup] ${ctx.identifier}: updated — ${outcome.summary}`);
  } else if (outcome.kind === 'no_changes') {
    await postComment(issueId, `${auditPrefix} no code change: ${outcome.reason}`);
    console.log(`[followup] ${ctx.identifier}: no_changes — ${outcome.reason}`);
  } else if (outcome.kind === 'blocked') {
    await postComment(issueId, `${auditPrefix} blocked: ${outcome.reason}`);
    console.log(`[followup] ${ctx.identifier}: blocked — ${outcome.reason}`);
  } else {
    await postComment(
      issueId,
      `${auditPrefix} subagent finished without UPDATED/NO_CHANGES/BLOCKED marker. Last 500 chars:\n${result.result.slice(-500)}`,
    );
  }
}

async function prepareFollowupWorktree(branch: string, worktreePath: string): Promise<void> {
  await mkdir(config.WORKTREE_ROOT, { recursive: true });
  if (await pathExists(worktreePath)) {
    // Leftover from a previous failed run — clean it.
    await cleanupWorktree(worktreePath, branch);
  }
  // Defensive: branch may exist locally if cleanup partially failed.
  try {
    await runGit(['branch', '-D', branch]);
  } catch {
    // Branch didn't exist — that's the expected case.
  }
  await runGit(['fetch', '--prune', 'origin']);
  await runGit(['worktree', 'add', worktreePath, '-b', branch, `origin/${branch}`]);
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
}
