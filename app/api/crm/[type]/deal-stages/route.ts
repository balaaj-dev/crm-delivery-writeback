import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { ADAPTER_REGISTRY } from '@/lib/adapters/index';
import type { CrmType } from '@/lib/types';
import { CRM_TYPES } from '@/lib/types';
import { logger } from '@/lib/log';

/**
 * Wizard step 9 — deal-stage picker. Real stage IDs are portal-specific
 * (confirmed live against HubSpot, see docs/HANDOVER.md), so this must be
 * fetched, never guessed. Not every CRM adapter implements listDealStages
 * (only ones with a deal/opportunity concept need to) — callers should fall
 * back to a plain text field when `stages` comes back empty.
 */
export async function GET(req: Request, { params }: { params: { type: string } }) {
  const type = params.type as CrmType;
  if (!(CRM_TYPES as string[]).includes(type)) {
    return NextResponse.json({ error: `Unknown CRM type "${type}"` }, { status: 400 });
  }

  const clientId = new URL(req.url).searchParams.get('clientId');
  if (!clientId) {
    return NextResponse.json({ error: 'clientId query param is required' }, { status: 400 });
  }

  const cfg = await getClientConfig(clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${clientId}` }, { status: 404 });
  }

  const adapter = ADAPTER_REGISTRY[type]();
  if (!adapter.listDealStages) {
    return NextResponse.json({ stages: [] });
  }

  try {
    const stages = await adapter.listDealStages(cfg);
    return NextResponse.json({ stages });
  } catch (err) {
    logger.warn('listDealStages failed — wizard should fall back to manual entry', {
      type,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json({
      stages: [],
      warning: err instanceof Error ? err.message : 'Could not fetch deal stages.',
    });
  }
}
