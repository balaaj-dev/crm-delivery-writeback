/**
 * The decision layer between a canonical event and a CRM adapter call
 * (brief §8). Pure and unit-testable: takes the adapter as a parameter
 * rather than resolving it itself, so tests can pass lib/adapters/mock.ts
 * directly without touching env vars or the registry.
 *
 * Every skip is logged with a machine-readable reason. Silent drops are the
 * failure mode this whole service exists to prevent — no_record_no_create_policy
 * in particular will be common in partial mode and must be visible, not hidden.
 */
import type {
  CanonicalEvent,
  CanonicalEventType,
  ClientConfig,
  CrmAdapter,
  CrmRecordRef,
  DispatchOutcome,
} from './types';
import { tryClaimEvent } from './idempotency';
import { recordEvent } from './log';
import { isDryRun } from './adapters/index';
import { kvAvailable, kvGet, kvSet } from './kv';

/** category/status-map values that, when matched, promote a status_change event to that type. */
const PROMOTABLE_TYPES: CanonicalEventType[] = ['positive_reply', 'meeting_booked'];

/**
 * LEAD_CATEGORY_UPDATED always normalises to 'status_change' in
 * lib/sources/smartlead.ts, since that mapper is client-agnostic. Whether a
 * given category counts as a positive_reply / meeting_booked for dispatch
 * (config.events toggles) or "just" a generic status_change is a per-client
 * decision, driven by the client's own statusMap (brief §7.5, §6.1) — a
 * category whose mapped value is itself one of the two special canonical
 * types gets promoted for the purposes of the event-toggle check below.
 */
export function resolveEffectiveEventType(
  event: CanonicalEvent,
  cfg: ClientConfig,
): CanonicalEventType {
  if (event.type !== 'status_change' || !event.detail.category) return event.type;
  const mapped = cfg.statusMap[event.detail.category];
  if (mapped && (PROMOTABLE_TYPES as string[]).includes(mapped)) {
    return mapped as CanonicalEventType;
  }
  return event.type;
}

// Tracks which CRM record refs have already had a deal created, so a
// repeated positive_reply/meeting_booked doesn't spawn a second deal.
// Backed by KV (permanent — no TTL, since this should hold for the life of
// the CRM record, not just a retry window) when available, same fallback
// pattern as idempotency.ts. Not atomic (a get then a later set) — an
// acceptable trade-off since colliding on this would require two literally
// concurrent dispatches for the same brand-new contact's first positive
// signal, which is far rarer than the webhook-redelivery case idempotency.ts
// guards against.
const dealsCreatedForRef = new Set<string>();

async function hasCreatedDealFor(refId: string): Promise<boolean> {
  if (kvAvailable()) return (await kvGet<boolean>(`deal-created:${refId}`)) === true;
  return dealsCreatedForRef.has(refId);
}

async function markDealCreatedFor(refId: string): Promise<void> {
  if (kvAvailable()) {
    await kvSet(`deal-created:${refId}`, true);
    return;
  }
  dealsCreatedForRef.add(refId);
}

/** Test-only escape hatch so unit tests get a clean store per test. */
export function resetDealDedupeStore(): void {
  dealsCreatedForRef.clear();
}

export async function dispatchEvent(
  event: CanonicalEvent,
  cfg: ClientConfig,
  adapter: CrmAdapter,
): Promise<DispatchOutcome> {
  const dryRun = isDryRun();
  const baseLog = {
    timestamp: new Date().toISOString(),
    clientId: cfg.clientId,
    clientName: cfg.clientName,
    eventType: event.type,
    eventId: event.eventId,
    dryRun,
  };

  // 1. not activated
  if (!cfg.activated) {
    await recordEvent({ ...baseLog, outcome: 'skip', reason: 'not_activated' });
    return { status: 'skip', reason: 'not_activated' };
  }

  const effectiveType = resolveEffectiveEventType(event, cfg);

  // 2. event type disabled for this client
  if (!cfg.events[effectiveType]) {
    await recordEvent({ ...baseLog, outcome: 'skip', reason: 'event_disabled' });
    return { status: 'skip', reason: 'event_disabled' };
  }

  // 3. campaign scoping
  const scopedCampaigns = cfg.source.campaignIds ?? [];
  if (scopedCampaigns.length > 0 && !scopedCampaigns.includes(event.campaign.id)) {
    await recordEvent({ ...baseLog, outcome: 'skip', reason: 'campaign_not_in_scope' });
    return { status: 'skip', reason: 'campaign_not_in_scope' };
  }

  // 4. idempotency
  if (!(await tryClaimEvent(event.eventId))) {
    await recordEvent({ ...baseLog, outcome: 'skip', reason: 'duplicate' });
    return { status: 'skip', reason: 'duplicate' };
  }

  // Declared outside the try block so the catch below can report whatever
  // succeeded before a later step failed, instead of losing it — see the
  // "Live HubSpot test" note in docs/HANDOVER.md for the real case that
  // motivated this (deal creation failing on a missing scope after the
  // contact was already created and the note already written).
  let ref: CrmRecordRef | null = null;
  const actions: string[] = [];

  try {
    // 5. find existing record
    ref = await adapter.findRecord(event.prospect.email, cfg);

    if (!ref) {
      // 6. may we create?
      const isInterestedSignal = effectiveType === 'positive_reply' || effectiveType === 'meeting_booked';
      const canCreateOnInterested = isInterestedSignal && cfg.behaviour.createRecordOnInterestedReply;
      const canCreateForAllLeads =
        cfg.behaviour.createRecordForAllLeads && cfg.behaviour.planLimitAcknowledged;

      if (!canCreateOnInterested && !canCreateForAllLeads) {
        await recordEvent({ ...baseLog, outcome: 'skip', reason: 'no_record_no_create_policy' });
        return { status: 'skip', reason: 'no_record_no_create_policy' };
      }

      ref = await adapter.createRecord(event, cfg);
      actions.push('created_record');
    }

    // 7. deal creation — moved ahead of write activity (was step 9) on
    // 27 Aug 2026: a real live test showed a brand-new contact's first
    // interested reply creates the record, writes the activity, *then*
    // creates the deal — so writeActivity's deal-engagement association
    // (see hubspot.ts's findAssociatedDealIds) never found a deal, because
    // it didn't exist yet. Creating the deal first means the single most
    // common case (new contact + interested reply, both created in the
    // same dispatch call) actually gets its activity linked to the deal.
    if (
      cfg.behaviour.createDeal &&
      (effectiveType === 'positive_reply' || effectiveType === 'meeting_booked') &&
      adapter.createDeal &&
      !(await hasCreatedDealFor(ref.id))
    ) {
      await adapter.createDeal(ref, event, cfg, effectiveType);
      await markDealCreatedFor(ref.id);
      actions.push('created_deal');
    }

    // 8. write activity
    await adapter.writeActivity(ref, event, cfg);
    actions.push('wrote_activity');

    // 9. status map
    const category = event.detail.category;
    const statusValue = category ? cfg.statusMap[category] : undefined;
    if (statusValue) {
      await adapter.updateStatus(ref, statusValue, cfg);
      actions.push(`updated_status:${statusValue}`);
    }

    // 10. log success
    await recordEvent({ ...baseLog, outcome: 'success', detail: { ref, actions } });
    return { status: 'success', ref, actions };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await recordEvent({ ...baseLog, outcome: 'error', reason, detail: { ref, actions } });
    return { status: 'error', reason, actions, ref: ref ?? undefined };
  }
}
