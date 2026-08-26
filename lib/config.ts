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
 * This is backed by a local JSON file, not an in-memory Map — confirmed
 * live (25 Aug 2026) that an in-memory Map here does NOT reliably work:
 * Next.js dev mode compiles different API route files as separate on-demand
 * bundles, and each got its own independent instance of this module's
 * top-level state, so a Map set by the PUT route was invisible to
 * /api/webhooks/smartlead's route. A real production deployment would have
 * the same problem for a different reason — Vercel typically runs each API
 * route as its own serverless function, so in-memory state is never shared
 * across routes there either. The filesystem doesn't have that problem: any
 * route reading/writing the same path sees the same data. Same "resets on a
 * fresh checkout / doesn't survive Vercel's read-only fs" limitation as
 * lib/log.ts's file mirror — intentional, documented, not a production
 * persistence layer. Gitignored — see .gitignore's /data/ entry.
 */
const OVERRIDES_FILE_PATH = path.join(process.cwd(), 'data', 'client-overrides.json');

async function readOverrides(): Promise<Record<string, ClientConfig>> {
  try {
    const raw = await readFile(OVERRIDES_FILE_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, ClientConfig>;
  } catch {
    return {};
  }
}

export async function setSessionOverride(config: ClientConfig): Promise<void> {
  try {
    const overrides = await readOverrides();
    overrides[config.clientId] = config;
    await mkdir(path.dirname(OVERRIDES_FILE_PATH), { recursive: true });
    await writeFile(OVERRIDES_FILE_PATH, JSON.stringify(overrides, null, 2), 'utf8');
  } catch (err) {
    // Read-only filesystem (e.g. Vercel) — same fallback as lib/log.ts.
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
