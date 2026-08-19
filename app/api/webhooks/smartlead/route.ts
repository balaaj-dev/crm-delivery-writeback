import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { smartleadWebhookPayloadSchema, mapSmartleadEventToCanonical } from '@/lib/sources/smartlead';
import { dispatchEvent } from '@/lib/dispatch';
import { getAdapterForClient } from '@/lib/adapters/index';
import { logger } from '@/lib/log';

/**
 * Ingestion endpoint for the 7 approved Smartlead webhook events (brief §6).
 *
 * clientId is passed as a query param, set at webhook-registration time
 * (wizard step 10 / POST /api/webhooks/register) — Smartlead itself has no
 * concept of "Cymate client ID", so each registered webhook URL is scoped
 * to one client: /api/webhooks/smartlead?clientId=<Airtable record id>.
 *
 * [VERIFY] Smartlead webhook signature verification. SMARTLEAD_WEBHOOK_SECRET
 * exists as an env var placeholder (see .env.example) but is not checked
 * here — brief §16 flags this as unconfirmed ("[VERIFY] whether Smartlead
 * provides one"). Do not treat this endpoint as verified against payload
 * spoofing until that's resolved — see docs/HANDOVER.md.
 */
export async function POST(req: Request) {
  const clientId = new URL(req.url).searchParams.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'Missing required ?clientId= query param' }, { status: 400 });
  }

  const cfg = await getClientConfig(clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${clientId}` }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const parsed = smartleadWebhookPayloadSchema.safeParse(body);
  if (!parsed.success) {
    logger.warn('smartlead webhook: payload failed validation', {
      clientId,
      issues: parsed.error.issues,
    });
    return NextResponse.json(
      { error: 'Payload failed validation', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const event = mapSmartleadEventToCanonical(parsed.data, clientId);
    const adapter = getAdapterForClient(cfg);
    const outcome = await dispatchEvent(event, cfg, adapter);
    return NextResponse.json({ event, outcome });
  } catch (err) {
    logger.error('smartlead webhook: processing failed', {
      clientId,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
