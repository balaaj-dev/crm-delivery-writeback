import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getClientConfig } from '@/lib/config';
import { smartleadWebhookPayloadSchema, mapSmartleadEventToCanonical } from '@/lib/sources/smartlead';
import { dispatchEvent } from '@/lib/dispatch';
import { getAdapterForClient } from '@/lib/adapters/index';
import { logger } from '@/lib/log';

const DEFAULT_FIXTURE = 'lead-category-updated-interested.json';

/**
 * Wizard step 10 ("review and build") fires one synthetic event end-to-end
 * so the CSM can see a real log entry land before calling the client done.
 * Reuses the same fixtures Milestone 2's tests run against — never
 * fabricates a bespoke payload shape that would drift from what's tested.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { clientId?: string; fixture?: string };
  if (!body.clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }

  const cfg = await getClientConfig(body.clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${body.clientId}` }, {
      status: 404,
    });
  }

  try {
    const fixtureName = body.fixture ?? DEFAULT_FIXTURE;
    const fixturePath = path.join(process.cwd(), 'fixtures', 'smartlead-events', fixtureName);
    const raw = JSON.parse(await readFile(fixturePath, 'utf8'));
    const payload = smartleadWebhookPayloadSchema.parse(raw);

    const event = mapSmartleadEventToCanonical(payload, cfg.clientId);
    // Test events must never collide with a real event's idempotency key.
    event.eventId = `test:${event.eventId}:${Date.now()}`;

    const adapter = getAdapterForClient(cfg);
    const outcome = await dispatchEvent(event, cfg, adapter);
    return NextResponse.json({ event, outcome });
  } catch (err) {
    logger.error('synthetic test event failed', {
      clientId: body.clientId,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
