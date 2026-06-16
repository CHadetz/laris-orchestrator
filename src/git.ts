import { spawn } from 'node:child_process';
import { access, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const STALE_LOCK_MS = 5_000;

// Worktrees share the primary repo's .git/config — so two concurrent
// `git worktree add` calls on the same repo (e.g. parallel children dispatched
// by B2 split) race for `.git/config.lock` and one fails. Serialize every
// git invocation against this process-wide chain so our own dispatches never
// contend. Cheap: git commands are fast and we don't run many.
let gitChain: Promise<unknown> = Promise.resolve();

export function runGit(args: string[], cwd: string = config.REPO_PATH): Promise<void> {
  const next = gitChain.then(() => runGitWithRetry(args, cwd));
  // Failure of one git call must not block the next caller. Swallow in the
  // chain; the actual rejection still surfaces to the awaiter via `next`.
  gitChain = next.catch(() => undefined);
  return next;
}

async function runGitWithRetry(args: string[], cwd: string): Promise<void> {
  try {
    await runGitOnce(args, cwd);
  } catch (err) {
    const msg = (err as Error).message;
    // Some other process (the user's own git command in the repo, or a prior
    // crashed git op) may have left a stale `.git/config.lock`. If it's older
    // than the stale threshold, remove it and retry once. Younger locks are
    // owned by a live operation — don't touch them.
    if (!/could not lock config file|cannot lock ref/i.test(msg)) throw err;
    const cleared = await tryClearStaleLock();
    if (!cleared) throw err;
    await new Promise((r) => setTimeout(r, 100));
    await runGitOnce(args, cwd);
  }
}

function runGitOnce(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr}`));
    });
    child.on('error', reject);
  });
}

async function tryClearStaleLock(): Promise<boolean> {
  const lockPath = path.join(config.REPO_PATH, '.git', 'config.lock');
  try {
    const s = await stat(lockPath);
    const ageMs = Date.now() - s.mtimeMs;
    if (ageMs < STALE_LOCK_MS) {
      console.warn(`[git] ${lockPath} exists but is fresh (${ageMs}ms) — assuming live writer, not clearing`);
      return false;
    }
    await unlink(lockPath);
    console.warn(`[git] removed stale lock ${lockPath} (age ${Math.round(ageMs / 1000)}s)`);
    return true;
  } catch {
    // Lock no longer there, or unlink failed — nothing actionable.
    return false;
  }
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
