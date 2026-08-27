/**
 * "Delivery" — the other half of S1. Jairo's own framing on the 19 Aug call:
 * "there's essentially two parts to it... taking our data and having that
 * uploaded to the CRM... and then the second part is writeback." The build
 * brief given to build this repo explicitly scoped only the second part —
 * this file is the first part, built afterward at Balaaj's request once
 * writeback was proven against a real HubSpot portal.
 *
 * For each lead in the campaign(s) selected, this:
 *   1. Creates the CRM contact if it doesn't already exist (reusing the
 *      exact same CrmAdapter.findRecord/createRecord contract writeback
 *      uses — a lead is represented as a minimal CanonicalEvent-shaped
 *      object so the adapter's existing field-mapping logic works
 *      unchanged).
 *   2. Best-effort backfills the contact's status from Smartlead's own
 *      sequence status (INPROGRESS/COMPLETED/PAUSED/...).
 *   3. Best-effort backfills real send/reply history as actual email
 *      engagements (not generic notes) — see lib/adapters/hubspot.ts's
 *      writeActivity — so a delivered contact shows real activity instead
 *      of an empty timeline, and HubSpot's own "last contacted" populates
 *      itself from the real historical timestamps.
 * Steps 2 and 3 run for *every* processed lead, not just newly-created
 * ones — an already-existing contact with no logged activity benefits from
 * this exactly as much as a brand-new one (this is what a real client asked
 * for after seeing a delivered contact with an empty activity timeline).
 */
import type { CanonicalEvent, ClientConfig, CrmAdapter } from './types';
import {
  listCampaignLeads,
  listLeadMessageHistory,
  resolveInterestCategoryIds,
  type SmartleadLead,
} from './sources/smartlead-api';
import { logger, recordEvent } from './log';
import { isDryRun } from './adapters/index';

/** Hard ceiling regardless of the caller's requested maxLeads — a safety backstop, not a target to hit. */
const HARD_MAX_LEADS = 500;
/** Smartlead's own page size for listCampaignLeads — paginate in chunks this large up to maxLeads. */
const PAGE_SIZE = 100;

export interface DeliveryResult {
  campaignId: string;
  totalLeadsInCampaign: number;
  processed: number;
  created: number;
  alreadyExisted: number;
  /** Real email engagements logged from Smartlead's message history, across all processed leads. */
  activitiesLogged: number;
  errors: Array<{ email: string; reason: string }>;
  /** Set when totalLeadsInCampaign > what was actually fetched — never silently dropped, always reported. */
  cappedAt?: number;
  /** Partial mode only — leads fetched but not delivered because their live Smartlead category isn't Interested/Meeting Booked. */
  skippedNotInterested: number;
  /** Deals created for genuinely interested leads — see the comment above the deal-creation block below for why delivery didn't do this before 26 Aug 2026. */
  dealsCreated: number;
}

