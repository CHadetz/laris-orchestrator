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
  })
  .transform((c) => ({
    ...c,
    WORKTREE_ROOT:
      c.WORKTREE_ROOT ?? path.resolve(c.REPO_PATH, '..', '.laris-worktrees'),
  }));

export const config = schema.parse(process.env);
