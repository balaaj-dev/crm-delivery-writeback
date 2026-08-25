/**
 * Single entry point for "give me the list of client configs" and "give me
 * one client's config". Switches between fixtures and live Airtable via
 * CONFIG_SOURCE so every route/adapter caller stays agnostic to where the
 * config actually comes from.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClientConfig } from './types';
import { clientConfigSchema } from './schemas';
import { listClientConfigsFromAirtable } from './airtable';

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

export async function listClientConfigs(): Promise<ClientConfig[]> {
  return configSource() === 'airtable' ? listClientConfigsFromAirtable() : loadFixtureClients();
}

export async function getClientConfig(clientId: string): Promise<ClientConfig | null> {
  const clients = await listClientConfigs();
  return clients.find((c) => c.clientId === clientId) ?? null;
}
