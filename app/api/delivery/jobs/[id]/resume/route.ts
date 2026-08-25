import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { getAdapterForClient } from '@/lib/adapters/index';
import { getJob, resumeDeliveryJob } from '@/lib/jobs';
import { logger } from '@/lib/log';

/**
 * POST /api/delivery/jobs/:id/resume — restarts processing for a job stuck
 * in 'queued'/'running' from its saved offset (e.g. after the server
 * process that was running it restarted). No-ops for a completed/failed job.
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const job = await getJob(params.id);
  if (!job) {
    return NextResponse.json({ error: `No job found for id ${params.id}` }, { status: 404 });
  }

  const cfg = await getClientConfig(job.clientId);
  if (!cfg) {
    return NextResponse.json({ error: `No client config found for id ${job.clientId}` }, { status: 404 });
  }

  try {
    const adapter = getAdapterForClient(cfg);
    const resumed = await resumeDeliveryJob(params.id, cfg, adapter);
    return NextResponse.json({ job: resumed });
  } catch (err) {
    logger.error('resuming delivery job failed', {
      jobId: params.id,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
