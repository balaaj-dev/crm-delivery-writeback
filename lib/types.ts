/**
 * Core contract for the whole app. Every mapper, adapter, and route depends on
 * these shapes. Change them deliberately — see docs/ADDING-A-CRM.md before
 * touching CrmAdapter, and docs/HANDOVER.md for known limitations.
 */

// ---------------------------------------------------------------------------
// Canonical event (brief §7.1)
// ---------------------------------------------------------------------------

export type CanonicalEventType =
  | 'email_sent'
  | 'reply'
  | 'positive_reply'
  | 'bounce'
  | 'unsubscribe'
  | 'status_change'
  | 'meeting_booked';

export const CANONICAL_EVENT_TYPES: CanonicalEventType[] = [
  'email_sent',
  'reply',
  'positive_reply',
  'bounce',
  'unsubscribe',
  'status_change',
  'meeting_booked',
];

export interface CanonicalEvent {
  /** Idempotency key — stable, derived from the source payload. */
  eventId: string;
  /** ISO 8601 timestamp. */
  occurredAt: string;
  type: CanonicalEventType;
  /** Airtable Clients Record ID. */
  clientId: string;
  /** Union grows as new sending platforms get a source adapter (e.g. 'emailbison'). */
  source: 'smartlead';
  campaign: {
    id: string;
    name: string;
  };
  prospect: {
    /** Lowercased, trimmed — the match key against the CRM. */
    email: string;
    firstName?: string;
    lastName?: string;
    company?: string;
    title?: string;
    linkedinUrl?: string;
    phone?: string;
  };
  detail: {
    sequenceStep?: number;
    subject?: string;
    /** Truncated to 2000 chars. */
    bodyPreview?: string;
    /** Raw Smartlead lead category, pre-mapping. */
    category?: string;
    bounceReason?: string;
  };
  /** Original payload, kept for debugging. Never rely on this for logic. */
  raw: unknown;
}

// ---------------------------------------------------------------------------
// Client config (brief §7.2)
// ---------------------------------------------------------------------------

export type WritebackMode = 'partial' | 'full';

export type CrmType =
  | 'hubspot'
  | 'pipedrive'
  | 'zoho'
  | 'attio'
  | 'gohighlevel'
  | 'insightly'
  | 'salesforce';

export const CRM_TYPES: CrmType[] = [
  'hubspot',
  'pipedrive',
  'zoho',
  'attio',
  'gohighlevel',
  'insightly',
  'salesforce',
];

/** Which CRM types have a real (non-stub) adapter implemented in this skeleton. */
export const IMPLEMENTED_CRM_TYPES: CrmType[] = ['hubspot'];

export type IntegrationPath = 'native' | 'outboundsync';

export interface FieldMapping {
  /** Dot path into CanonicalEvent, e.g. 'prospect.email'. */
  canonical: string;
  /** e.g. 'contact'. */
  crmObject: string;
  /** e.g. 'email'. */
  crmField: string;
  direction: 'in' | 'out' | 'both';
}

export interface ClientConfig {
  clientId: string;
  clientName: string;
  activated: boolean;
  mode: WritebackMode;

  source: {
    platform: 'smartlead';
    apiKey: string;
    smartleadClientId?: string;
    /** Empty/undefined = all campaigns. */
    campaignIds?: string[];
  };

  crm: {
    type: CrmType;
    integrationPath: IntegrationPath;
    credentials: Record<string, string>;
  };

  behaviour: {
    createRecordOnInterestedReply: boolean;
    createRecordForAllLeads: boolean;
    createDeal: boolean;
    dealStageOnCreate?: string;
    planLimitAcknowledged: boolean;
  };

  events: Record<CanonicalEventType, boolean>;

  fieldMap: FieldMapping[];
  statusMap: Record<string, string>;

  notifications: {
    slackExternalId?: string;
    slackInternalId?: string;
    slackNotificationsId?: string;
  };
}

// ---------------------------------------------------------------------------
// Mode presets (brief §7.3)
//
// A CSM never hand-builds an event map. Selecting a mode applies a preset,
// which the wizard may then let them adjust.
//
// Why partial exists: HubSpot bills per stored contact. Partial mode only
// creates a CRM record when an interested reply arrives, which keeps volume —
// and cost — low. Full mode writes everything and is only appropriate when
// the client's plan supports the contact volume. This is the single most
// important product distinction in the service.
// ---------------------------------------------------------------------------

export const MODE_PRESETS: Record<
  WritebackMode,
  Pick<ClientConfig, 'events'> & { behaviour: Partial<ClientConfig['behaviour']> }
> = {
  partial: {
    events: {
      email_sent: false,
      reply: true,
      positive_reply: true,
      bounce: true,
      unsubscribe: true,
      status_change: true,
      meeting_booked: true,
    },
    behaviour: {
      createRecordOnInterestedReply: true,
      createRecordForAllLeads: false,
    },
  },
  full: {
    events: {
      email_sent: true,
      reply: true,
      positive_reply: true,
      bounce: true,
      unsubscribe: true,
      status_change: true,
      meeting_booked: true,
    },
    behaviour: {
      createRecordOnInterestedReply: true,
      createRecordForAllLeads: true,
    },
  },
};

// ---------------------------------------------------------------------------
// Field map default (brief §7.4) — the wizard pre-fills this, CSM can adjust.
// ---------------------------------------------------------------------------

