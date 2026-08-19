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
