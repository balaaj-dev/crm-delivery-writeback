import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { ADAPTER_REGISTRY } from '@/lib/adapters/index';
import type { CrmType } from '@/lib/types';
import { CRM_TYPES } from '@/lib/types';
import { logger } from '@/lib/log';

/**
 * Wizard step 7 — required owner picker (added per Jairo's 26 Aug 2026
 * feedback: owner assignment needs a real guardrail, not a default). Same
 * fresh-credentials POST pattern as fields/deal-stages — must use what the
 * CSM just tested, not whatever's already saved.
 */
export async function POST(req: Request, { params }: { params: { type: string } }) {
  const type = params.type as CrmType;
  if (!(CRM_TYPES as string[]).includes(type)) {
    return NextResponse.json({ error: `Unknown CRM type "${type}"` }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    credentials?: Record<string, string>;
  };
  if (!body.clientId) {
    return NextResponse.json({ error: 'clientId is required' }, { status: 400 });
  }

  const baseCfg = await getClientConfig(body.clientId);
  if (!baseCfg) {
    return NextResponse.json({ error: `No client config found for id ${body.clientId}` }, { status: 404 });
  }

  const cfg = {
    ...baseCfg,
    crm: {
      type,
      integrationPath: type === 'salesforce' ? ('outboundsync' as const) : ('native' as const),
      credentials: body.credentials ?? baseCfg.crm.credentials,
    },
  };

  const adapter = ADAPTER_REGISTRY[type]();
  if (!adapter.listOwners) {
    return NextResponse.json({ owners: [], warning: `${type} doesn't support owner lookup yet.` });
  }

  try {
    const owners = await adapter.listOwners(cfg);
    return NextResponse.json({ owners });
  } catch (err) {
    logger.warn('listOwners failed — wizard owner picker will show a warning and stay blocked', {
      type,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json({
      owners: [],
      warning: err instanceof Error ? err.message : 'Could not fetch owners.',
    });
  }
}