export const DEFAULT_FIELD_MAP: FieldMapping[] = [
  { canonical: 'prospect.email', crmObject: 'contact', crmField: 'email', direction: 'out' },
  {
    canonical: 'prospect.firstName',
    crmObject: 'contact',
    crmField: 'firstname',
    direction: 'out',
  },
  { canonical: 'prospect.lastName', crmObject: 'contact', crmField: 'lastname', direction: 'out' },
  { canonical: 'prospect.company', crmObject: 'contact', crmField: 'company', direction: 'out' },
  { canonical: 'prospect.title', crmObject: 'contact', crmField: 'jobtitle', direction: 'out' },
  { canonical: 'prospect.phone', crmObject: 'contact', crmField: 'phone', direction: 'out' },
];

// ---------------------------------------------------------------------------
// Status map default (brief §7.5)
//
// Maps a raw Smartlead lead category to a value in the client's CRM. Because
// Smartlead categories are configurable per workspace, this must be driven by
// live data (fetched via the Smartlead API in the wizard), never hardcoded
// for a real client. These are only suggestions the wizard pre-fills.
// ---------------------------------------------------------------------------

export const DEFAULT_STATUS_MAP: Record<string, string> = {
  Interested: 'positive_reply',
  // Smartlead's own default category is named "Meeting Request", not
  // "Meeting Booked" — confirmed live, 25 Aug 2026, against a real
  // workspace's GET /leads/fetch-categories. Always overwritten by the
  // wizard's live category fetch anyway (step 8) — this is only the
  // fallback shown before that fetch runs.
  'Meeting Request': 'meeting_booked',
  'Not Interested': 'closed_lost',
  'Not Now': 'nurture',
  'Wrong Person': 'referral',
  'Out Of Office': 'ignore',
  'Do Not Contact': 'unsubscribed',
};

// ---------------------------------------------------------------------------
// CRM adapter contract (brief §9) — the single most important design
// artifact in the repo. Keep it this small.
// ---------------------------------------------------------------------------

export interface CrmRecordRef {
  /** 'contact' | 'lead' | ... */
  objectType: string;
  id: string;
  /** Deep link for the log/UI. */
  url?: string;
}

export interface CrmFieldDescriptor {
  /** API name. */
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** For enums/picklists. */
  options?: string[];
}

export interface CrmDealStageDescriptor {
  /** The real, portal-specific stage ID — what actually gets written to dealStageOnCreate. */
  id: string;
  /** Human label for the wizard's picker, e.g. "Appointment Scheduled". */
  label: string;
  /** Which pipeline this stage belongs to, shown when a portal has more than one. */
  pipelineLabel: string;
  /**
   * The pipeline's own ID. HubSpot silently drops `dealstage` on create
   * unless `pipeline` is sent alongside it (confirmed live, 25 Aug 2026 —
   * no error, the value just comes back null) — createDeal needs this to
   * set a stage correctly.
   */
  pipelineId: string;
}

export interface CrmAdapter {
  readonly type: CrmType;
  readonly integrationPath: IntegrationPath;

  /** Does this CRM already hold this person? Match on email. */
  findRecord(email: string, cfg: ClientConfig): Promise<CrmRecordRef | null>;

  /** Create the record. Only called when dispatch policy allows it. */
  createRecord(event: CanonicalEvent, cfg: ClientConfig): Promise<CrmRecordRef>;

  /** Log the activity against the record. */
  writeActivity(ref: CrmRecordRef, event: CanonicalEvent, cfg: ClientConfig): Promise<void>;

  /** Move status / lifecycle stage. */
  updateStatus(ref: CrmRecordRef, status: string, cfg: ClientConfig): Promise<void>;

  /** Optional. */
  createDeal?(ref: CrmRecordRef, event: CanonicalEvent, cfg: ClientConfig): Promise<void>;

  /** Powers the wizard's field-mapping step. */
  describeFields(cfg: ClientConfig, objectType: string): Promise<CrmFieldDescriptor[]>;

  /**
   * Optional — only implement for CRMs with a deal/opportunity pipeline
   * concept. Powers the wizard's deal-stage picker (step 9) so a CSM
   * chooses a real stage by name instead of typing a raw, portal-specific
   * ID (see docs/HANDOVER.md — HubSpot's default pipeline stage IDs vary
   * per portal, confirmed live).
   */
  listDealStages?(cfg: ClientConfig): Promise<CrmDealStageDescriptor[]>;

  /** Credential check for the wizard. */
  testConnection(cfg: ClientConfig): Promise<{ ok: boolean; message: string }>;
}

/** Thrown by stub adapters (e.g. Salesforce) for every method call. */
export class NotImplementedError extends Error {
  constructor(crmType: CrmType, detail: string) {
    super(`[${crmType}] not implemented in this skeleton: ${detail}`);
    this.name = 'NotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// Dispatch outcome (brief §8) — every skip must be logged with a
// machine-readable reason. Silent drops are the failure mode this whole
// service exists to prevent.
// ---------------------------------------------------------------------------

export type SkipReason =
  | 'not_activated'
  | 'event_disabled'
  | 'campaign_not_in_scope'
  | 'duplicate'
  | 'no_record_no_create_policy';

export type DispatchOutcome =
  | { status: 'success'; ref: CrmRecordRef; actions: string[] }
  | { status: 'skip'; reason: SkipReason }
  // actions/ref capture whatever succeeded before the failing step, so a
  // partial failure (e.g. contact created + note written, then deal
  // creation fails on a missing scope) doesn't read as a total loss.
  | { status: 'error'; reason: string; actions: string[]; ref?: CrmRecordRef };
