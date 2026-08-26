import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { ADAPTER_REGISTRY } from '@/lib/adapters/index';
import type { CrmType } from '@/lib/types';
import { CRM_TYPES } from '@/lib/types';
import { logger } from '@/lib/log';

/**
 * Wizard step 7 — field-mapping step. Real CRM fields on the right,
 * canonical fields on the left.
 *
 * POST, not GET — fixed 26 Aug 2026: the previous GET version read
 * credentials from getClientConfig(clientId), which is whatever's already
 * durably saved (Airtable/fixtures/a prior session override), NOT the
 * credentials the CSM just typed and successfully tested in step 6. For a
 * client with no prior saved credentials (the normal case for first-time
 * setup) this silently failed or returned another client's stale fields.
 * Same fix pattern already used correctly by /api/crm/[type]/test.
 */
export async function POST(req: Request, { params }: { params: { type: string } }) {
  const type = params.type as CrmType;
  if (!(CRM_TYPES as string[]).includes(type)) {
    return NextResponse.json({ error: `Unknown CRM type "${type}"` }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    credentials?: Record<string, string>;
    objectType?: string;
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

  try {
    const adapter = ADAPTER_REGISTRY[type]();
    const fields = await adapter.describeFields(cfg, body.objectType ?? 'contact');
    return NextResponse.json({ fields });
  } catch (err) {
    logger.error('CRM describeFields failed', { type, error: err instanceof Error ? err.message : err });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
