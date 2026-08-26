import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { listCampaigns, sampleLeadCustomFieldKeys } from '@/lib/sources/smartlead-api';
import { logger } from '@/lib/log';

/**
 * Wizard step 7 — "browse other Smartlead fields" (added per Jairo's 26 Aug
 * 2026 feedback). Smartlead has no fields-schema endpoint, only real lead
 * records, so this samples one real lead from a campaign and returns
 * whatever custom-field keys it happens to have (e.g. Company_City,
 * Apollo_Industry) — these are per-workspace and not knowable in advance.
 *
 * `campaignId` is optional: if the client's already picked specific
 * campaigns (step 3), the first one is used; otherwise this falls back to
 * the account's first ACTIVE campaign so there's still something to sample
 * even when the sync scope is "all contacts" / "positive replies only"
 * (both of which leave source.campaignIds empty by design).
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const requestedCampaignId = url.searchParams.get('campaignId') ?? undefined;
  if (!clientId) {
    return NextResponse.json({ error: 'clientId query param is required' }, { status: 400 });
  }

  const cfg = await getClientConfig(clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${clientId}` }, { status: 404 });
  }

  try {
    let campaignId = requestedCampaignId ?? cfg.source.campaignIds?.[0];
    if (!campaignId) {
      const campaigns = await listCampaigns(cfg.source.apiKey);
      campaignId = campaigns.find((c) => c.status === 'ACTIVE')?.id ?? campaigns[0]?.id;
    }
    if (!campaignId) {
      return NextResponse.json({ fields: [], warning: 'No campaigns found to sample a lead from.' });
    }

    const fields = await sampleLeadCustomFieldKeys(cfg.source.apiKey, campaignId);
    return NextResponse.json({ fields, sampledCampaignId: campaignId });
  } catch (err) {
    logger.warn('Smartlead sample-fields fetch failed', {
      clientId,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json({
      fields: [],
      warning: err instanceof Error ? err.message : 'Could not sample a lead to discover fields.',
    });
  }
}
