/**
 * In-memory idempotency key store, keyed on CanonicalEvent.eventId.
 *
 * Limitation (see docs/HANDOVER.md): this Map resets on cold start. On
 * Vercel serverless that can mean a duplicate webhook delivery gets
 * reprocessed if it lands on a fresh instance. Production needs a
 * persistent store (Redis, a database row, whatever the eventual platform
 * already has) — deliberately not built here per the "no database" decision
 * for this milestone.
 */

const seen = new Map<string, number>();

export function hasBeenProcessed(eventId: string): boolean {
  return seen.has(eventId);
}

export function markProcessed(eventId: string): void {
  seen.set(eventId, Date.now());
}

/** Test-only escape hatch so unit tests get a clean store per test. */
export function resetIdempotencyStore(): void {
  seen.clear();
}
