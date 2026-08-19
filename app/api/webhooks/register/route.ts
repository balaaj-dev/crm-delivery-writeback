import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { registerSmartleadWebhook } from '@/lib/sources/smartlead-api';
import { logger } from '@/lib/log';

/** Wizard step 10 — register the 7 approved webhook events for every in-scope campaign. */
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

  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const targetUrl = `${baseUrl}/api/webhooks/smartlead?clientId=${encodeURIComponent(cfg.clientId)}`;

  const campaignIds = cfg.source.campaignIds ?? [];
  if (campaignIds.length === 0) {
    return NextResponse.json({
      ok: false,
      message:
        'No campaignIds configured for this client — cfg.source.campaignIds is empty. In this ' +
        'skeleton, an empty list means "all campaigns" for dispatch purposes, but webhook ' +
        'registration is Smartlead-campaign-scoped and needs explicit campaign IDs. Set them in ' +
        'the client config before registering webhooks.',
    });
  }

  const results = await Promise.all(
    campaignIds.map((campaignId) => registerSmartleadWebhook(cfg.source.apiKey, campaignId, targetUrl)),
  );

  const allOk = results.every((r) => r.ok);
  if (!allOk) {
    logger.warn('smartlead webhook registration had failures', { clientId: cfg.clientId, results });
  }

  return NextResponse.json({ ok: allOk, targetUrl, results });
}
