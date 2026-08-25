import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverCampaignLeads } from '@/lib/delivery';
import { mockAdapter, resetMockAdapterState } from '@/lib/adapters/mock';
import type { ClientConfig } from '@/lib/types';

vi.mock('@/lib/sources/smartlead-api', () => ({
  listCampaignLeads: vi.fn(),
}));

import { listCampaignLeads } from '@/lib/sources/smartlead-api';

const cfg: ClientConfig = {
  clientId: 'rec_test',
  clientName: 'Test',
  activated: true,
  mode: 'full',
  source: { platform: 'smartlead', apiKey: 'test-key' },
  crm: { type: 'hubspot', integrationPath: 'native', credentials: {} },
  behaviour: {
    createRecordOnInterestedReply: true,
    createRecordForAllLeads: true,
    createDeal: false,
    planLimitAcknowledged: true,
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
  vi.mocked(listCampaignLeads).mockReset();
});

describe('deliverCampaignLeads', () => {
  it('creates a record for a new lead and reports it as created', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 1,
      leads: [{ email: 'brand-new-lead@example.com', firstName: 'Brand', lastName: 'New' }],
    });

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 25);

    expect(result.processed).toBe(1);
    expect(result.created).toBe(1);
    expect(result.alreadyExisted).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(result.cappedAt).toBeUndefined();
  });

  it('skips a lead that already exists in the CRM instead of creating a duplicate', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 1,
      // Seeded in the mock adapter — see lib/adapters/mock.ts.
      leads: [{ email: 'jordan.blake@example.com', firstName: 'Jordan', lastName: 'Blake' }],
    });

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 25);

    expect(result.created).toBe(0);
    expect(result.alreadyExisted).toBe(1);
  });

  it('reports cappedAt when the campaign has more leads than the requested max', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 500,
      leads: [{ email: 'one-of-many@example.com' }],
    });

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 1);

    expect(result.totalLeadsInCampaign).toBe(500);
    expect(result.cappedAt).toBe(1);
  });

  it('records a per-lead error without aborting the rest of the batch', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 2,
      leads: [
        { email: 'will-fail@example.com', firstName: 'Will' },
        { email: 'will-succeed@example.com', firstName: 'Succeed' },
      ],
    });
    const failingAdapter = {
      ...mockAdapter,
      findRecord: async (email: string, c: ClientConfig) =>
        email === 'will-fail@example.com'
          ? Promise.reject(new Error('simulated lookup failure'))
          : mockAdapter.findRecord(email, c),
    };

    const result = await deliverCampaignLeads(cfg, failingAdapter, 'camp_1', 25);

    expect(result.processed).toBe(2);
    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      email: 'will-fail@example.com',
      reason: expect.stringContaining('simulated lookup failure'),
    });
  });
});
