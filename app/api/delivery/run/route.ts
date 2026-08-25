import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { getAdapterForClient } from '@/lib/adapters/index';
import { deliverCampaignLeads } from '@/lib/delivery';
import { logger } from '@/lib/log';

/**
 * The "delivery" half of S1 — bulk-creates CRM records from a client's
 * existing Smartlead leads. See lib/delivery.ts for the full context on
 * why this exists as a separate path from writeback's event-driven dispatch.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    campaignId?: string;
    maxLeads?: number;
  };
  if (!body.clientId || !body.campaignId) {
    return NextResponse.json({ error: 'clientId and campaignId are required' }, { status: 400 });
  }

  const cfg = await getClientConfig(body.clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${body.clientId}` }, {
      status: 404,
    });
  }

  try {
    const adapter = getAdapterForClient(cfg);
    const result = await deliverCampaignLeads(cfg, adapter, body.campaignId, body.maxLeads ?? 25);
    return NextResponse.json({ result });
  } catch (err) {
    logger.error('delivery run failed', {
      clientId: body.clientId,
      campaignId: body.campaignId,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
