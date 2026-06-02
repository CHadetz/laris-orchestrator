import { config } from './config.js';

let cachedBotLogin: string | null | undefined;

export async function getBotGithubLogin(): Promise<string | null> {
  if (cachedBotLogin !== undefined) return cachedBotLogin;
  if (config.GITHUB_BOT_LOGIN) {
    cachedBotLogin = config.GITHUB_BOT_LOGIN;
    return cachedBotLogin;
  }
  if (!config.GITHUB_TOKEN) {
    cachedBotLogin = null;
    return null;
  }
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${config.GITHUB_TOKEN}`,
        'User-Agent': 'laris-orchestrator',
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) {
      console.warn(`[github] /user returned ${res.status}; can't auto-detect bot login`);
      cachedBotLogin = null;
      return null;
    }
    const data = (await res.json()) as { login: string };
    cachedBotLogin = data.login;
    console.log(`[github] detected bot login: ${cachedBotLogin}`);
    return cachedBotLogin;
  } catch (err) {
    console.warn(`[github] failed to auto-detect bot login: ${(err as Error).message}`);
    cachedBotLogin = null;
    return null;
  }
}
