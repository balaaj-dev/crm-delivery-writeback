import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { ADAPTER_REGISTRY } from '@/lib/adapters/index';
import type { CrmType } from '@/lib/types';
import { CRM_TYPES } from '@/lib/types';
import { logger } from '@/lib/log';

/** Wizard step 7 — field-mapping step. Real CRM fields on the right, canonical fields on the left. */
export async function GET(req: Request, { params }: { params: { type: string } }) {
  const type = params.type as CrmType;
  if (!(CRM_TYPES as string[]).includes(type)) {
    return NextResponse.json({ error: `Unknown CRM type "${type}"` }, { status: 400 });
  }

  const url = new URL(req.url);
  const clientId = url.searchParams.get('clientId');
  const objectType = url.searchParams.get('objectType') ?? 'contact';
  if (!clientId) {
    return NextResponse.json({ error: 'clientId query param is required' }, { status: 400 });
  }

  const cfg = await getClientConfig(clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${clientId}` }, { status: 404 });
  }

  try {
    const adapter = ADAPTER_REGISTRY[type]();
    const fields = await adapter.describeFields(cfg, objectType);
    return NextResponse.json({ fields });
  } catch (err) {
    logger.error('CRM describeFields failed', { type, error: err instanceof Error ? err.message : err });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
