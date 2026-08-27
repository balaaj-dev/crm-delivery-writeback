import { NextResponse } from 'next/server';
import { getClientConfig } from '@/lib/config';
import { getAdapterForClient } from '@/lib/adapters/index';
import { getJob, processJobPage } from '@/lib/jobs';
import { verifyQstashSignature, publishJobChunk } from '@/lib/qstash';
import { logger } from '@/lib/log';

/**
 * POST /api/delivery/jobs/:id/process — QStash-triggered, processes exactly
 * one page of a delivery job, then re-publishes itself to QStash if more
 * work remains. This is the piece that makes bulk delivery actually finish
 * on Vercel — see lib/qstash.ts's header for the full story: a job record
 * can now persist correctly (lib/kv.ts), but nothing was left running to
 * drive it forward once Vercel froze the function instance that started it.
 *
 * Deliberately excluded from middleware.ts's Basic Auth gate (QStash can't
 * present that) — security here is the cryptographic signature check below
 * instead. Reject anything that doesn't verify, same fail-closed pattern as
 * the Smartlead webhook route's shared-secret check.
 */

// Generous headroom for a 20-lead page, each lead costing several real
// network calls (find/create contact, status update, message-history
// fetch + writes, deal creation). Requires a Vercel plan that allows this
// (Pro does); lower it if the account can't support 60s.
export const maxDuration = 60;

export async function POST(req: Request, { params }: { params: { id: string } }) {
  const rawBody = await req.text();
  const signature = req.headers.get('upstash-signature');
  const verified = await verifyQstashSignature(signature, rawBody);
  if (!verified) {
    logger.warn('delivery job process: rejected request with missing/invalid QStash signature', {
      jobId: params.id,
    });
    return NextResponse.json({ error: 'Invalid or missing QStash signature' }, { status: 401 });
  }

  const job = await getJob(params.id);
  if (!job) {
    // Not an error worth retrying — the job is gone, nothing to do.
    return NextResponse.json({ ok: true, note: `No job found for id ${params.id}, nothing to process` });
  }

  const cfg = await getClientConfig(job.clientId);
  if (!cfg) {
    logger.error('delivery job process: client config missing mid-job', {
      jobId: params.id,
      clientId: job.clientId,
    });
    return NextResponse.json({ error: `No client config found for id ${job.clientId}` }, { status: 404 });
  }

  try {
    const adapter = getAdapterForClient(cfg);
    const hasMore = await processJobPage(params.id, cfg, adapter);

    if (hasMore) {
      const baseUrl = process.env.PUBLIC_BASE_URL;
      if (!baseUrl) {
        logger.error('delivery job process: PUBLIC_BASE_URL not set, cannot re-publish next chunk', {
          jobId: params.id,
        });
      } else {
        await publishJobChunk(`${baseUrl}/api/delivery/jobs/${params.id}/process`, {});
      }
    }

    return NextResponse.json({ ok: true, hasMore });
  } catch (err) {
    logger.error('delivery job process: page failed outside its own error handling', {
      jobId: params.id,
      error: err instanceof Error ? err.message : err,
    });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
