import { beforeEach, describe, expect, it } from 'vitest';
import { dispatchEvent, resolveEffectiveEventType, resetDealDedupeStore } from '@/lib/dispatch';
import { resetIdempotencyStore } from '@/lib/idempotency';
import { mockAdapter, resetMockAdapterState } from '@/lib/adapters/mock';
import type { CanonicalEvent, ClientConfig } from '@/lib/types';

function baseConfig(overrides: Partial<ClientConfig> = {}): ClientConfig {
  return {
    clientId: 'rec_test',
    clientName: 'Test Client',
    activated: true,
    mode: 'partial',
    source: { platform: 'smartlead', apiKey: 'sl_test_key' },
    crm: { type: 'hubspot', integrationPath: 'native', credentials: {} },
    behaviour: {
      createRecordOnInterestedReply: true,
      createRecordForAllLeads: false,
      createDeal: false,
      planLimitAcknowledged: false,
    },
    events: {
      email_sent: false,
      reply: true,
      positive_reply: true,
      bounce: true,
      unsubscribe: true,
      status_change: true,
      meeting_booked: true,
    },
    fieldMap: [],
    statusMap: { Interested: 'positive_reply', 'Meeting Booked': 'meeting_booked' },
    notifications: {},
    ...overrides,
  };
}

let eventCounter = 0;
function baseEvent(overrides: Partial<CanonicalEvent> = {}): CanonicalEvent {
  eventCounter += 1;
  return {
    eventId: `evt_${eventCounter}`,
    occurredAt: '2026-08-19T00:00:00.000Z',
    type: 'reply',
    clientId: 'rec_test',
    source: 'smartlead',
    campaign: { id: 'camp_1', name: 'Test Campaign' },
    prospect: { email: `unseeded-${eventCounter}@example.com` },
    detail: {},
    raw: {},
    ...overrides,
  };
}

beforeEach(() => {
  resetMockAdapterState();
  resetIdempotencyStore();
  resetDealDedupeStore();
});

describe('dispatchEvent — skip branches', () => {
  it('skips when the client is not activated', async () => {
    const outcome = await dispatchEvent(baseEvent(), baseConfig({ activated: false }), mockAdapter);
    expect(outcome).toEqual({ status: 'skip', reason: 'not_activated' });
  });

  it('skips when the event type is disabled for this client', async () => {
    const cfg = baseConfig({ events: { ...baseConfig().events, reply: false } });
    const outcome = await dispatchEvent(baseEvent({ type: 'reply' }), cfg, mockAdapter);
    expect(outcome).toEqual({ status: 'skip', reason: 'event_disabled' });
  });

  it('skips when the campaign is out of scope', async () => {
    const cfg = baseConfig({ source: { platform: 'smartlead', apiKey: 'x', campaignIds: ['camp_other'] } });
    const outcome = await dispatchEvent(baseEvent({ campaign: { id: 'camp_1', name: 'x' } }), cfg, mockAdapter);
    expect(outcome).toEqual({ status: 'skip', reason: 'campaign_not_in_scope' });
  });

  it('skips a duplicate eventId on the second delivery', async () => {
    const cfg = baseConfig();
    // Seeded email so the first delivery succeeds via the "found" branch,
    // isolating this test to idempotency rather than create-policy.
    const event = baseEvent({ prospect: { email: 'jordan.blake@example.com' } });
    const first = await dispatchEvent(event, cfg, mockAdapter);
    expect(first.status).toBe('success');
    const second = await dispatchEvent(event, cfg, mockAdapter);
    expect(second).toEqual({ status: 'skip', reason: 'duplicate' });
  });

  it('skips no_record_no_create_policy in partial mode for a non-interested event with no existing record', async () => {
    const cfg = baseConfig({
      behaviour: {
        createRecordOnInterestedReply: true,
        createRecordForAllLeads: false,
        createDeal: false,
        planLimitAcknowledged: false,
      },
    });
    const outcome = await dispatchEvent(baseEvent({ type: 'reply' }), cfg, mockAdapter);
    expect(outcome).toEqual({ status: 'skip', reason: 'no_record_no_create_policy' });
  });
});

