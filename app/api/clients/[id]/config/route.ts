import { NextResponse } from 'next/server';
import { getClientConfig, configSource, setSessionOverride } from '@/lib/config';
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
 * Wizard step 11 ("review and build") writes the resolved config back here.
 *
 * Two separate concerns, handled separately on purpose:
 * 1. The in-memory session override (lib/config.ts) is applied unconditionally
 *    and immediately — this is what makes the wizard's own "fire a test event"
 *    step (and any real webhook dispatch for the rest of this process's life)
 *    actually reflect what was just configured, rather than silently running
 *    against stale fixture/Airtable data. See lib/config.ts for the full story.
 * 2. Durable persistence (Airtable) is attempted separately and reported via
 *    `persisted`/`persistWarning` rather than failing the whole request —
 *    in fixtures mode there is nothing durable to write to; in Airtable mode
 *    it currently always fails because the §5.2 fields don't exist yet
 *    (see docs/AIRTABLE-FIELDS.md). Either way, the session override already
 *    makes local testing correct, so a durable-write failure shouldn't block
 *    the CSM from continuing.
 */
export async function PUT(req: Request, { params }: { params: { id: string } }) {
  let config: ClientConfig;
  try {
    const body = await req.json();
    config = clientConfigSchema.parse({ ...body, clientId: params.id }) as ClientConfig;
  } catch (err) {
    logger.error('PUT /api/clients/[id]/config failed validation', {
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Invalid config' },
      { status: 400 },
    );
  }

  // Server-side owner guardrail (Jairo's 26 Aug 2026 feedback: "not just
  // defaulting to whoever's logged in"). The wizard already disables its
  // own "Next"/"Build" buttons without an owner picked, but a disabled
  // button is a UX nicety, not a real boundary — this is the actual
  // enforcement. Only applies once a config is `activated`, since that's
  // the same flag dispatch.ts's own "not_activated" check treats as "this
  // config is allowed to create real records" — an inactive/draft config
  // being saved without an owner yet is fine.
  if (config.activated && !config.behaviour.ownerId) {
    return NextResponse.json(
      {
        error:
          'Refusing to activate this config without an owner set (behaviour.ownerId) — records ' +
          "would otherwise be created with no owner. Pick one in the wizard's field-mapping step.",
      },
      { status: 400 },
    );
  }

  await setSessionOverride(config);

  let persisted = false;
  let persistWarning: string | undefined;
  if (configSource() === 'airtable') {
    try {
      await writeClientConfigToAirtable(config);
      persisted = true;
    } catch (err) {
      persistWarning = err instanceof Error ? err.message : 'Airtable write failed';
      logger.warn('PUT /api/clients/[id]/config: Airtable persistence failed, session override still applied', {
        clientId: params.id,
        error: persistWarning,
      });
    }
  } else {
    persistWarning =
      'fixtures mode: nothing durable to write to — this config only lives in memory for the rest of this server process.';
    logger.info('fixtures mode: applied session override, no durable store to write to', {
      clientId: params.id,
    });
  }

  return NextResponse.json({ ok: true, config, persisted, persistWarning });
}
