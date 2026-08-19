import { beforeEach, describe, expect, it } from 'vitest';
import { mockAdapter, resetMockAdapterState } from '@/lib/adapters/mock';
import { salesforceOutboundSyncAdapter } from '@/lib/adapters/salesforce-outboundsync';
import { ADAPTER_REGISTRY } from '@/lib/adapters/index';
import { NotImplementedError, type ClientConfig } from '@/lib/types';

const cfg: ClientConfig = {
  clientId: 'rec_test',
  clientName: 'Test',
  activated: true,
  mode: 'partial',
  source: { platform: 'smartlead', apiKey: 'x' },
  crm: { type: 'salesforce', integrationPath: 'outboundsync', credentials: {} },
  behaviour: {
    createRecordOnInterestedReply: true,
    createRecordForAllLeads: false,
    createDeal: false,
    planLimitAcknowledged: false,
  },
  events: {
    email_sent: true,
    reply: true,
    positive_reply: true,
    bounce: true,
    unsubscribe: true,
    status_change: true,
    meeting_booked: true,
  },
  fieldMap: [],
  statusMap: {},
  notifications: {},
};

beforeEach(() => {
  resetMockAdapterState();
});

describe('mock adapter — CrmAdapter contract', () => {
  it('finds a seeded contact by email', async () => {
    const ref = await mockAdapter.findRecord('jordan.blake@example.com', cfg);
    expect(ref).not.toBeNull();
  });

  it('returns null for an unseeded email', async () => {
    const ref = await mockAdapter.findRecord('nobody@nowhere.example.com', cfg);
    expect(ref).toBeNull();
  });

  it('creates a new record for an unseeded email and can then find it', async () => {
    const event = {
      eventId: 'e1',
      occurredAt: '2026-08-19T00:00:00.000Z',
      type: 'positive_reply' as const,
      clientId: 'rec_test',
      source: 'smartlead' as const,
      campaign: { id: 'c1', name: 'Campaign' },
      prospect: { email: 'new-person@example.com', firstName: 'New' },
      detail: {},
      raw: {},
    };
    const ref = await mockAdapter.createRecord(event, cfg);
    expect(ref.objectType).toBe('contact');
    const found = await mockAdapter.findRecord('new-person@example.com', cfg);
    expect(found?.id).toBe(ref.id);
  });

  it('testConnection always succeeds', async () => {
    const result = await mockAdapter.testConnection(cfg);
    expect(result.ok).toBe(true);
  });
});

describe('Salesforce stub adapter', () => {
  it('throws NotImplementedError from every mutating method', async () => {
    await expect(salesforceOutboundSyncAdapter.findRecord('a@b.com', cfg)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(salesforceOutboundSyncAdapter.updateStatus({ objectType: 'contact', id: '1' }, 'x', cfg)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('testConnection reports the OutboundSync add-on requirement instead of throwing', async () => {
    const result = await salesforceOutboundSyncAdapter.testConnection(cfg);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('OutboundSync');
  });
});

describe('adapter registry', () => {
  it('registers exactly the 7 CRM types', () => {
    expect(Object.keys(ADAPTER_REGISTRY).sort()).toEqual(
      ['attio', 'gohighlevel', 'hubspot', 'insightly', 'pipedrive', 'salesforce', 'zoho'].sort(),
    );
  });

  it('a not-yet-built CRM adapter throws NotImplementedError rather than silently succeeding', async () => {
    const adapter = ADAPTER_REGISTRY.pipedrive();
    await expect(adapter.findRecord('a@b.com', cfg)).rejects.toBeInstanceOf(NotImplementedError);
  });
});
