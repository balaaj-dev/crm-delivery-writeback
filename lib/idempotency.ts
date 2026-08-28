/**
 * Idempotency claim store, keyed on CanonicalEvent.eventId.
 *
 * Backed by Upstash Redis (SET NX + TTL — one atomic call, so two
 * concurrent deliveries of the same webhook can't both pass the check
 * before either marks it processed) when KV_REST_API_URL/TOKEN are set,
 * same fallback pattern as lib/config.ts and lib/jobs.ts. Falls back to
 * the original in-memory Map otherwise (local dev, tests) — that version
 * resets on cold start, which is fine there but was a real gap on Vercel
 * (see docs/HANDOVER.md) since a duplicate webhook delivery landing on a
 * fresh instance could get reprocessed.
 */
import { kvAvailable, kvSetNX } from './kv';

const seen = new Map<string, number>();

// 7 days comfortably covers any realistic webhook-retry window without the
// key set growing unbounded.
const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Returns true if this is the first time this eventId has been seen (go ahead and process it), false if it's a duplicate (skip it). */
export async function tryClaimEvent(eventId: string): Promise<boolean> {
  if (kvAvailable()) {
    return kvSetNX(`idempotency:${eventId}`, 1, IDEMPOTENCY_TTL_SECONDS);
  }
  if (seen.has(eventId)) return false;
  seen.set(eventId, Date.now());
  return true;
}

/** Test-only escape hatch so unit tests get a clean store per test. */
export function resetIdempotencyStore(): void {
  seen.clear();
}
