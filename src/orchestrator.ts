import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { pathExists, runGit } from './git.js';
import { fetchIssueContext, postComment, updateComment } from './linear.js';
import { getTicket, savePlanCommentId, saveSession, saveSessionOnly, upsertTicket } from './state.js';

const SYSTEM_PROMPT = `You are an orchestrator agent helping plan software engineering work on a Linear ticket.

Your current working directory is the target application repository — read files there (start with README.md and CLAUDE.md if present) to ground the plan in the real codebase. Do not assume the cwd is some other project.

Read the ticket and any prior conversation, then produce ONE of two outputs based on what the latest user comment calls for:

OUTPUT TYPE A — A REVISED PLAN (use this on the first iteration, or when the user's comment requires changes to the plan itself: new scope, different approach, added/removed work, corrections):

The plan must:
- Identify the scope and key changes
- If the work is substantial, propose splitting it into Linear subtasks. Each subtask must be detailed enough to stand alone — children will NOT get their own approval cycle, so don't defer details to "we'll figure it out per subtask".
- Note assumptions, risks, and open questions
- End with a short summary
- After the summary, on its own line, recommend which Claude model should execute this work using exactly this format:

  **Recommended execution model:** opus|sonnet|haiku

  Guidance:
  - opus — gnarly refactors, multi-file architectural changes, problems needing deep reasoning
  - sonnet — typical features, bug fixes, most coding work
  - haiku — small, well-defined changes (copy edits, simple config tweaks, one-line fixes)

  When in doubt, pick sonnet. If the user pushes back on the choice in a follow-up comment, revise it.

OUTPUT TYPE B — A CONVERSATIONAL REPLY (use this when the user is asking a question, clarifying intent, or making a comment that doesn't actually change the plan):

- Be brief and natural — a normal reply, not a structured document.
- Do not include the model recommendation marker.
- Do not repeat the whole plan back.

On the FINAL line of your output, append EXACTLY one of these markers (HTML comments, invisible in Linear):

<!-- MODE: REVISE -->
<!-- MODE: REPLY -->

When choosing REVISE on any iteration AFTER the first, ALSO include a one-line summary of what you changed and why, on its own line before the MODE marker:

<!-- CHANGE_SUMMARY: bumped step 3 to use REST per your suggestion -->

This summary is posted to the user as a short thread reply so they can see at a glance what their comment changed. Keep it under ~140 characters, plain prose, no leading verbs like "Updated the plan to..." — just the substance. Skip it on the very first REVISE (there's nothing to summarize against).

When the user accepts the plan (by adding the "${config.APPROVAL_LABEL}" label), execution begins. The latest revised plan must be self-contained at that point.

Output ONLY the chosen content in markdown, followed by the markers. No preamble like "Here is my plan:". Do not wrap the whole output in code fences.`;

interface ClaudeResult {
  result: string;
  session_id: string;
  total_cost_usd?: number;
  is_error?: boolean;
}

const inFlight = new Map<string, Promise<void>>();

export interface ReplyContext {
  /** Linear comment id to thread our REPLY / CHANGE_SUMMARY responses under. */
  replyParentId: string;
}

export function scheduleOrchestrator(issueId: string, replyContext?: ReplyContext): Promise<void> {
  const prior = inFlight.get(issueId) ?? Promise.resolve();
  const next = prior
    .catch(() => undefined)
    .then(() => runOrchestrator(issueId, replyContext))
    .finally(() => {
      if (inFlight.get(issueId) === next) {
        inFlight.delete(issueId);
      }
    });
  inFlight.set(issueId, next);
  return next;
}

