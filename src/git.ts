import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { config } from './config.js';

export function runGit(args: string[], cwd: string = config.REPO_PATH): Promise<void> {
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

export async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
