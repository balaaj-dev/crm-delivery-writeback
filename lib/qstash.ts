/**
 * Upstash QStash — drives delivery jobs to actual completion on Vercel.
 * Added 27 Aug 2026 to fix a confirmed-live gap: lib/kv.ts fixed job
 * *records* persisting on Vercel, but nothing was left running to actually
 * process one — confirmed live, a real job sat at status "queued" with zero
 * progress indefinitely, because Vercel had already frozen the function
 * instance that started it before it got anywhere.
 *
 * Self-chaining pattern: each invocation of the "process this job" route
 * handles one page of leads, then — if there's more work — publishes a
 * message back to QStash targeting that same route. QStash delivers that as
 * a brand new HTTP request, which Vercel runs as a fresh, un-frozen function
 * instance. Repeat until the job reports no more work.
 *
 * Falls back to nothing (qstashAvailable() false) when QSTASH_TOKEN isn't
 * set — lib/jobs.ts's startDeliveryJob/resumeDeliveryJob use that to decide
 * whether to publish to QStash or just run the whole job in-process, which
 * is what local dev still does (genuinely correct there, since the process
 * stays alive for the job's whole duration).
 */
import { Client, Receiver } from '@upstash/qstash';

let client: Client | null | undefined;

function getClient(): Client | null {
  if (client !== undefined) return client;
  const token = process.env.QSTASH_TOKEN;
  client = token ? new Client({ token }) : null;
  return client;
}

export function qstashAvailable(): boolean {
  return getClient() !== null;
}

/** Publishes one "process the next chunk of this job" message. `url` must be a full, publicly-reachable URL — QStash calls it over the open internet, not from inside this process. */
export async function publishJobChunk(url: string, body: Record<string, unknown>): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.publishJSON({ url, body });
}

let receiver: Receiver | null | undefined;

function getReceiver(): Receiver | null {
  if (receiver !== undefined) return receiver;
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  receiver =
    currentSigningKey && nextSigningKey ? new Receiver({ currentSigningKey, nextSigningKey }) : null;
  return receiver;
}

/**
 * Verifies an incoming request really came from QStash — required before
 * trusting the "process this job" route, which is deliberately excluded
 * from middleware.ts's Basic Auth gate (QStash can't present that) and
 * instead relies entirely on this cryptographic signature check. Returns
 * false (not throws) on any verification failure, missing signature, or no
 * receiver configured — the caller treats that as "reject the request."
 */
export async function verifyQstashSignature(signature: string | null, body: string): Promise<boolean> {
  const r = getReceiver();
  if (!r || !signature) return false;
  try {
    return await r.verify({ signature, body });
  } catch {
    return false;
  }
}
