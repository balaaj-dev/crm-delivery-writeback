/**
 * Thin wrapper around Upstash Redis (the store behind Vercel's KV/Redis
 * marketplace integration) — added 27 Aug 2026 to fix a real, confirmed-live
 * gap: lib/config.ts's session overrides and lib/jobs.ts's delivery-job
 * records were both backed by local JSON files under data/, which silently
 * no-op (config.ts) or throw outright (jobs.ts) on Vercel's read-only
 * filesystem. Confirmed live: a client activated through the wizard on
 * Vercel was gone by the very next request, and "Deliver contacts" failed
 * outright with "Could not start any delivery jobs".
 *
 * Every caller checks kvAvailable() first and falls back to the local file
 * when it's false — this keeps local dev exactly as it was (no KV env vars
 * set locally, same file-backed behavior), while Vercel (where
 * KV_REST_API_URL/KV_REST_API_TOKEN are set once the Redis integration is
 * connected) gets real cross-request persistence.
 */
import { Redis } from '@upstash/redis';

let client: Redis | null | undefined;

function getClient(): Redis | null {
  if (client !== undefined) return client;
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  client = url && token ? new Redis({ url, token }) : null;
  return client;
}

export function kvAvailable(): boolean {
  return getClient() !== null;
}

export async function kvGet<T>(key: string): Promise<T | null> {
  const c = getClient();
  if (!c) return null;
  return (await c.get<T>(key)) ?? null;
}

export async function kvSet<T>(key: string, value: T): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.set(key, value);
}

export async function kvDel(key: string): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.del(key);
}

/** Every value stored under a given key prefix, keyed by the suffix (the part after the prefix). */
export async function kvGetAllByPrefix<T>(prefix: string): Promise<Record<string, T>> {
  const c = getClient();
  if (!c) return {};
  const keys = await c.keys(`${prefix}*`);
  if (keys.length === 0) return {};
  const values = await c.mget<T[]>(...keys);
  const result: Record<string, T> = {};
  keys.forEach((key, i) => {
    const value = values[i];
    if (value != null) result[key.slice(prefix.length)] = value;
  });
  return result;
}

/**
 * Atomically sets key only if it doesn't already exist, with a TTL — used
 * for idempotency claims (lib/idempotency.ts). Returns true if this call
 * newly claimed it (first time), false if it already existed (a duplicate).
 * Callers check kvAvailable() first; if somehow called without a client,
 * fails open (returns true / "go ahead") rather than silently blocking
 * every event, consistent with this app's other safety defaults.
 */
export async function kvSetNX(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  const c = getClient();
  if (!c) return true;
  const result = await c.set(key, value, { nx: true, ex: ttlSeconds });
  return result === 'OK';
}

/** Push a value onto the head of a list, then trim it to maxLen — used for the KV-backed event log and raw-webhook capture (both bounded, newest-first lists). */
export async function kvListPush<T>(key: string, value: T, maxLen: number): Promise<void> {
  const c = getClient();
  if (!c) return;
  await c.lpush(key, value);
  await c.ltrim(key, 0, maxLen - 1);
}

export async function kvListRange<T>(key: string, start: number, stop: number): Promise<T[]> {
  const c = getClient();
  if (!c) return [];
  return (await c.lrange<T>(key, start, stop)) ?? [];
}
