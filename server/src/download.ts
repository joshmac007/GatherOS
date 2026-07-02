// GatherLocal does not have a confirmed public release repository yet.
// Keep /download explicit instead of redirecting users to upstream GatherOS.

import type { Context } from 'hono';
import type { Env } from './types';

export async function downloadHandler(c: Context<{ Bindings: Env }>) {
  return c.json(
    {
      ok: false,
      error: 'download_disabled',
      detail: 'GatherLocal public downloads are disabled until a release target is configured.',
    },
    410,
  );
}
