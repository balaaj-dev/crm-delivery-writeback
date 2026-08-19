import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { ADAPTER_REGISTRY } from '@/lib/adapters/index';
import type { CrmType } from '@/lib/types';
import { CRM_TYPES } from '@/lib/types';
import { logger } from '@/lib/log';

/** Wizard step 6 — credential check before allowing "next". */
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
    return NextResponse.json({ error: `No client config found for id ${body.clientId}` }, {
      status: 404,
    });
  }

  const cfg = {
    ...baseCfg,
    crm: {
      type,
      integrationPath: type === 'salesforce' ? ('outboundsync' as const) : ('native' as const),
      credentials: body.credentials ?? baseCfg.crm.credentials,
    },
  };

  try {
    const adapter = ADAPTER_REGISTRY[type]();
    const result = await adapter.testConnection(cfg);
    return NextResponse.json(result);
  } catch (err) {
    logger.error('CRM testConnection failed', { type, error: err instanceof Error ? err.message : err });
    return NextResponse.json(
      { ok: false, message: err instanceof Error ? err.message : 'Unknown error' },
      { status: 200 },
    );
  }
}
