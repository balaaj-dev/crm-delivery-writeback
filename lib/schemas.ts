/**
 * Zod schemas for anything crossing a trust boundary: fixtures, Airtable
 * records, webhook bodies, form posts. Internal function calls trust
 * lib/types.ts directly and do not need to re-validate.
 */
import { z } from 'zod';
import { CANONICAL_EVENT_TYPES, CRM_TYPES } from './types';

const canonicalEventTypeSchema = z.enum(
  CANONICAL_EVENT_TYPES as [string, ...string[]],
) as z.ZodType<(typeof CANONICAL_EVENT_TYPES)[number]>;

const crmTypeSchema = z.enum(CRM_TYPES as [string, ...string[]]) as z.ZodType<
  (typeof CRM_TYPES)[number]
>;

export const fieldMappingSchema = z.object({
  canonical: z.string().min(1),
  crmObject: z.string().min(1),
  crmField: z.string().min(1),
  direction: z.enum(['in', 'out', 'both']),
});

export const clientConfigSchema = z.object({
  clientId: z.string().min(1),
  clientName: z.string().min(1),
  activated: z.boolean(),
  mode: z.enum(['partial', 'full']),

  source: z.object({
    platform: z.literal('smartlead'),
    apiKey: z.string().min(1),
    smartleadClientId: z.string().optional(),
    campaignIds: z.array(z.string()).optional(),
    webhookSecret: z.string().optional(),
    smartleadWebhookId: z.number().optional(),
  }),

  crm: z.object({
    type: crmTypeSchema,
    integrationPath: z.enum(['native', 'outboundsync']),
    credentials: z.record(z.string()),
  }),

  behaviour: z.object({
    createRecordOnInterestedReply: z.boolean(),
    createRecordForAllLeads: z.boolean(),
    createDeal: z.boolean(),
    dealStageOnCreate: z.string().optional(),
    planLimitAcknowledged: z.boolean(),
    // Optional at the schema level so existing/pre-owner-guardrail configs
    // still parse — actually *requiring* it for a config that's allowed to
    // create real records is enforced explicitly in
    // app/api/clients/[id]/config/route.ts, not here. This field was
    // missing from this schema entirely until 26 Aug 2026, which meant
    // z.object()'s default "strip unknown keys" behavior silently deleted
    // it from every saved config — confirmed live: a real deal got created
    // with no owner despite the wizard requiring a pick before "Next"
    // worked, because the value never survived this parse.
    ownerId: z.string().optional(),
  }),

  events: z.record(canonicalEventTypeSchema, z.boolean()),

  fieldMap: z.array(fieldMappingSchema),
  statusMap: z.record(z.string()),

  notifications: z.object({
    slackExternalId: z.string().optional(),
    slackInternalId: z.string().optional(),
    slackNotificationsId: z.string().optional(),
  }),
});

export type ClientConfigInput = z.infer<typeof clientConfigSchema>;
