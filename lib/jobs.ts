/**
 * Real background job system for delivery — built at Balaaj's explicit
 * request, overriding the original brief's "no durable job queue" decision
 * (§3) for this specific feature. A single HTTP request can't safely carry
 * a delivery run across a whole campaign (thousands of leads, each needing
 * several real network calls) — this decouples "start the work" from
 * "wait for the work", persists progress durably, and survives the
 * initiating request disconnecting.
 *
 * What this is, honestly: a job store backed by one JSON file per job
 * (data/jobs/<id>.json, gitignored — same durable-local-file pattern
 * already used for the event log and client-config overrides), plus an
 * in-process async runner that keeps working after the HTTP handler that
 * started it has already returned a response. This is genuinely correct
 * and resumable for any persistently-running Node process — `next dev`
 * locally, or `next start` on a normal always-on server. It is NOT
 * automatically correct on Vercel's default serverless functions
 * specifically: those are frozen/torn down shortly after a response is
 * sent, so a floating promise started inside a request handler is not
 * guaranteed to keep running. Deploying this piece to real serverless
 * needs one more real piece of infra to drive it forward — e.g. a Vercel
 * Cron job or a queue trigger (QStash, etc.) hitting a
 * "process the next chunk of this job" endpoint on an interval, rather
 * than relying on one long-lived in-memory loop. Documented here, not
 * silently assumed to work — see docs/HANDOVER.md.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ClientConfig, CrmAdapter } from './types';
import {
  listCampaignLeads,
  listLeadMessageHistory,
  resolveInterestCategoryIds,
  type SmartleadLead,
} from './sources/smartlead-api';
import { logger, recordEvent } from './log';
import { isDryRun } from './adapters/index';

const JOBS_DIR = path.join(process.cwd(), 'data', 'jobs');
const PAGE_SIZE = 100;

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'paused';

export interface DeliveryJob {
  id: string;
  clientId: string;
  clientName: string;
  campaignId: string;
  status: JobStatus;
  /** The requested ceiling for this job — can be far larger than any single request could safely process. */
  targetLeads: number;
  /** Resume cursor — how far into the campaign's lead list this job has gotten. */
  offset: number;
  totalLeadsInCampaign?: number;
  processed: number;
  created: number;
  alreadyExisted: number;
  activitiesLogged: number;
  /** Partial mode only — leads fetched but not delivered because their live Smartlead category isn't Interested/Meeting Booked. */
  skippedNotInterested: number;
  errors: Array<{ email: string; reason: string }>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  failureReason?: string;
}

function jobFilePath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

async function saveJob(job: DeliveryJob): Promise<void> {
  job.updatedAt = new Date().toISOString();
  await mkdir(JOBS_DIR, { recursive: true });
  await writeFile(jobFilePath(job.id), JSON.stringify(job, null, 2), 'utf8');
}

export async function getJob(id: string): Promise<DeliveryJob | null> {
  try {
    const raw = await readFile(jobFilePath(id), 'utf8');
    return JSON.parse(raw) as DeliveryJob;
  } catch {
    return null;
  }
}

