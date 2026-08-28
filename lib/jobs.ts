/**
 * Real background job system for delivery — built at Balaaj's explicit
 * request, overriding the original brief's "no durable job queue" decision
 * (§3) for this specific feature. A single HTTP request can't safely carry
 * a delivery run across a whole campaign (thousands of leads, each needing
 * several real network calls) — this decouples "start the work" from
 * "wait for the work", persists progress durably, and survives the
 * initiating request disconnecting.
 *
 * Job records: one per job, backed by Upstash Redis (lib/kv.ts) when
 * available, falling back to one JSON file per job under data/jobs/ for
 * local dev (unchanged from before). Switched to KV 27 Aug 2026 after
 * confirming live that the file-only version threw outright on Vercel's
 * read-only filesystem — "Could not start any delivery jobs" with every
 * campaign failing. The file version had no fallback/catch at all, unlike
 * lib/config.ts's session overrides, which is why this broke loudly while
 * the rest of the wizard appeared to work.
 *
 * The runner itself — the in-process async loop that keeps working after
 * the HTTP handler that started it has already returned a response — is a
 * SEPARATE problem this change does not fix. That part is genuinely correct
 * and resumable for any persistently-running Node process (`next dev`
 * locally, or `next start` on a normal always-on server), but is NOT
 * automatically correct on Vercel's default serverless functions: those are
 * frozen/torn down shortly after a response is sent, so a floating promise
 * started inside a request handler is not guaranteed to keep running to
 * completion. Real job *records* now survive that (KV persists regardless
 * of whether the runner got to finish), but actually driving a large job to
 * completion on Vercel still needs one more real piece of infra — e.g. a
 * Vercel Cron job or a queue trigger (QStash pairs naturally with the
 * Upstash Redis already in use here) hitting a "process the next chunk of
 * this job" endpoint on an interval. Not built in this pass — see
 * docs/HANDOVER.md.
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ClientConfig, CrmAdapter } from './types';
import {
  listCampaignLeads,
  listLeadMessageHistory,
  resolveInterestCategoryIds,
  resolveCategoryStatusValues,
  type SmartleadLead,
} from './sources/smartlead-api';
import { logger, recordEvent } from './log';
import { isDryRun } from './adapters/index';
import { kvAvailable, kvGet, kvGetAllByPrefix, kvSet } from './kv';
import { qstashAvailable, publishJobChunk } from './qstash';

const JOBS_DIR = path.join(process.cwd(), 'data', 'jobs');
const JOB_KV_PREFIX = 'delivery-job:';
/**
 * Also doubles as the QStash chunk size — one page = one "process this job"
 * invocation. Kept small (not the original 100) so one invocation — each
 * lead costs several real network calls (find/create contact, status
 * update, message-history fetch, deal creation) — comfortably fits inside
 * the route's maxDuration on Vercel rather than risking a timeout mid-page.
 */
const PAGE_SIZE = 20;

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
  /** Deals created for genuinely interested leads — see the comment above the deal-creation block in runJob for why delivery didn't do this before 26 Aug 2026. */
  dealsCreated: number;
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
  if (kvAvailable()) {
    await kvSet(`${JOB_KV_PREFIX}${job.id}`, job);
    return;
  }
  await mkdir(JOBS_DIR, { recursive: true });
  await writeFile(jobFilePath(job.id), JSON.stringify(job, null, 2), 'utf8');
}

export async function getJob(id: string): Promise<DeliveryJob | null> {
  if (kvAvailable()) {
    return kvGet<DeliveryJob>(`${JOB_KV_PREFIX}${id}`);
  }
  try {
    const raw = await readFile(jobFilePath(id), 'utf8');
    return JSON.parse(raw) as DeliveryJob;
  } catch {
    return null;
  }
}

export async function listJobs(clientId?: string): Promise<DeliveryJob[]> {
  if (kvAvailable()) {
    const all = await kvGetAllByPrefix<DeliveryJob>(JOB_KV_PREFIX);
    const jobs = Object.values(all);
    const filtered = clientId ? jobs.filter((j) => j.clientId === clientId) : jobs;
    return filtered.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
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
    // Name included (not just email) — see lib/delivery.ts's identical
    // helper for why: without it, HubSpot's writeActivity from/to
    // participant fields show only an address, and the reply side shows
    // "Unknown Contact" for the name portion.
    prospect: {
      email: lead.email.trim().toLowerCase(),
      firstName: lead.firstName,
      lastName: lead.lastName,
    },
    detail: { subject: message.subject, bodyPreview: message.body.slice(0, 2000) },
    raw: message,
  };
}

