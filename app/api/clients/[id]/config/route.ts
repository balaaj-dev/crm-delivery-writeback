import { NextResponse } from 'next/server';
import { getClientConfig, configSource } from '@/lib/config';
import { writeClientConfigToAirtable } from '@/lib/airtable';
import { clientConfigSchema } from '@/lib/schemas';
import type { ClientConfig } from '@/lib/types';
import { logger } from '@/lib/log';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const config = await getClientConfig(params.id);
    if (!config) {
      return NextResponse.json({ error: `No client config found for id ${params.id}` }, {
        status: 404,
      });
    }
    return NextResponse.json({ config });
  } catch (err) {
    logger.error('GET /api/clients/[id]/config failed', {
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}

/**
 * Wizard step 10 ("review and build") writes the resolved config back here.
 * In fixtures mode this is a demo no-op (fixtures are static files, not a
 * writable store) — it logs what would have been written. In airtable mode
 * it attempts a real write, which currently always fails with a clear error
 * because the §5.2 fields do not exist on the live base yet.
 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  try {
    const body = await req.json();
    const config = clientConfigSchema.parse({ ...body, clientId: params.id }) as ClientConfig;

    if (configSource() === 'airtable') {
      await writeClientConfigToAirtable(config);
    } else {
      logger.info('fixtures mode: would write client config to Airtable', {
        clientId: params.id,
      });
    }

    return NextResponse.json({ ok: true, config });
  } catch (err) {
    logger.error('PUT /api/clients/[id]/config failed', {
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 400 },
    );
  }
}
