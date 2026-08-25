import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { listCampaigns } from '@/lib/sources/smartlead-api';
import { logger } from '@/lib/log';

/**
 * New wizard step — pick which Smartlead campaigns this client's writeback
 * covers. Fixes a real gap: neither the build brief's step list nor the
 * original implementation collected source.campaignIds anywhere, so webhook
 * registration (which requires it) had no way to succeed. See
 * docs/HANDOVER.md.
 */
export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'clientId query param is required' }, { status: 400 });
  }

  const cfg = await getClientConfig(clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${clientId}` }, { status: 404 });
  }

  try {
    const campaigns = await listCampaigns(cfg.source.apiKey);
    return NextResponse.json({ campaigns });
  } catch (err) {
    logger.warn('Smartlead campaigns fetch failed', {
      clientId,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { campaigns: [], warning: err instanceof Error ? err.message : 'Could not fetch campaigns.' },
      { status: 200 },
    );
  }
}
