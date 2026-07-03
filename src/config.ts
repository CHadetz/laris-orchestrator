import 'dotenv/config';
import path from 'node:path';
import { z } from 'zod';

const schema = z
  .object({
    CLAUDE_CODE_OAUTH_TOKEN: z.string().min(1),
    LINEAR_API_KEY: z.string().min(1),
    LINEAR_WEBHOOK_SECRET: z.string().min(1),
    GITHUB_TOKEN: z.string().optional(),
    GITHUB_WEBHOOK_SECRET: z.string().optional(),
    GITHUB_BOT_LOGIN: z.string().optional(),
    APPROVAL_LABEL: z.string().default('agent:approved'),
    PORT: z.coerce.number().default(4000),
    DB_PATH: z.string().default('./data/orchestrator.db'),
    REPO_PATH: z.string().min(1),
    BASE_BRANCH: z.string().default('main'),
    WORKTREE_ROOT: z.string().optional(),
    EXECUTION_TIMEOUT_MS: z.coerce.number().default(60 * 60 * 1000),
    VERIFICATION_COMMAND: z.string().optional(),
    VERIFICATION_TIMEOUT_MS: z.coerce.number().default(10 * 60 * 1000),
    VERIFICATION_MAX_RETRIES: z.coerce.number().default(2),
    PLANNER_MODEL: z.string().default('opus'),
    // Cumulative spend cap per Linear ticket across all planner / executor /
    // verification-fix / follow-up runs. 0 = no cap.
    MAX_COST_USD_PER_TICKET: z.coerce.number().default(0),
    // Linear workflow state names. Case-insensitive; resolved per team. If the
    // state doesn't exist on a given team's workflow, the transition is skipped
    // with a warning.
    IN_PROGRESS_STATE_NAME: z.string().default('In Progress'),
    IN_REVIEW_STATE_NAME: z.string().default('In Review'),
    // How to handle SUBTASK blocks emitted by the planner:
    // - "off" (default): ignore them. One executor runs the whole plan and
    //   produces one PR. Subtask block bodies are inlined into the plan the
    //   subagent sees, so the planner's phase-by-phase structure survives.
    // - "stacked": split into Linear sub-issues, each with its own executor
    //   and stacked PR (dependents target their prereq's branch). Parallel
    //   but produces N PRs to merge.
    SPLIT_STRATEGY: z.enum(['off', 'stacked']).default('off'),
  })
  .transform((c) => ({
    ...c,
    WORKTREE_ROOT:
      c.WORKTREE_ROOT ?? path.resolve(c.REPO_PATH, '..', '.laris-worktrees'),
  }));

export const config = schema.parse(process.env);
