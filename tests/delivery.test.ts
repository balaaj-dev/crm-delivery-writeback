import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverCampaignLeads } from '@/lib/delivery';
import { mockAdapter, resetMockAdapterState } from '@/lib/adapters/mock';
import type { ClientConfig } from '@/lib/types';

vi.mock('@/lib/sources/smartlead-api', () => ({
  listCampaignLeads: vi.fn(),
  listLeadMessageHistory: vi.fn(),
  resolveInterestCategoryIds: vi.fn(),
}));

import {
  listCampaignLeads,
  listLeadMessageHistory,
  resolveInterestCategoryIds,
} from '@/lib/sources/smartlead-api';

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
  vi.mocked(listLeadMessageHistory).mockReset();
  vi.mocked(resolveInterestCategoryIds).mockReset();
  // Default: no history, so tests that don't care about activity backfill
  // don't need to stub it explicitly every time.
  vi.mocked(listLeadMessageHistory).mockResolvedValue([]);
});

describe('deliverCampaignLeads', () => {
  it('creates a record for a new lead and reports it as created', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 1,
      leads: [{ id: 'sl_1', email: 'brand-new-lead@example.com', firstName: 'Brand', lastName: 'New' }],
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
      leads: [{ id: 'sl_2', email: 'jordan.blake@example.com', firstName: 'Jordan', lastName: 'Blake' }],
    });

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 25);

    expect(result.created).toBe(0);
    expect(result.alreadyExisted).toBe(1);
  });

  it('reports cappedAt when the campaign has more leads than the requested max', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 500,
      leads: [{ id: 'sl_3', email: 'one-of-many@example.com' }],
    });

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 1);

    expect(result.totalLeadsInCampaign).toBe(500);
    expect(result.cappedAt).toBe(1);
  });

  it('records a per-lead error without aborting the rest of the batch', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 2,
      leads: [
        { id: 'sl_4', email: 'will-fail@example.com', firstName: 'Will' },
        { id: 'sl_5', email: 'will-succeed@example.com', firstName: 'Succeed' },
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

  it('backfills status and real message history as activity for every processed lead', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 1,
      leads: [
        {
          id: 'sl_6',
          email: 'jordan.blake@example.com', // already exists — still backfilled
          sequenceStatus: 'INPROGRESS',
        },
      ],
    });
    vi.mocked(listLeadMessageHistory).mockResolvedValue([
      { type: 'SENT', subject: 'Hi there', body: 'First touch', time: '2026-08-18T19:00:00.000Z' },
      { type: 'REPLY', subject: 'RE: Hi there', body: 'Sure, interested', time: '2026-08-19T10:00:00.000Z' },
    ]);

    const writeActivitySpy = vi.spyOn(mockAdapter, 'writeActivity');
    const updateStatusSpy = vi.spyOn(mockAdapter, 'updateStatus');

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 25);

    expect(result.alreadyExisted).toBe(1);
    expect(result.activitiesLogged).toBe(2);
    expect(writeActivitySpy).toHaveBeenCalledTimes(2);
    expect(updateStatusSpy).toHaveBeenCalledWith(
      expect.anything(),
      'delivered_inprogress',
      expect.anything(),
    );

    writeActivitySpy.mockRestore();
    updateStatusSpy.mockRestore();
  });

  it('does not fail the whole lead when activity backfill throws', async () => {
    vi.mocked(listCampaignLeads).mockResolvedValue({
      totalLeads: 1,
      leads: [{ id: 'sl_7', email: 'resilient-lead@example.com', firstName: 'Resilient' }],
    });
    vi.mocked(listLeadMessageHistory).mockRejectedValue(new Error('message-history endpoint down'));

    const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 25);

    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(result.activitiesLogged).toBe(0);
  });

  describe('partial mode — interest-category filtering', () => {
    const partialCfg: ClientConfig = {
      ...cfg,
      mode: 'partial',
      statusMap: {
        Interested: 'positive_reply',
        'Meeting Booked': 'meeting_booked',
        'Not Interested': 'closed_lost',
      },
    };

    it('only delivers leads whose live category maps to positive_reply/meeting_booked — real incident regression (Tracie Cranford, 25 Aug 2026): a bounced, never-replied lead was wrongly delivered and marked a Lead', async () => {
      vi.mocked(resolveInterestCategoryIds).mockResolvedValue(new Set([1, 2])); // Interested=1, Meeting Booked=2
      vi.mocked(listCampaignLeads).mockResolvedValue({
        totalLeads: 3,
        leads: [
          { id: 'sl_10', email: 'interested@example.com', leadCategoryId: 1 },
          { id: 'sl_11', email: 'never-replied-bounced@example.com', leadCategoryId: null },
          { id: 'sl_12', email: 'not-interested@example.com', leadCategoryId: 9 },
        ],
      });

      const result = await deliverCampaignLeads(partialCfg, mockAdapter, 'camp_1', 25);

      expect(result.processed).toBe(1);
      expect(result.created).toBe(1);
      expect(result.skippedNotInterested).toBe(2);
      expect(await mockAdapter.findRecord('never-replied-bounced@example.com', partialCfg)).toBeNull();
      expect(await mockAdapter.findRecord('not-interested@example.com', partialCfg)).toBeNull();
    });

    it('delivers every lead in full mode regardless of category (unchanged behaviour)', async () => {
      vi.mocked(listCampaignLeads).mockResolvedValue({
        totalLeads: 2,
        leads: [
          { id: 'sl_13', email: 'no-category-a@example.com', leadCategoryId: null },
          { id: 'sl_14', email: 'no-category-b@example.com', leadCategoryId: null },
        ],
      });

      const result = await deliverCampaignLeads(cfg, mockAdapter, 'camp_1', 25); // cfg.mode === 'full'

      expect(resolveInterestCategoryIds).not.toHaveBeenCalled();
      expect(result.processed).toBe(2);
      expect(result.created).toBe(2);
      expect(result.skippedNotInterested).toBe(0);
    });

    it('refuses to deliver rather than risk over-delivering when the category lookup itself fails', async () => {
      vi.mocked(resolveInterestCategoryIds).mockRejectedValue(new Error('categories endpoint down'));
      vi.mocked(listCampaignLeads).mockResolvedValue({
        totalLeads: 1,
        leads: [{ id: 'sl_15', email: 'someone@example.com', leadCategoryId: 1 }],
      });

      await expect(deliverCampaignLeads(partialCfg, mockAdapter, 'camp_1', 25)).rejects.toThrow(
        'categories endpoint down',
      );
    });
  });
});
