/**
 * Single entry point for "give me the list of client configs" and "give me
 * one client's config". Switches between fixtures and live Airtable via
 * CONFIG_SOURCE so every route/adapter caller stays agnostic to where the
 * config actually comes from.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ClientConfig } from './types';
import { clientConfigSchema } from './schemas';
import { listClientConfigsFromAirtable } from './airtable';
import { logger } from './log';
import { encryptRecord, decryptRecord } from './crypto';
import { kvAvailable, kvGetAllByPrefix, kvSet } from './kv';

export type ConfigSource = 'fixtures' | 'airtable';

export function configSource(): ConfigSource {
  const raw = (process.env.CONFIG_SOURCE ?? 'fixtures').toLowerCase();
  return raw === 'airtable' ? 'airtable' : 'fixtures';
}

/**
 * Testing-only override: fixtures/clients.json is committed to git, so a
 * real credential must never be written into it. Setting
 * HUBSPOT_TEST_ACCESS_TOKEN in a local, gitignored .env.local instead
 * substitutes a real HubSpot Private App token onto every fixture client
 * whose crm.type is 'hubspot', purely in memory for this process. Unset
 * (the default) — no behaviour change at all.
 */
function applyTestCredentialOverrides(clients: ClientConfig[]): ClientConfig[] {
  const hubspotToken = process.env.HUBSPOT_TEST_ACCESS_TOKEN;
  if (!hubspotToken) return clients;
  return clients.map((c) =>
    c.crm.type === 'hubspot'
      ? { ...c, crm: { ...c.crm, credentials: { ...c.crm.credentials, accessToken: hubspotToken } } }
      : c,
  );
}

async function loadFixtureClients(): Promise<ClientConfig[]> {
  const fixturePath = path.join(process.cwd(), 'fixtures', 'clients.json');
  const raw = await readFile(fixturePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('fixtures/clients.json must be a JSON array of ClientConfig objects');
  }
  const clients = parsed.map((entry) => clientConfigSchema.parse(entry) as ClientConfig);
  return applyTestCredentialOverrides(clients);
}

/**
 * "Did the wizard just save this?" layer, applied on top of whichever
 * source (fixtures or Airtable) is configured.
 *
 * Real gap this fixes: neither fixtures.json (a static committed file) nor
 * Airtable (writeClientConfigToAirtable is a stub until the §5.2 fields
 * exist — see docs/AIRTABLE-FIELDS.md) can actually persist what the wizard
 * configures today. Without this, PUT /api/clients/[id]/config would
 * silently no-op and the very next "fire a test event" step in the wizard
 * would run against stale data — confirmed live: a deal-stage choice made
 * in the wizard was completely ignored by the test event that followed it.
 *
 * Backed by Upstash Redis (lib/kv.ts) when available — added 27 Aug 2026
 * after confirming live that the previous local-JSON-file version silently
 * lost every override on Vercel (its own write failure was caught and
 * logged, not surfaced, so PUT requests reported success while nothing
 * actually persisted). Falls back to the local file when no KV store is
 * connected (i.e. local dev — same behavior as before, unchanged) — see
 * lib/kv.ts's header for why an in-memory Map doesn't work in either
 * environment. Gitignored file path — see .gitignore's /data/ entry.
 */
const OVERRIDES_FILE_PATH = path.join(process.cwd(), 'data', 'client-overrides.json');
const CLIENT_OVERRIDE_KV_PREFIX = 'client-override:';

/** Raw shape — credentials still encrypted. Never hand this to a caller directly. */
async function readOverridesRaw(): Promise<Record<string, ClientConfig>> {
  if (kvAvailable()) {
    return kvGetAllByPrefix<ClientConfig>(CLIENT_OVERRIDE_KV_PREFIX);
  }
  try {
    const raw = await readFile(OVERRIDES_FILE_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, ClientConfig>;
  } catch {
    return {};
  }
}

/** Decrypts every entry's crm.credentials for in-memory use — see lib/crypto.ts. */
async function readOverrides(): Promise<Record<string, ClientConfig>> {
  const overrides = await readOverridesRaw();
  for (const cfg of Object.values(overrides)) {
    cfg.crm.credentials = decryptRecord(cfg.crm.credentials);
  }
  return overrides;
}

/** Encrypts crm.credentials before it ever touches KV or disk (lib/crypto.ts). */
export async function setSessionOverride(config: ClientConfig): Promise<void> {
  const encrypted: ClientConfig = {
    ...config,
    crm: { ...config.crm, credentials: encryptRecord(config.crm.credentials) },
  };

  if (kvAvailable()) {
    await kvSet(`${CLIENT_OVERRIDE_KV_PREFIX}${config.clientId}`, encrypted);
    return;
  }

  try {
    // File path only: read-modify-write the whole blob, since one file holds
    // every client. KV path above writes just this one key — no read needed.
    const overrides = await readOverridesRaw();
    overrides[config.clientId] = encrypted;
    await mkdir(path.dirname(OVERRIDES_FILE_PATH), { recursive: true });
    await writeFile(OVERRIDES_FILE_PATH, JSON.stringify(overrides, null, 2), 'utf8');
  } catch (err) {
    // Read-only filesystem and no KV connected — same fallback as lib/log.ts.
    logger.debug('client-overrides file write skipped (read-only or unavailable fs)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function applySessionOverrides(clients: ClientConfig[]): Promise<ClientConfig[]> {
  const overrides = await readOverrides();
  const overridden = clients.map((c) => overrides[c.clientId] ?? c);
  // A session override for a clientId not already in the base list (e.g. a
  // real Airtable client whose Status isn't "Active" yet, being exercised
  // for a supervised test run) previously vanished silently — `.map` only
  // ever replaces existing entries, never adds new ones. Appending any
  // override that didn't match makes the override usable on its own, which
  // is the whole point of this being a testing-only mechanism in the first
  // place.
  const knownIds = new Set(clients.map((c) => c.clientId));
  const extraOverrides = Object.values(overrides).filter((c) => !knownIds.has(c.clientId));
  return [...overridden, ...extraOverrides];
}

export async function listClientConfigs(): Promise<ClientConfig[]> {
  const clients =
    configSource() === 'airtable' ? await listClientConfigsFromAirtable() : await loadFixtureClients();
  return applySessionOverrides(clients);
}

export async function getClientConfig(clientId: string): Promise<ClientConfig | null> {
  const clients = await listClientConfigs();
  return clients.find((c) => c.clientId === clientId) ?? null;
}
