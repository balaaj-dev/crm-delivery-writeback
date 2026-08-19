import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { listLeadCategories } from '@/lib/sources/smartlead-api';
import { DEFAULT_STATUS_MAP } from '@/lib/types';
import { logger } from '@/lib/log';

/** Wizard step 8 — live categories to map, pre-filled with §7.5 default suggestions. */
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
    const categories = await listLeadCategories(cfg.source.apiKey);
    return NextResponse.json({ categories, defaultSuggestions: DEFAULT_STATUS_MAP });
  } catch (err) {
    logger.warn('Smartlead categories fetch failed — falling back to default suggestions only', {
      clientId,
      error: err instanceof Error ? err.message : err,
    });
    // Endpoint shape is [VERIFY] (see lib/sources/smartlead-api.ts) — fail
    // soft so the wizard can still show the default suggestions for the
    // CSM to hand-edit rather than blocking the whole flow.
    return NextResponse.json({
      categories: [],
      defaultSuggestions: DEFAULT_STATUS_MAP,
      warning:
        'Could not fetch live categories from Smartlead (endpoint unverified — see docs/HANDOVER.md). Showing default suggestions only.',
    });
  }
}
