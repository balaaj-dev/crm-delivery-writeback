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

async function loadFixtureClients(): Promise<ClientConfig[]> {
  const fixturePath = path.join(process.cwd(), 'fixtures', 'clients.json');
  const raw = await readFile(fixturePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('fixtures/clients.json must be a JSON array of ClientConfig objects');
  }
  return parsed.map((entry) => clientConfigSchema.parse(entry) as ClientConfig);
}

export async function listClientConfigs(): Promise<ClientConfig[]> {
  return configSource() === 'airtable' ? listClientConfigsFromAirtable() : loadFixtureClients();
}

export async function getClientConfig(clientId: string): Promise<ClientConfig | null> {
  const clients = await listClientConfigs();
  return clients.find((c) => c.clientId === clientId) ?? null;
}
