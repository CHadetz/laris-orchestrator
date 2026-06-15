import express from 'express';
import { config } from './config.js';
import { handleGithubWebhook, verifyGithubSignature } from './github-webhooks.js';
import { getBotUserId } from './linear.js';
import { reconcileOrphanedExecutors } from './recovery.js';
import { handleWebhook, verifyLinearSignature } from './webhooks.js';

const app = express();

// Capture raw body on webhook routes so we can HMAC-verify each, then parse JSON.
const rawBodyJsonMiddleware = [
  express.raw({ type: 'application/json', limit: '5mb' }),
  (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const buf = req.body as Buffer;
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
    try {
      req.body = JSON.parse(buf.toString('utf8'));
    } catch {
      // signature verification will fail and reject
    }
    next();
  },
];

app.use('/webhooks/linear', rawBodyJsonMiddleware);
app.use('/webhooks/github', rawBodyJsonMiddleware);

app.get('/health', (_req, res) => {
  res.send('ok');
});

app.post('/webhooks/linear', verifyLinearSignature, handleWebhook);
app.post('/webhooks/github', verifyGithubSignature, handleGithubWebhook);

app.listen(config.PORT, async () => {
  console.log(`laris-orchestrator listening on :${config.PORT}`);
  try {
    const botId = await getBotUserId();
    console.log(`linear bot user id: ${botId}`);
  } catch (err) {
    console.error('failed to fetch bot user from Linear:', err);
  }
  try {
    await reconcileOrphanedExecutors();
  } catch (err) {
    console.error('startup reconciliation failed:', err);
  }
});
