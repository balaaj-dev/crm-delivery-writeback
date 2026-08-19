import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertEventTypeAllowed,
  mapSmartleadEventToCanonical,
  smartleadWebhookPayloadSchema,
} from '@/lib/sources/smartlead';

function loadFixture(name: string) {
  const raw = readFileSync(
    path.join(process.cwd(), 'fixtures', 'smartlead-events', name),
    'utf8',
  );
  return smartleadWebhookPayloadSchema.parse(JSON.parse(raw));
}

describe('mapSmartleadEventToCanonical — one fixture per approved event type', () => {
  it('maps EMAIL_SENT to email_sent', () => {
    const event = mapSmartleadEventToCanonical(loadFixture('email-sent.json'), 'rec_test');
    expect(event.type).toBe('email_sent');
    expect(event.prospect.email).toBe('jordan.blake@example.com');
  });

  it('maps FIRST_EMAIL_SENT to email_sent', () => {
    const event = mapSmartleadEventToCanonical(loadFixture('first-email-sent.json'), 'rec_test');
    expect(event.type).toBe('email_sent');
    expect(event.detail.sequenceStep).toBe(1);
  });

  it('maps EMAIL_REPLY to reply', () => {
    const event = mapSmartleadEventToCanonical(loadFixture('email-reply.json'), 'rec_test');
    expect(event.type).toBe('reply');
  });

  it('maps UNTRACKED_REPLIES to reply', () => {
    const event = mapSmartleadEventToCanonical(loadFixture('untracked-replies.json'), 'rec_test');
    expect(event.type).toBe('reply');
  });

  it('maps EMAIL_BOUNCE to bounce, carrying the bounce reason', () => {
    const event = mapSmartleadEventToCanonical(loadFixture('email-bounce.json'), 'rec_test');
    expect(event.type).toBe('bounce');
    expect(event.detail.bounceReason).toContain('no such user');
  });

  it('maps LEAD_UNSUBSCRIBED to unsubscribe', () => {
    const event = mapSmartleadEventToCanonical(loadFixture('lead-unsubscribed.json'), 'rec_test');
    expect(event.type).toBe('unsubscribe');
  });

  it('maps LEAD_CATEGORY_UPDATED to status_change, carrying the raw category', () => {
    const event = mapSmartleadEventToCanonical(
      loadFixture('lead-category-updated-interested.json'),
      'rec_test',
    );
    expect(event.type).toBe('status_change');
    expect(event.detail.category).toBe('Interested');
  });

  it('the Meeting Booked category fixture also normalises to status_change', () => {
    const event = mapSmartleadEventToCanonical(
      loadFixture('lead-category-updated-meeting-booked.json'),
      'rec_test',
    );
    expect(event.type).toBe('status_change');
    expect(event.detail.category).toBe('Meeting Booked');
  });

  it('lowercases and trims the prospect email as the match key', () => {
    const payload = { ...loadFixture('email-sent.json'), lead: { ...loadFixture('email-sent.json').lead, email: '  Jordan.Blake@Example.com  '.trim() } };
    const event = mapSmartleadEventToCanonical(payload, 'rec_test');
    expect(event.prospect.email).toBe('jordan.blake@example.com');
  });
});

describe('deliverability rule — EMAIL_OPEN / EMAIL_LINK_CLICK must never be processed', () => {
  it('rejects EMAIL_OPEN', () => {
    expect(() => assertEventTypeAllowed('EMAIL_OPEN')).toThrow();
  });

  it('rejects EMAIL_LINK_CLICK', () => {
    expect(() => assertEventTypeAllowed('EMAIL_LINK_CLICK')).toThrow();
  });

  it('the webhook payload schema itself has no enum member for either forbidden event', () => {
    const result = smartleadWebhookPayloadSchema.safeParse({
      ...loadFixture('email-sent.json'),
      event_type: 'EMAIL_OPEN',
    });
    expect(result.success).toBe(false);
  });
});
