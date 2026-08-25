/**
 * "Delivery" — the other half of S1. Jairo's own framing on the 19 Aug call:
 * "there's essentially two parts to it... taking our data and having that
 * uploaded to the CRM... and then the second part is writeback." The build
 * brief given to build this repo explicitly scoped only the second part —
 * this file is the first part, built afterward at Balaaj's request once
 * writeback was proven against a real HubSpot portal.
 *
 * Bulk-creates CRM contact records from a client's existing Smartlead leads,
 * independent of any triggering event — this is what lets writeback's
 * "partial mode" matching actually find something later (§8 step 5 in the
 * dispatch decision tree needs the record to already exist, or a policy
 * that allows creating it).
 *
 * Deliberately reuses the exact same CrmAdapter.findRecord/createRecord
 * contract writeback already uses, rather than inventing a parallel path —
 * a delivered lead is represented as a minimal CanonicalEvent-shaped object
 * so the adapter's existing field-mapping logic (buildContactProperties in
 * lib/adapters/hubspot.ts) works completely unchanged.
 */
import type { CanonicalEvent, ClientConfig, CrmAdapter } from './types';
import { listCampaignLeads, type SmartleadLead } from './sources/smartlead-api';
import { logger } from './log';
import { recordEvent } from './log';
import { isDryRun } from './adapters/index';

export interface DeliveryResult {
  campaignId: string;
  totalLeadsInCampaign: number;
  processed: number;
  created: number;
  alreadyExisted: number;
  errors: Array<{ email: string; reason: string }>;
  /** Set when totalLeadsInCampaign > the limit passed in — never silently dropped, always reported. */
  cappedAt?: number;
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
      title: lead.title,
      phone: lead.phone,
      linkedinUrl: lead.linkedinUrl,
    },
    detail: {},
    raw: lead,
  };
}

/**
 * Delivers up to `maxLeads` leads from one campaign in a single request.
 * Capped by default and deliberately synchronous — the brief's own
 * "no durable job queue" decision (§3) applies here too. A campaign with
 * thousands of leads needs a real background job runner to deliver in
 * full; this is a skeleton-grade proof, not that. Never silently drops
 * leads past the cap — `cappedAt` tells the caller more exist.
 */
export async function deliverCampaignLeads(
  cfg: ClientConfig,
  adapter: CrmAdapter,
  campaignId: string,
  maxLeads = 25,
): Promise<DeliveryResult> {
  const { leads, totalLeads } = await listCampaignLeads(cfg.source.apiKey, campaignId, maxLeads);
  const dryRun = isDryRun();

  const result: DeliveryResult = {
    campaignId,
    totalLeadsInCampaign: totalLeads,
    processed: 0,
    created: 0,
    alreadyExisted: 0,
    errors: [],
  };
  if (totalLeads > maxLeads) result.cappedAt = maxLeads;

  for (const lead of leads) {
    result.processed += 1;
    const baseLog = {
      timestamp: new Date().toISOString(),
      clientId: cfg.clientId,
      clientName: cfg.clientName,
      eventType: 'delivery',
      eventId: `delivery:${cfg.clientId}:${lead.email}`,
      dryRun,
    };
    try {
      const existing = await adapter.findRecord(lead.email, cfg);
      if (existing) {
        result.alreadyExisted += 1;
        await recordEvent({ ...baseLog, outcome: 'skip', reason: 'already_exists' });
        continue;
      }
      const event = leadToSyntheticEvent(lead, cfg.clientId);
      const ref = await adapter.createRecord(event, cfg);
      result.created += 1;
      await recordEvent({ ...baseLog, outcome: 'success', detail: { ref } });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn('delivery: failed to create record for lead', { email: lead.email, reason });
      result.errors.push({ email: lead.email, reason });
      await recordEvent({ ...baseLog, outcome: 'error', reason });
    }
  }

  return result;
}