export async function listJobs(clientId?: string): Promise<DeliveryJob[]> {
  try {
    const files = await readdir(JOBS_DIR);
    const jobs = await Promise.all(
      files.filter((f) => f.endsWith('.json')).map(async (f) => {
        const raw = await readFile(path.join(JOBS_DIR, f), 'utf8');
        return JSON.parse(raw) as DeliveryJob;
      }),
    );
    const filtered = clientId ? jobs.filter((j) => j.clientId === clientId) : jobs;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/** One job running per (clientId, campaignId) at a time — guards against starting a duplicate while one's in flight. */
export async function findActiveJob(clientId: string, campaignId: string): Promise<DeliveryJob | null> {
  const jobs = await listJobs(clientId);
  return (
    jobs.find(
      (j) => j.campaignId === campaignId && (j.status === 'queued' || j.status === 'running'),
    ) ?? null
  );
}

function deliveryStatusValue(lead: SmartleadLead): string | undefined {
  return lead.sequenceStatus ? `delivered_${lead.sequenceStatus.toLowerCase()}` : undefined;
}

function leadToSyntheticEvent(lead: SmartleadLead, clientId: string) {
  return {
    eventId: `delivery:${clientId}:${lead.email}`,
    occurredAt: new Date(0).toISOString(),
    type: 'email_sent' as const,
    clientId,
    source: 'smartlead' as const,
    campaign: { id: '', name: '' },
    prospect: {
      email: lead.email.trim().toLowerCase(),
      firstName: lead.firstName,
      lastName: lead.lastName,
      company: lead.company,
      domain: lead.domain,
      title: lead.title,
      phone: lead.phone,
      linkedinUrl: lead.linkedinUrl,
      custom: lead.customFields,
    },
    detail: {},
    raw: lead,
  };
}

function messageToSyntheticEvent(
  message: { type: string; subject: string; body: string; time: string },
  lead: SmartleadLead,
  clientId: string,
) {
  return {
    eventId: `delivery-activity:${clientId}:${lead.email}:${message.time}`,
    occurredAt: message.time,
    type: (message.type === 'REPLY' ? 'reply' : 'email_sent') as 'reply' | 'email_sent',
    clientId,
    source: 'smartlead' as const,
    campaign: { id: '', name: '' },
    prospect: { email: lead.email.trim().toLowerCase() },
    detail: { subject: message.subject, bodyPreview: message.body.slice(0, 2000) },
    raw: message,
  };
}

/** Creates a job record and starts it running in the background — returns immediately, does not await completion. */
export async function startDeliveryJob(
  cfg: ClientConfig,
  adapter: CrmAdapter,
  campaignId: string,
  targetLeads: number,
): Promise<DeliveryJob> {
  const existing = await findActiveJob(cfg.clientId, campaignId);
  if (existing) return existing;

  const job: DeliveryJob = {
    id: randomBytes(8).toString('hex'),
    clientId: cfg.clientId,
    clientName: cfg.clientName,
    campaignId,
    status: 'queued',
    targetLeads,
    offset: 0,
    processed: 0,
    created: 0,
    alreadyExisted: 0,
    activitiesLogged: 0,
    skippedNotInterested: 0,
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveJob(job);

  // Deliberately not awaited — see file header for exactly what this does
  // and does not guarantee depending on where it's deployed.
  runJob(job.id, cfg, adapter).catch((err) => {
    logger.error('delivery job crashed outside its own error handling', {
      jobId: job.id,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return job;
}

/** Resumes a job that's stuck in 'queued'/'running' (e.g. the process restarted mid-job) from its saved offset. */
export async function resumeDeliveryJob(id: string, cfg: ClientConfig, adapter: CrmAdapter): Promise<DeliveryJob | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'failed') return job;

  runJob(id, cfg, adapter).catch((err) => {
    logger.error('resumed delivery job crashed outside its own error handling', {
      jobId: id,
      error: err instanceof Error ? err.message : String(err),
    });
  });
  return job;
}

async function runJob(jobId: string, cfg: ClientConfig, adapter: CrmAdapter): Promise<void> {
  const job = await getJob(jobId);
  if (!job) return;

  job.status = 'running';
  await saveJob(job);
  const dryRun = isDryRun();

  // Same partial-mode interest filter as lib/delivery.ts — see that file's
  // comment for the real incident (25 Aug 2026) this fixes. Resolved once
  // per job rather than per lead.
  let interestCategoryIds: Set<number> | null = null;
  if (cfg.mode === 'partial') {
    try {
      interestCategoryIds = await resolveInterestCategoryIds(cfg.source.apiKey, cfg.statusMap);
    } catch (err) {
      job.status = 'failed';
      job.failureReason = `Partial-mode delivery needs Smartlead's lead categories to filter for Interested/Meeting Booked leads, and that lookup failed: ${err instanceof Error ? err.message : String(err)}`;
      job.finishedAt = new Date().toISOString();
      await saveJob(job);
      return;
    }
  }

  try {
    // targetLeads counts leads actually delivered, not leads scanned — in
    // partial mode those diverge (most campaign leads have no category yet
    // and get filtered out), so pagination keeps advancing on job.offset
    // regardless, bounded only by the campaign actually running out.
    while (job.processed < job.targetLeads) {
      const page = await listCampaignLeads(cfg.source.apiKey, job.campaignId, PAGE_SIZE, job.offset);
      job.totalLeadsInCampaign = page.totalLeads;

      if (page.leads.length === 0) break; // exhausted the campaign before hitting targetLeads

      for (const lead of page.leads) {
        if (job.processed >= job.targetLeads) break; // reached target mid-page
        job.offset += 1;

        const baseLog = {
          timestamp: new Date().toISOString(),
          clientId: cfg.clientId,
          clientName: cfg.clientName,
          eventType: 'delivery',
          eventId: `delivery-job:${jobId}:${lead.email}`,
          dryRun,
        };

        if (interestCategoryIds && !(lead.leadCategoryId != null && interestCategoryIds.has(lead.leadCategoryId))) {
          job.skippedNotInterested += 1;
          await recordEvent({ ...baseLog, outcome: 'skip', reason: 'not_interested_category' });
          await saveJob(job);
          continue;
        }

        job.processed += 1;

        try {
          let ref = await adapter.findRecord(lead.email, cfg);
          if (ref) {
            job.alreadyExisted += 1;
          } else {
            ref = await adapter.createRecord(leadToSyntheticEvent(lead, cfg.clientId), cfg);
            job.created += 1;
          }

          const statusValue = deliveryStatusValue(lead);
          if (statusValue) {
            try {
              await adapter.updateStatus(ref, statusValue, cfg);
            } catch (err) {
              logger.warn('delivery job: status backfill failed', {
                jobId,
                email: lead.email,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          let leadActivitiesLogged = 0;
          try {
            const history = await listLeadMessageHistory(cfg.source.apiKey, job.campaignId, lead.id);
            for (const message of history) {
              await adapter.writeActivity(ref, messageToSyntheticEvent(message, lead, cfg.clientId), cfg);
              leadActivitiesLogged += 1;
            }
            job.activitiesLogged += leadActivitiesLogged;
          } catch (err) {
            logger.warn('delivery job: activity backfill failed', {
              jobId,
              email: lead.email,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          await recordEvent({
            ...baseLog,
            outcome: 'success',
            detail: { ref, activitiesLogged: leadActivitiesLogged, jobId },
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          job.errors.push({ email: lead.email, reason });
          await recordEvent({ ...baseLog, outcome: 'error', reason });
        }

        // Persisted after every lead — this is what makes progress visible
        // in near-real-time via GET /api/delivery/jobs/:id, and what makes
        // the job resumable from a precise point if the process restarts.
        await saveJob(job);
      }

      if (job.offset >= (job.totalLeadsInCampaign ?? Infinity)) break;
    }

    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    await saveJob(job);
  } catch (err) {
    job.status = 'failed';
    job.failureReason = err instanceof Error ? err.message : String(err);
    job.finishedAt = new Date().toISOString();
    await saveJob(job);
  }
}
