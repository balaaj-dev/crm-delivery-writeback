import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { smartleadWebhookPayloadSchema, mapSmartleadEventToCanonical } from '@/lib/sources/smartlead';
import { dispatchEvent } from '@/lib/dispatch';
import { getAdapterForClient } from '@/lib/adapters/index';
import { logger, recordRawWebhookPayload } from '@/lib/log';

/**
 * Ingestion endpoint for the 7 approved Smartlead webhook events (brief §6).
 *
 * clientId is passed as a query param, set at webhook-registration time
 * (POST /api/webhooks/register) — Smartlead itself has no concept of
 * "Cymate client ID", so each registered webhook URL is scoped to one
 * client: /api/webhooks/smartlead?clientId=<Airtable record id>&secret=...
 *
 * Security check added 26 Aug 2026 (Jairo's feedback: this endpoint had
 * none). Smartlead doesn't document a request-signing scheme to verify
 * against — SMARTLEAD_WEBHOOK_SECRET was an unused env var placeholder for
 * exactly that reason — so this uses a shared secret instead: a random
 * value generated per client at registration time, embedded in the URL we
 * hand to Smartlead, and required on every call here. A client with no
 * secret configured yet (registration never run) rejects everything —
 * fail closed, not open, consistent with this app's other safety defaults.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'Missing required ?clientId= query param' }, { status: 400 });
  }

  const cfg = await getClientConfig(clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${clientId}` }, { status: 404 });
  }

  const presentedSecret = url.searchParams.get('secret');
  if (!cfg.source.webhookSecret || presentedSecret !== cfg.source.webhookSecret) {
    logger.warn('smartlead webhook: rejected call with missing/invalid secret', { clientId });
    return NextResponse.json({ error: 'Missing or invalid webhook secret' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }

  const parsed = smartleadWebhookPayloadSchema.safeParse(body);

  // Captured regardless of validation outcome, but only once the secret
  // check above has passed — this is the exact raw shape Smartlead sent,
  // kept so a schema mismatch can actually be diagnosed. See
  // lib/log.ts's recordRawWebhookPayload for why this exists.
  await recordRawWebhookPayload({
    timestamp: new Date().toISOString(),
    clientId,
    valid: parsed.success,
    validationIssues: parsed.success ? undefined : parsed.error.issues,
    body,
  });

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
