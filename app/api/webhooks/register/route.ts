import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getClientConfig, setSessionOverride } from '@/lib/config';
import { registerSmartleadWebhook } from '@/lib/sources/smartlead-api';
import { logger } from '@/lib/log';

/**
 * Register the 7 approved webhook events for a client's entire Smartlead
 * account — one webhook, not one per campaign. Rewritten 27 Aug 2026:
 * the previous version registered once per campaign and had no dedup, so
 * repeated "Review and build" clicks piled up duplicates (one real client
 * accumulated 40+ identical webhooks). Smartlead's account-level
 * registration (`association_type: 1`) makes the whole per-campaign loop
 * unnecessary — confirmed live it still supports every event this app
 * needs, including LEAD_CATEGORY_UPDATED. See lib/sources/smartlead-api.ts
 * for the full story.
 *
 * Idempotent: if this client already has a tracked smartleadWebhookId,
 * this is a no-op rather than creating another one — the webhook already
 * covers every campaign, present and future, so there's nothing to redo.
 *
 * Also generates and persists a per-client webhook secret (embedded in the
 * registered URL as ?secret=...) if the client doesn't already have one —
 * see app/api/webhooks/smartlead/route.ts, which rejects any call that
 * doesn't present it. Smartlead doesn't document a request-signing scheme
 * to verify against, so this is the shared-secret alternative.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { clientId?: string };
  if (!body.clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }

  const cfg = await getClientConfig(body.clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${body.clientId}` }, {
      status: 404,
    });
  }

  if (cfg.source.smartleadWebhookId) {
    return NextResponse.json({
      ok: true,
      message: `Already registered (webhook ${cfg.source.smartleadWebhookId}) — covers every campaign in this account, nothing to redo.`,
      webhookId: cfg.source.smartleadWebhookId,
    });
  }

  const webhookSecret = cfg.source.webhookSecret ?? randomBytes(24).toString('hex');
  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const targetUrl =
    `${baseUrl}/api/webhooks/smartlead?clientId=${encodeURIComponent(cfg.clientId)}` +
    `&secret=${encodeURIComponent(webhookSecret)}`;

  const result = await registerSmartleadWebhook(cfg.source.apiKey, targetUrl);

  if (!result.ok) {
    logger.warn('smartlead account-level webhook registration failed', { clientId: cfg.clientId, result });
    return NextResponse.json({ ok: false, targetUrl, message: result.message });
  }

  await setSessionOverride({
    ...cfg,
    source: { ...cfg.source, webhookSecret, smartleadWebhookId: result.webhookId },
  });

  return NextResponse.json({ ok: true, targetUrl, webhookId: result.webhookId, message: result.message });
}