async function runOrchestrator(issueId: string, replyContext?: ReplyContext): Promise<void> {
  const ticket = getTicket(issueId);
  const ctx = await fetchIssueContext(issueId);

  const userPrompt = `# Ticket ${ctx.identifier}: ${ctx.title}

## Description
${ctx.description || '(no description)'}

## Comment thread
${ctx.comments || '(no comments yet)'}

Based on the above, draft (or revise) your plan.`;

  const args = [
    '-p', userPrompt,
    '--output-format', 'json',
    '--model', config.PLANNER_MODEL,
    '--allowedTools', 'Read',
    '--append-system-prompt', SYSTEM_PROMPT,
  ];

  if (ticket?.session_id) {
    args.push('--resume', ticket.session_id);
  }

  const planningPath = path.join(config.WORKTREE_ROOT, `planning-${ctx.identifier}`);
  console.log(`[orchestrator] preparing planning worktree at ${planningPath}`);
  await preparePlanningWorktree(planningPath);

  console.log(`[orchestrator] running for ${ctx.identifier} (resume=${ticket?.session_id ?? 'none'})`);
  let result: ClaudeResult;
  try {
    result = await runClaude(args, planningPath);
  } catch (err) {
    // Sessions are scoped to cwd. If we're resuming a session that was created
    // in a different cwd (e.g. before the planning-worktree change), claude
    // can't find it. Retry without --resume — the ticket loses planner context
    // once, then resumes cleanly from iteration 2 onward.
    if (/No conversation found/i.test((err as Error).message) && ticket?.session_id) {
      console.warn(`[orchestrator] session ${ticket.session_id} not found in ${planningPath}, retrying without --resume`);
      const fresh = stripResumeArg(args);
      result = await runClaude(fresh, planningPath);
    } else {
      throw err;
    }
  }

  if (result.is_error || !result.result) {
    throw new Error(`orchestrator run failed: ${JSON.stringify(result)}`);
  }

  upsertTicket(issueId, 'planning');

  const { mode, body, changeSummary } = parsePlannerOutput(result.result);
  // First iteration: there's no plan comment yet, so REPLY makes no sense — always REVISE.
  const effectiveMode = ticket?.plan_comment_id ? mode : 'revise';

  if (effectiveMode === 'revise') {
    saveSession(issueId, result.session_id, body);
    if (ticket?.plan_comment_id) {
      await updateComment(ticket.plan_comment_id, body);
      if (changeSummary) {
        // Thread the change summary under the user's comment that triggered the revision.
        await postComment(issueId, changeSummary, replyContext?.replyParentId);
      }
      console.log(`[orchestrator] updated plan comment for ${ctx.identifier} (cost=$${result.total_cost_usd ?? '?'})`);
    } else {
      // Initial plan stays at top-level — it's the most visible artifact on the ticket.
      const commentId = await postComment(issueId, body);
      if (commentId) {
        savePlanCommentId(issueId, commentId);
      } else {
        console.warn(`[orchestrator] posted plan but did not get a comment id back — future iterations will create a duplicate`);
      }
      console.log(`[orchestrator] posted initial plan to ${ctx.identifier} (cost=$${result.total_cost_usd ?? '?'})`);
    }
  } else {
    // REPLY: leave last_plan and plan comment untouched. Just advance the session.
    saveSessionOnly(issueId, result.session_id);
    await postComment(issueId, body, replyContext?.replyParentId);
    console.log(`[orchestrator] posted reply to ${ctx.identifier} (cost=$${result.total_cost_usd ?? '?'})`);
  }
}

type Mode = 'revise' | 'reply';

function parsePlannerOutput(text: string): { mode: Mode; body: string; changeSummary?: string } {
  const reviseMatch = /<!--\s*MODE:\s*REVISE\s*-->/i.exec(text);
  const replyMatch = /<!--\s*MODE:\s*REPLY\s*-->/i.exec(text);
  let mode: Mode = 'revise';
  if (replyMatch && (!reviseMatch || replyMatch.index > reviseMatch.index)) {
    mode = 'reply';
  }

  const summaryMatch = /<!--\s*CHANGE_SUMMARY:\s*([\s\S]+?)\s*-->/i.exec(text);
  const changeSummary = summaryMatch?.[1].trim();

  // Strip all our control markers from the body before posting.
  const body = text
    .replace(/\s*<!--\s*MODE:\s*(REVISE|REPLY)\s*-->\s*/gi, '')
    .replace(/\s*<!--\s*CHANGE_SUMMARY:[\s\S]+?-->\s*/gi, '')
    .trimEnd();

  return { mode, body, changeSummary };
}

async function preparePlanningWorktree(planningPath: string): Promise<void> {
  await mkdir(config.WORKTREE_ROOT, { recursive: true });
  await runGit(['fetch', '--prune', 'origin']);
  if (await pathExists(planningPath)) {
    // Reuse the existing worktree so claude session resumption (which is
    // keyed on cwd) keeps working across plan iterations. Sync to latest
    // origin/<base> via reset+clean.
    await runGit(['reset', '--hard', `origin/${config.BASE_BRANCH}`], planningPath);
    await runGit(['clean', '-fdx'], planningPath);
    return;
  }
  // Detached HEAD — no branch is created, so this never conflicts with whatever
  // the user has checked out at REPO_PATH (including BASE_BRANCH itself).
  await runGit(['worktree', 'add', '--detach', planningPath, `origin/${config.BASE_BRANCH}`]);
}

function stripResumeArg(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume') {
      i++; // also skip the session id that follows
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

function runClaude(args: string[], cwd: string): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd,
      env: {
        ...process.env,
        CLAUDE_CODE_OAUTH_TOKEN: config.CLAUDE_CODE_OAUTH_TOKEN,
      },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
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

    child.on('error', reject);
  });
}
