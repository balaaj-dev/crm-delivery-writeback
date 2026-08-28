/**
 * Structured logging for the whole app, plus the event outcome log that
 * powers /log.
 *
 * The event log persists to Upstash Redis (a capped, newest-first list)
 * when KV_REST_API_URL/TOKEN are set, same fallback pattern as
 * lib/config.ts and lib/jobs.ts — fixes a real gap (see docs/HANDOVER.md):
 * the original in-memory array didn't survive Vercel serverless cold
 * starts, so /log could look empty even right after a real event was
 * processed. Local dev without KV configured keeps the original in-memory
 * array + JSON-lines file mirror, unchanged.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { kvAvailable, kvListPush, kvListRange } from './kv';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function currentLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
  return raw === 'debug' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

function log(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[currentLevel()]) return;
  const line = { level, message, ...meta, ts: new Date().toISOString() };
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(JSON.stringify(line));
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => log('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => log('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log('error', message, meta),
};

// ---------------------------------------------------------------------------
// Event outcome log — what /log renders
// ---------------------------------------------------------------------------

export interface EventLogEntry {
  timestamp: string;
  clientId: string;
  clientName?: string;
  eventType: string;
  eventId: string;
  outcome: 'success' | 'skip' | 'error';
  reason?: string;
  dryRun: boolean;
  detail?: unknown;
}

// Module-level array. Survives for the life of one dev-server / serverless
// instance — see the file-level limitation note above.
const memoryLog: EventLogEntry[] = [];
const MAX_MEMORY_ENTRIES = 500;

const LOG_FILE_PATH = path.join(process.cwd(), 'data', 'event-log.jsonl');
const EVENT_LOG_KV_KEY = 'event-log';

async function appendToFile(entry: EventLogEntry) {
  try {
    await mkdir(path.dirname(LOG_FILE_PATH), { recursive: true });
    await appendFile(LOG_FILE_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    // Read-only filesystem (e.g. Vercel) — fall back to memory-only silently,
    // but say so once via the structured logger so it's visible in output.
    logger.debug('event-log file append skipped (read-only or unavailable fs)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recordEvent(entry: EventLogEntry): Promise<void> {
  logger.info(`event ${entry.outcome}`, {
    clientId: entry.clientId,
    eventType: entry.eventType,
    reason: entry.reason,
    dryRun: entry.dryRun,
  });

  if (kvAvailable()) {
    await kvListPush(EVENT_LOG_KV_KEY, entry, MAX_MEMORY_ENTRIES);
    return;
  }

  memoryLog.unshift(entry);
  if (memoryLog.length > MAX_MEMORY_ENTRIES) memoryLog.length = MAX_MEMORY_ENTRIES;
  await appendToFile(entry);
}

export async function getEventLog(limit = 100): Promise<EventLogEntry[]> {
  if (kvAvailable()) {
    return kvListRange<EventLogEntry>(EVENT_LOG_KV_KEY, 0, limit - 1);
  }

  if (memoryLog.length > 0) {
    return memoryLog.slice(0, limit);
  }
  // Cold start with nothing in memory yet — try the file as a fallback so a
  // dev-server restart doesn't look like the app has never run.
  try {
    const raw = await readFile(LOG_FILE_PATH, 'utf8');
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as EventLogEntry);
    return lines.reverse().slice(0, limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Raw Smartlead webhook capture — added 28 Aug 2026. Nobody has ever
// actually inspected a real, live-fired Smartlead webhook payload (see
// docs/HANDOVER.md's biggest unresolved [VERIFY] item); if a real event's
// shape doesn't match what smartleadWebhookPayloadSchema expects, the
// webhook route used to log only the *validation issues*, never the actual
// JSON that was received — so there was nothing to fix the parser against.
// This captures the exact raw body of every call that passes the per-client
// webhook secret check (see app/api/webhooks/smartlead/route.ts), valid or
// not, so the first real event — whenever it arrives — is actually
// inspectable instead of just failing silently-ish into a log line.
// ---------------------------------------------------------------------------

export interface RawWebhookCapture {
  timestamp: string;
  clientId: string;
  valid: boolean;
  validationIssues?: unknown;
  body: unknown;
}

const RAW_WEBHOOK_KV_KEY = 'webhook-raw-log';
const MAX_RAW_WEBHOOK_ENTRIES = 50;
const rawWebhookMemoryLog: RawWebhookCapture[] = [];
const RAW_WEBHOOK_FILE_PATH = path.join(process.cwd(), 'data', 'webhook-raw-log.jsonl');

async function appendRawWebhookToFile(capture: RawWebhookCapture) {
  try {
    await mkdir(path.dirname(RAW_WEBHOOK_FILE_PATH), { recursive: true });
    await appendFile(RAW_WEBHOOK_FILE_PATH, JSON.stringify(capture) + '\n', 'utf8');
  } catch (err) {
    logger.debug('webhook-raw-log file append skipped (read-only or unavailable fs)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function recordRawWebhookPayload(capture: RawWebhookCapture): Promise<void> {
  logger.info('smartlead webhook: raw payload captured', {
    clientId: capture.clientId,
    valid: capture.valid,
  });

  if (kvAvailable()) {
    await kvListPush(RAW_WEBHOOK_KV_KEY, capture, MAX_RAW_WEBHOOK_ENTRIES);
    return;
  }

  // Same reason as recordEvent's file mirror: Next.js dev mode compiles
  // different API routes as separate on-demand bundles, each with its own
  // instance of this module's in-memory array — a plain in-memory-only
  // fallback would make a capture written by the webhook route invisible
  // to the diagnostics route reading it back. The file bridges that gap
  // locally (unneeded on Vercel, where kvAvailable() is true).
  rawWebhookMemoryLog.unshift(capture);
  if (rawWebhookMemoryLog.length > MAX_RAW_WEBHOOK_ENTRIES) {
    rawWebhookMemoryLog.length = MAX_RAW_WEBHOOK_ENTRIES;
  }
  await appendRawWebhookToFile(capture);
}

export async function getRawWebhookLog(limit = 50): Promise<RawWebhookCapture[]> {
  if (kvAvailable()) {
    return kvListRange<RawWebhookCapture>(RAW_WEBHOOK_KV_KEY, 0, limit - 1);
  }

  if (rawWebhookMemoryLog.length > 0) {
    return rawWebhookMemoryLog.slice(0, limit);
  }
  try {
    const raw = await readFile(RAW_WEBHOOK_FILE_PATH, 'utf8');
    const lines = raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RawWebhookCapture);
    return lines.reverse().slice(0, limit);
  } catch {
    return [];
  }
}
