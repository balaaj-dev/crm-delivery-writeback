import { NextResponse } from 'next/server';
import { randomBytes } from 'node:crypto';
import { getClientConfig, setSessionOverride } from '@/lib/config';
import { registerSmartleadWebhook, listCampaigns } from '@/lib/sources/smartlead-api';
import { logger } from '@/lib/log';

/**
 * Register the 7 approved webhook events for every in-scope campaign.
 *
 * Fixed 26 Aug 2026 (Jairo's feedback made this a real gap, not a
 * theoretical one): the "sync only PRs" / "sync all contacts" sync-scope
 * options deliberately leave source.campaignIds empty — that's the whole
 * point of the new "everything" option skipping campaign selection. This
 * used to hard-refuse registration whenever campaignIds was empty; it now
 * falls back to every campaign currently in the client's Smartlead account.
 *
 * Also now generates and persists a per-client webhook secret (embedded in
 * the registered URL as ?secret=...) if the client doesn't already have
 * one — see app/api/webhooks/smartlead/route.ts, which rejects any call
 * that doesn't present it. Smartlead doesn't document a request-signing
 * scheme to verify against, so this is the shared-secret alternative.
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

  const webhookSecret = cfg.source.webhookSecret ?? randomBytes(24).toString('hex');
  if (!cfg.source.webhookSecret) {
    await setSessionOverride({ ...cfg, source: { ...cfg.source, webhookSecret } });
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000';
  const targetUrl =
    `${baseUrl}/api/webhooks/smartlead?clientId=${encodeURIComponent(cfg.clientId)}` +
    `&secret=${encodeURIComponent(webhookSecret)}`;

  let campaignIds = cfg.source.campaignIds ?? [];
  if (campaignIds.length === 0) {
    try {
      const campaigns = await listCampaigns(cfg.source.apiKey);
      campaignIds = campaigns.map((c) => c.id);
    } catch (err) {
      return NextResponse.json({
        ok: false,
        message: `No campaigns selected and couldn't list the account's campaigns to fall back to: ${err instanceof Error ? err.message : err}`,
      });
    }
    if (campaignIds.length === 0) {
      return NextResponse.json({
        ok: false,
        message: "This client's Smartlead account has no campaigns to register webhooks against yet.",
      });
    }
  }

  const results = await Promise.all(
    campaignIds.map((campaignId) => registerSmartleadWebhook(cfg.source.apiKey, campaignId, targetUrl)),
  );

  const allOk = results.every((r) => r.ok);
  if (!allOk) {
    logger.warn('smartlead webhook registration had failures', { clientId: cfg.clientId, results });
  }

  return NextResponse.json({ ok: allOk, targetUrl, campaignCount: campaignIds.length, results });
}
