/**
 * Structured logging for the whole app, plus the event outcome log that
 * powers /log.
 *
 * Limitation (see docs/HANDOVER.md): this is an in-memory array, optionally
 * mirrored to an append-only JSON-lines file on disk for local dev. On
 * Vercel's serverless runtime the filesystem is ephemeral and each
 * invocation may be a cold instance, so the in-memory array does not
 * persist across requests in production. This is fine for a skeleton demo
 * (fire fixtures, watch them land within the same dev-server process) but
 * is not a production log store. Production needs a real sink (e.g. a
 * hosted logging service or a database table).
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

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
  memoryLog.unshift(entry);
  if (memoryLog.length > MAX_MEMORY_ENTRIES) memoryLog.length = MAX_MEMORY_ENTRIES;
  logger.info(`event ${entry.outcome}`, {
    clientId: entry.clientId,
    eventType: entry.eventType,
    reason: entry.reason,
    dryRun: entry.dryRun,
  });
  await appendToFile(entry);
}

export async function getEventLog(limit = 100): Promise<EventLogEntry[]> {
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