function leadToSyntheticEvent(lead: SmartleadLead, clientId: string): CanonicalEvent {
  return {
    eventId: `delivery:${clientId}:${lead.email}`,
    occurredAt: new Date(0).toISOString(),
    // Not a real event — delivery never goes through lib/dispatch.ts, so
    // this type is never inspected for a dispatch decision. It exists only
    // to satisfy CrmAdapter.createRecord's signature, which reads
    // event.prospect.* via the client's fieldMap, nothing else.
    type: 'email_sent',
    clientId,
    source: 'smartlead',
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

/** Smartlead's raw sequence status -> a value cymate_writeback_status can hold. Just lowercased, kept literal — not a real category, don't conflate with the statusMap's positive_reply/meeting_booked promotions. */
function deliveryStatusValue(lead: SmartleadLead): string | undefined {
  return lead.sequenceStatus ? `delivered_${lead.sequenceStatus.toLowerCase()}` : undefined;
}

function messageToSyntheticEvent(
  message: { type: string; subject: string; body: string; time: string },
  lead: SmartleadLead,
  clientId: string,
): CanonicalEvent {
  return {
    eventId: `delivery-activity:${clientId}:${lead.email}:${message.time}`,
    occurredAt: message.time,
    type: message.type === 'REPLY' ? 'reply' : 'email_sent',
    clientId,
    source: 'smartlead',
    campaign: { id: '', name: '' },
    // Name included (not just email), added 26 Aug 2026 — needed for
    // writeActivity's from/to participant fields to show a real name
    // instead of just an address, and for hs_email_from/to_firstname
    // /lastname on the reply side specifically to resolve away from
    // "Unknown Contact" in HubSpot's UI.
    prospect: {
      email: lead.email.trim().toLowerCase(),
      firstName: lead.firstName,
      lastName: lead.lastName,
    },
    detail: {
      subject: message.subject,
      bodyPreview: message.body.slice(0, 2000),
    },
    raw: message,
  };
}

async function fetchAllLeads(
  apiKey: string,
  campaignId: string,
  maxLeads: number,
): Promise<{ leads: SmartleadLead[]; totalLeads: number }> {
  const leads: SmartleadLead[] = [];
  let totalLeads = 0;
  let offset = 0;

  while (leads.length < maxLeads) {
    const pageSize = Math.min(PAGE_SIZE, maxLeads - leads.length);
    const page = await listCampaignLeads(apiKey, campaignId, pageSize, offset);
    totalLeads = page.totalLeads;
    leads.push(...page.leads);
    offset += page.leads.length;
    if (page.leads.length === 0 || offset >= totalLeads) break;
  }

  return { leads, totalLeads };
}

/**
 * Delivers up to `maxLeads` leads from one campaign (paginating across
 * multiple Smartlead calls as needed, up to `HARD_MAX_LEADS` regardless of
 * what's requested). Deliberately synchronous, in one request — the
 * brief's own "no durable job queue" decision (§3) applies here too. A
 * campaign with many thousands of leads needs a real background job
 * runner to deliver in full; this proves the mechanism, it is not that job
 * runner. Never silently drops leads past the cap — `cappedAt` tells the
 * caller more exist.
 */
export async function deliverCampaignLeads(
  cfg: ClientConfig,
  adapter: CrmAdapter,
  campaignId: string,
  maxLeads = 25,
): Promise<DeliveryResult> {
  const effectiveMax = Math.min(maxLeads, HARD_MAX_LEADS);
  const { leads, totalLeads } = await fetchAllLeads(cfg.source.apiKey, campaignId, effectiveMax);
  const dryRun = isDryRun();

  // Partial mode's entire premise (see types.ts's MODE_PRESETS comment) is
  // that a CRM record only gets created on a genuine interest signal — a
  // real incident (25 Aug 2026, Lotus Labs' Tracie Cranford: bounced, never
  // replied, still delivered as a Lead) confirmed delivery wasn't actually
  // enforcing that. Full mode has no such restriction by design. Also
  // resolved in full mode when createDeal is on — see runJob's identical
  // comment in lib/jobs.ts, which this mirrors.
  let interestCategoryIds: Map<number, 'positive_reply' | 'meeting_booked'> | null = null;
  if (cfg.mode === 'partial' || cfg.behaviour.createDeal) {
    try {
      interestCategoryIds = await resolveInterestCategoryIds(cfg.source.apiKey, cfg.statusMap);
    } catch (err) {
      if (cfg.mode === 'partial') {
        // Fail safe, not fail open — if we can't verify which categories
        // mean "interested", refuse to deliver rather than risk creating
        // CRM contacts for leads with no real interest signal.
        throw new Error(
          `Partial-mode delivery needs Smartlead's lead categories to filter for Interested/Meeting Booked leads, and that lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      logger.warn('delivery: could not resolve interest categories — deal creation will be skipped this run', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result: DeliveryResult = {
    campaignId,
    totalLeadsInCampaign: totalLeads,
    processed: 0,
    created: 0,
    alreadyExisted: 0,
    activitiesLogged: 0,
    errors: [],
    skippedNotInterested: 0,
    dealsCreated: 0,
  };
  if (totalLeads > leads.length) result.cappedAt = leads.length;

  for (const lead of leads) {
    const baseLog = {
      timestamp: new Date().toISOString(),
      clientId: cfg.clientId,
      clientName: cfg.clientName,
      eventType: 'delivery',
      eventId: `delivery:${cfg.clientId}:${lead.email}`,
      dryRun,
    };

    // See lib/jobs.ts's runJob for why this filter stays gated on
    // cfg.mode, not just on whether interestCategoryIds exists — it's now
    // resolved in full mode too, for the deal-creation check below.
    const dealSignal =
      interestCategoryIds != null && lead.leadCategoryId != null
        ? interestCategoryIds.get(lead.leadCategoryId)
        : undefined;
    const isInterested = dealSignal != null;

    if (cfg.mode === 'partial' && !isInterested) {
      result.skippedNotInterested += 1;
      await recordEvent({ ...baseLog, outcome: 'skip', reason: 'not_interested_category' });
      continue;
    }

    result.processed += 1;
    try {
      let ref = await adapter.findRecord(lead.email, cfg);
      let isNewRecord = false;
      if (ref) {
        result.alreadyExisted += 1;
      } else {
        const event = leadToSyntheticEvent(lead, cfg.clientId);
        ref = await adapter.createRecord(event, cfg);
        result.created += 1;
        isNewRecord = true;
      }

      // Best-effort from here — a failure backfilling status/activity
      // shouldn't erase the fact that the contact itself was successfully
      // found/created above.
      const statusValue = deliveryStatusValue(lead);
      if (statusValue) {
        try {
          await adapter.updateStatus(ref, statusValue, cfg);
        } catch (err) {
          logger.warn('delivery: status backfill failed', {
            email: lead.email,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      let leadActivitiesLogged = 0;
      try {
        const history = await listLeadMessageHistory(cfg.source.apiKey, campaignId, lead.id);
        for (const message of history) {
          await adapter.writeActivity(ref, messageToSyntheticEvent(message, lead, cfg.clientId), cfg);
          leadActivitiesLogged += 1;
        }
        result.activitiesLogged += leadActivitiesLogged;
      } catch (err) {
        logger.warn('delivery: activity backfill failed', {
          email: lead.email,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Deal creation — the gap found live, 26 Aug 2026: delivery never
      // went through lib/dispatch.ts, so it never did what a real
      // webhook-triggered positive_reply/meeting_booked does — create a
      // deal. Gated to a record this pass actually created, since this
      // file has no durable per-ref dedup the way dispatch.ts does.
      if (isNewRecord && dealSignal && cfg.behaviour.createDeal && adapter.createDeal) {
        try {
          await adapter.createDeal(ref, leadToSyntheticEvent(lead, cfg.clientId), cfg, dealSignal);
          result.dealsCreated += 1;
        } catch (err) {
          logger.warn('delivery: deal creation failed', {
            email: lead.email,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await recordEvent({
        ...baseLog,
        outcome: 'success',
        detail: { ref, activitiesLogged: leadActivitiesLogged },
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('delivery: failed to create record for lead', { email: lead.email, reason });
      result.errors.push({ email: lead.email, reason });
      await recordEvent({ ...baseLog, outcome: 'error', reason });
    }
  }

  return result;
}
