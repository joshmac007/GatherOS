// Local GatherLocal builds do not proxy OpenAI Platform API calls.
// Desktop AI runs through Codex subscription auth or on-device local models.

import { Hono } from 'hono';
import type { Env } from './types';

export const aiRoutes = new Hono<{ Bindings: Env }>();

function disabled() {
  return {
    ok: false,
    error: 'ai_proxy_disabled',
    detail:
      'GatherLocal AI is local-only. Use GATHERLOCAL_AI_PROVIDER=codex or GATHERLOCAL_AI_PROVIDER=local in the desktop app.',
  };
}

aiRoutes.post('/chat', (c) => c.json(disabled(), 410));
aiRoutes.post('/embed', (c) => c.json(disabled(), 410));
aiRoutes.post('/image', (c) => c.json(disabled(), 410));
aiRoutes.get('/usage', (c) =>
  c.json({
    ok: true,
    metered: false,
    provider: 'desktop-local',
    total_tokens: 0,
    request_count: 0,
    image_count: 0,
  }),
);
