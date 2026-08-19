/**
 * Smartlead → CanonicalEvent mapper.
 *
 * [VERIFY] The exact JSON payload shape per event, the signature/verification
 * mechanism, and the webhook-registration endpoint are not confirmed against
 * live Smartlead docs in this pass (brief §6, §14 Milestone 2 explicitly
 * allows building against fixtures when the shape can't be confirmed). The
 * shape below is a reasonable, documented assumption — verify it against
 * https://api.smartlead.ai/api-reference/webhooks/events and
 * helpcenter.smartlead.ai before pointing this at a real Smartlead workspace,
 * and update SmartleadWebhookPayloadSchema + fixtures/smartlead-events/*.json
 * to match whatever the real payloads turn out to be.
 *
 * Deliverability rule (brief §2.3, hard requirement): this app never
 * subscribes to EMAIL_OPEN or EMAIL_LINK_CLICK. They are intentionally
 * absent from SMARTLEAD_EVENT_TYPES below — do not add them back. Open
 * tracking is disabled to protect sender domain reputation.
 */
import { z } from 'zod';
import type { CanonicalEvent, CanonicalEventType } from '../types';

/** The only 7 events this app subscribes to — see brief §6. */
export const SMARTLEAD_EVENT_TYPES = [
  'EMAIL_SENT',
  'FIRST_EMAIL_SENT',
  'EMAIL_REPLY',
  'UNTRACKED_REPLIES',
  'EMAIL_BOUNCE',
  'LEAD_UNSUBSCRIBED',
  'LEAD_CATEGORY_UPDATED',
] as const;

export type SmartleadEventType = (typeof SMARTLEAD_EVENT_TYPES)[number];

// Never register or accept these — see brief §2.3 and §17.2.
const FORBIDDEN_EVENT_TYPES = ['EMAIL_OPEN', 'EMAIL_LINK_CLICK'] as const;

const smartleadLeadSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  email: z.string().email(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  company_name: z.string().optional(),
  job_title: z.string().optional(),
  linkedin_url: z.string().optional(),
  phone_number: z.string().optional(),
});

export const smartleadWebhookPayloadSchema = z.object({
  event_type: z.enum(SMARTLEAD_EVENT_TYPES),
  event_id: z.union([z.string(), z.number()]).optional(),
  event_timestamp: z.string().optional(),
  campaign_id: z.union([z.string(), z.number()]),
  campaign_name: z.string().optional(),
  sequence_number: z.number().optional(),
  subject: z.string().optional(),
  email_body: z.string().optional(),
  bounce_reason: z.string().optional(),
  lead_category: z
    .object({
      id: z.union([z.string(), z.number()]).optional(),
      name: z.string(),
    })
    .optional(),
  lead: smartleadLeadSchema,
});

export type SmartleadWebhookPayload = z.infer<typeof smartleadWebhookPayloadSchema>;

const DIRECT_TYPE_MAP: Partial<Record<SmartleadEventType, CanonicalEventType>> = {
  EMAIL_SENT: 'email_sent',
  FIRST_EMAIL_SENT: 'email_sent',
  EMAIL_REPLY: 'reply',
  UNTRACKED_REPLIES: 'reply',
  EMAIL_BOUNCE: 'bounce',
  LEAD_UNSUBSCRIBED: 'unsubscribe',
  // LEAD_CATEGORY_UPDATED is handled separately — see below.
};

export function assertEventTypeAllowed(eventType: string): void {
  if ((FORBIDDEN_EVENT_TYPES as readonly string[]).includes(eventType)) {
    throw new Error(
      `Refusing to process forbidden Smartlead event "${eventType}" — open/click tracking is ` +
        'disabled deliberately to protect sender domain reputation (brief §2.3). This should ' +
        'never have been registered; check webhook registration config.',
    );
  }
}

function buildEventId(payload: SmartleadWebhookPayload, clientId: string): string {
  if (payload.event_id) return `smartlead:${clientId}:${payload.event_id}`;
  // Fallback idempotency key when Smartlead doesn't supply one: derive a
  // stable key from the fields that make an occurrence unique.
  return `smartlead:${clientId}:${payload.event_type}:${payload.campaign_id}:${payload.lead.email}:${payload.event_timestamp ?? ''}`;
}

/**
 * Pure mapper — no client config, no I/O, fully unit-testable against
 * fixtures. LEAD_CATEGORY_UPDATED always normalises to 'status_change' here;
 * promoting it to 'positive_reply' / 'meeting_booked' based on the client's
 * status map happens in lib/dispatch.ts, since that mapping is per-client
 * and this file must stay client-agnostic.
 */
export function mapSmartleadEventToCanonical(
  payload: SmartleadWebhookPayload,
  clientId: string,
): CanonicalEvent {
  assertEventTypeAllowed(payload.event_type);

  const type: CanonicalEventType =
    payload.event_type === 'LEAD_CATEGORY_UPDATED'
      ? 'status_change'
      : (DIRECT_TYPE_MAP[payload.event_type] ?? 'reply');

  return {
    eventId: buildEventId(payload, clientId),
    occurredAt: payload.event_timestamp ?? new Date(0).toISOString(),
    type,
    clientId,
    source: 'smartlead',
    campaign: {
      id: String(payload.campaign_id),
      name: payload.campaign_name ?? '',
    },
    prospect: {
      email: payload.lead.email.trim().toLowerCase(),
      firstName: payload.lead.first_name,
      lastName: payload.lead.last_name,
      company: payload.lead.company_name,
      title: payload.lead.job_title,
      linkedinUrl: payload.lead.linkedin_url,
      phone: payload.lead.phone_number,
    },
    detail: {
      sequenceStep: payload.sequence_number,
      subject: payload.subject,
      bodyPreview: payload.email_body?.slice(0, 2000),
      category: payload.lead_category?.name,
      bounceReason: payload.bounce_reason,
    },
    raw: payload,
  };
}