/**
 * Kicks off (or continues) work on a job — publishes the first "process this
 * job" message to QStash when it's configured (real serverless-safe path),
 * otherwise runs the whole job in-process (local dev — genuinely correct
 * there, see file header). PUBLIC_BASE_URL must be set for the QStash path,
 * since QStash calls back over the open internet, not from inside this
 * process — falls back to in-process if it's missing, logging a warning,
 * rather than silently publishing to a broken URL.
 */
function advanceJob(jobId: string, cfg: ClientConfig, adapter: CrmAdapter): void {
  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (qstashAvailable() && baseUrl) {
    publishJobChunk(`${baseUrl}/api/delivery/jobs/${jobId}/process`, {}).catch((err) => {
      logger.error('failed to publish delivery job chunk to QStash', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return;
  }
  if (qstashAvailable() && !baseUrl) {
    logger.warn('QStash is configured but PUBLIC_BASE_URL is not set — falling back to in-process (will not survive Vercel freezing this instance)', { jobId });
  }
  // Deliberately not awaited — see file header for exactly what this does
  // and does not guarantee depending on where it's deployed.
  runJob(jobId, cfg, adapter).catch((err) => {
    logger.error('delivery job crashed outside its own error handling', {
      jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/** Creates a job record and starts it running — returns immediately, does not await completion. */
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
    dealsCreated: 0,
    errors: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await saveJob(job);
  advanceJob(job.id, cfg, adapter);
  return job;
}

/** Resumes a job that's stuck in 'queued'/'running' (e.g. the process restarted mid-job) from its saved offset. */
export async function resumeDeliveryJob(id: string, cfg: ClientConfig, adapter: CrmAdapter): Promise<DeliveryJob | null> {
  const job = await getJob(id);
  if (!job) return null;
  if (job.status === 'completed' || job.status === 'failed') return job;

  advanceJob(id, cfg, adapter);
  return job;
}

/**
 * Processes exactly one page (PAGE_SIZE leads) of a job and persists
 * progress, then returns whether there's more work left to do. This is the
 * unit of work QStash re-triggers per invocation (app/api/delivery/jobs/
 * [id]/process/route.ts) — kept as its own function, not inlined into
 * runJob's loop, specifically so both the QStash path (one page per HTTP
 * request) and the in-process path (runJob's loop, below) share the exact
 * same per-page logic instead of two copies drifting apart.
 */
export async function processJobPage(jobId: string, cfg: ClientConfig, adapter: CrmAdapter): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return false;

  job.status = 'running';
  const dryRun = isDryRun();

  // Same partial-mode interest filter as lib/delivery.ts — see that file's
  // comment for the real incident (25 Aug 2026) this fixes. Also resolved
  // in full mode when createDeal is on, since it's now what decides
  // whether a delivered lead gets a deal too (see below) — full mode
  // delivers every lead as a contact, but a deal should still only be
  // created for the ones genuinely marked Interested/Meeting Booked, same
  // distinction lib/dispatch.ts's own isDealSignal makes for live replies.
  // Re-resolved every page rather than cached in the job record — one extra
  // Smartlead API call per page is cheap, and simpler than persisting a Map
  // across QStash-triggered invocations.
  let interestCategoryIds: Map<number, 'positive_reply' | 'meeting_booked'> | null = null;
  if (cfg.mode === 'partial' || cfg.behaviour.createDeal) {
    try {
      interestCategoryIds = await resolveInterestCategoryIds(cfg.source.apiKey, cfg.statusMap);
    } catch (err) {
      if (cfg.mode === 'partial') {
        // Fail safe, not fail open — see lib/delivery.ts's comment.
        job.status = 'failed';
        job.failureReason = `Partial-mode delivery needs Smartlead's lead categories to filter for Interested/Meeting Booked leads, and that lookup failed: ${err instanceof Error ? err.message : String(err)}`;
        job.finishedAt = new Date().toISOString();
        await saveJob(job);
        return false;
      }
      // Full mode doesn't depend on this for delivery itself — degrade
      // gracefully by skipping deal creation this run rather than failing
      // the whole job over a feature that isn't its main job.
      logger.warn('delivery job: could not resolve interest categories — deal creation will be skipped this run', {
        jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Same best-effort re-resolve-per-page approach as interestCategoryIds
  // above, and the same real bug it fixes — see resolveCategoryStatusValues.
  let categoryStatusValues: Map<number, string> | null = null;
  if (Object.keys(cfg.statusMap).length > 0) {
    try {
      categoryStatusValues = await resolveCategoryStatusValues(cfg.source.apiKey, cfg.statusMap);
    } catch (err) {
      logger.warn(
        'delivery job: could not resolve category status values — status backfill will use the mechanical fallback',
        { jobId, error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  if (job.processed >= job.targetLeads) {
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    await saveJob(job);
    return false;
  }

  try {
    // targetLeads counts leads actually delivered, not leads scanned — in
    // partial mode those diverge (most campaign leads have no category yet
    // and get filtered out), so pagination keeps advancing on job.offset
    // regardless, bounded only by the campaign actually running out.
    const page = await listCampaignLeads(cfg.source.apiKey, job.campaignId, PAGE_SIZE, job.offset);
    job.totalLeadsInCampaign = page.totalLeads;

    if (page.leads.length === 0) {
      // Exhausted the campaign before hitting targetLeads.
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      await saveJob(job);
      return false;
    }

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

      // interestCategoryIds is now resolved in full mode too (when
      // createDeal is on, for the deal-creation check below) — so this
      // filter must stay gated on cfg.mode itself, not just on whether
      // the set exists, or full mode would wrongly start skipping leads
      // it's supposed to deliver unconditionally.
      const dealSignal =
        interestCategoryIds != null && lead.leadCategoryId != null
          ? interestCategoryIds.get(lead.leadCategoryId)
          : undefined;
      const isInterested = dealSignal != null;

      if (cfg.mode === 'partial' && !isInterested) {
        job.skippedNotInterested += 1;
        await recordEvent({ ...baseLog, outcome: 'skip', reason: 'not_interested_category' });
        await saveJob(job);
        continue;
      }

      job.processed += 1;

      try {
        let ref = await adapter.findRecord(lead.email, cfg);
        let isNewRecord = false;
        if (ref) {
          job.alreadyExisted += 1;
        } else {
          ref = await adapter.createRecord(leadToSyntheticEvent(lead, cfg.clientId), cfg);
          job.created += 1;
          isNewRecord = true;
        }

        const statusValue =
          (lead.leadCategoryId != null ? categoryStatusValues?.get(lead.leadCategoryId) : undefined) ??
          deliveryStatusValue(lead);
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

        // Deal creation — the gap found live, 26 Aug 2026: delivery
        // (this file) never went through lib/dispatch.ts, so it never
        // did what a real webhook-triggered positive_reply/meeting_booked
        // does — create a deal. Mirrors dispatch.ts's own isDealSignal
        // check (same interest test as the partial-mode filter above,
        // just also evaluated in full mode now), gated to a record this
        // pass actually created — an already-existing contact isn't
        // re-given a deal on every subsequent delivery run, since this
        // file has no durable per-ref dedup the way dispatch.ts does.
        if (isNewRecord && dealSignal && cfg.behaviour.createDeal && adapter.createDeal) {
          try {
            await adapter.createDeal(ref, leadToSyntheticEvent(lead, cfg.clientId), cfg, dealSignal);
            job.dealsCreated += 1;
          } catch (err) {
            logger.warn('delivery job: deal creation failed', {
              jobId,
              email: lead.email,
              error: err instanceof Error ? err.message : String(err),
            });
          }
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

    const exhausted = job.offset >= (job.totalLeadsInCampaign ?? Infinity);
    const reachedTarget = job.processed >= job.targetLeads;
    if (exhausted || reachedTarget) {
      job.status = 'completed';
      job.finishedAt = new Date().toISOString();
      await saveJob(job);
      return false;
    }

    await saveJob(job); // status stays 'running' — more pages to go
    return true;
  } catch (err) {
    job.status = 'failed';
    job.failureReason = err instanceof Error ? err.message : String(err);
    job.finishedAt = new Date().toISOString();
    await saveJob(job);
    return false;
  }
}

/** In-process runner: loops processJobPage until it reports no more work. Used only when QStash isn't configured (local dev) — see advanceJob. */
async function runJob(jobId: string, cfg: ClientConfig, adapter: CrmAdapter): Promise<void> {
  let more = true;
  while (more) {
    more = await processJobPage(jobId, cfg, adapter);
  }
}