describe('dispatchEvent — success branches', () => {
  it('writes activity against an existing record without creating a new one', async () => {
    const cfg = baseConfig();
    const event = baseEvent({ type: 'reply', prospect: { email: 'jordan.blake@example.com' } });
    const outcome = await dispatchEvent(event, cfg, mockAdapter);
    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.actions).not.toContain('created_record');
      expect(outcome.actions).toContain('wrote_activity');
    }
  });

  it('creates a record on a positive_reply when createRecordOnInterestedReply is true', async () => {
    const cfg = baseConfig();
    const event = baseEvent({ type: 'positive_reply' });
    const outcome = await dispatchEvent(event, cfg, mockAdapter);
    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.actions).toContain('created_record');
    }
  });

  it('creates a record for any lead in full mode when planLimitAcknowledged is true', async () => {
    const cfg = baseConfig({
      mode: 'full',
      behaviour: {
        createRecordOnInterestedReply: true,
        createRecordForAllLeads: true,
        createDeal: false,
        planLimitAcknowledged: true,
      },
    });
    const outcome = await dispatchEvent(baseEvent({ type: 'reply' }), cfg, mockAdapter);
    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.actions).toContain('created_record');
    }
  });

  it('applies the status map when the event carries a matching category', async () => {
    const cfg = baseConfig();
    const event = baseEvent({
      type: 'status_change',
      detail: { category: 'Interested' },
    });
    const outcome = await dispatchEvent(event, cfg, mockAdapter);
    expect(outcome.status).toBe('success');
    if (outcome.status === 'success') {
      expect(outcome.actions).toContain('updated_status:positive_reply');
    }
  });

  it('creates a deal only once across repeated positive signals for the same record', async () => {
    const cfg = baseConfig({
      behaviour: {
        createRecordOnInterestedReply: true,
        createRecordForAllLeads: false,
        createDeal: true,
        planLimitAcknowledged: false,
      },
    });
    const email = 'deal-target@example.com';
    const first = await dispatchEvent(baseEvent({ type: 'positive_reply', prospect: { email } }), cfg, mockAdapter);
    const second = await dispatchEvent(baseEvent({ type: 'meeting_booked', prospect: { email } }), cfg, mockAdapter);

    expect(first.status).toBe('success');
    expect(second.status).toBe('success');
    if (first.status === 'success') expect(first.actions).toContain('created_deal');
    if (second.status === 'success') expect(second.actions).not.toContain('created_deal');
  });
});

describe('dispatchEvent — error handling', () => {
  it('logs an error outcome when the adapter throws', async () => {
    const cfg = baseConfig();
    const throwingAdapter = {
      ...mockAdapter,
      findRecord: async () => {
        throw new Error('boom');
      },
    };
    const outcome = await dispatchEvent(baseEvent(), cfg, throwingAdapter);
    expect(outcome.status).toBe('error');
    if (outcome.status === 'error') expect(outcome.reason).toContain('boom');
  });
});

describe('resolveEffectiveEventType', () => {
  it('promotes status_change to positive_reply when the status map says so', () => {
    const cfg = baseConfig();
    const event = baseEvent({ type: 'status_change', detail: { category: 'Interested' } });
    expect(resolveEffectiveEventType(event, cfg)).toBe('positive_reply');
  });

  it('leaves status_change alone when the mapped value is not a promotable type', () => {
    const cfg = baseConfig({ statusMap: { 'Not Interested': 'closed_lost' } });
    const event = baseEvent({ type: 'status_change', detail: { category: 'Not Interested' } });
    expect(resolveEffectiveEventType(event, cfg)).toBe('status_change');
  });

  it('leaves non-status_change events untouched', () => {
    const cfg = baseConfig();
    const event = baseEvent({ type: 'bounce' });
    expect(resolveEffectiveEventType(event, cfg)).toBe('bounce');
  });
});
