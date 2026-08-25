import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { getAdapterForClient } from '@/lib/adapters/index';
import { startDeliveryJob, listJobs } from '@/lib/jobs';
import { logger } from '@/lib/log';

/** GET /api/delivery/jobs?clientId=... — list jobs (most recent first), for the wizard's progress view. */
export async function GET(req: Request) {
  const clientId = new URL(req.url).searchParams.get('clientId') ?? undefined;
  const jobs = await listJobs(clientId);
  return NextResponse.json({ jobs });
}

/** POST /api/delivery/jobs — starts a real background delivery job. Returns immediately with the job id. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    clientId?: string;
    campaignId?: string;
    targetLeads?: number;
  };
  if (!body.clientId || !body.campaignId) {
    return NextResponse.json({ error: 'clientId and campaignId are required' }, { status: 400 });
  }

  const cfg = await getClientConfig(body.clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${body.clientId}` }, { status: 404 });
  }

  try {
    const adapter = getAdapterForClient(cfg);
    const job = await startDeliveryJob(cfg, adapter, body.campaignId, body.targetLeads ?? 1000);
    return NextResponse.json({ job });
  } catch (err) {
    logger.error('starting delivery job failed', {
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
