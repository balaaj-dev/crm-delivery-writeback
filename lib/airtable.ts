/**
 * Config layer. Airtable is the source of truth for client config; this
 * module is the only place that talks to it.
 *
 * Read by field ID wherever the field already has one (verified live against
 * the base on 19 Aug 2026 — see docs/AIRTABLE-FIELDS.md), never by name,
 * because names carry emoji and are free to be renamed. The `returnFieldsByFieldId=true`
 * query param makes the Airtable API key every field in the response by its
 * field ID instead of its display name.
 *
 * The RevOps writeback fields (CRM type, credentials, field map, status map,
 * etc.) do not exist on the live base yet — see docs/AIRTABLE-FIELDS.md.
 * Until Balaaj adds them by hand and records their generated field IDs here,
 * every client read through this module resolves to `activated: false` with
 * empty maps, which is the correct, safe default. Do not create these fields
 * programmatically (brief §17.3).
 */
import { z } from 'zod';
import type { ClientConfig, CrmType, IntegrationPath } from './types';

// ---------------------------------------------------------------------------
// Field IDs — verified live against base applraTn50dXBSMrM, table
// tblt13hM89s9U72J9 (👨‍💻 Clients) on 19 Aug 2026.
// ---------------------------------------------------------------------------

const EXISTING_FIELDS = {
  business: 'fldZk1XJa6aGNr2KY', // 👨‍💻 Business
  status: 'fld3dxJaJigzbKBo4', // ⭐ Status
  recordId: 'fldmxilAhXqLJMKy0', // Record ID (formula) — used as clientId
  smartleadApiKey: 'fld0DPqzJj7tQcYnC', // 🗝️ Smartlead API key
  smartleadClientId: 'fldJHDFFBWcICCnDr', // ⚙️ Smartlead Client ID
  slackExternalId: 'fldV0vj7VOb0aA7X6', // 📤 Slack External ID
  slackInternalId: 'fldmeeWYjlit2DRyZ', // 📥 Slack Internal ID
  slackNotificationsId: 'fldRvoDY9C5UUTKrj', // 🔈 Slack Notifications ID
} as const;

/**
 * NOT YET CREATED on the live base (brief §5.2). Fill each in with the real
 * field ID the moment Balaaj adds it and records it in
 * docs/AIRTABLE-FIELDS.md — until then these stay `null` and the mapper
 * below treats every client as not activated for writeback.
 */
const PENDING_WRITEBACK_FIELDS: Record<string, string | null> = {
  writebackActivated: null, // 🔁 RevOps Writeback Activated
  writebackMode: null, // 🔁 Writeback Mode
  crmType: null, // 🔁 CRM Type
  crmIntegrationPath: null, // 🔁 CRM Integration Path
  crmCredentials: null, // 🔁 CRM Credentials
  crmFieldMap: null, // 🔁 CRM Field Map
  crmStatusMap: null, // 🔁 CRM Status Map
  createRecordOnInterestedReply: null, // 🔁 Create Record On Interested Reply
  createRecordForAllLeads: null, // 🔁 Create Record For All Leads
  createDeal: null, // 🔁 Create Deal
  dealStageOnCreate: null, // 🔁 Deal Stage On Create
  planLimitAcknowledged: null, // 🔁 Plan Limit Acknowledged
};

/** Never read or write this table — Cymate's own internal prospect pipeline. */
export const DO_NOT_TOUCH_TABLE_ID = 'tblOccZhfaBN362uR'; // 🖨️ CRM Automation (don't touch)

interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

interface AirtableListResponse {
  records: AirtableRecord[];
  offset?: string;
}

function airtableEnv() {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID ?? 'applraTn50dXBSMrM';
  const tableId = process.env.AIRTABLE_CLIENTS_TABLE_ID ?? 'tblt13hM89s9U72J9';
  if (!apiKey) {
    throw new Error(
      'AIRTABLE_API_KEY is not set. Set CONFIG_SOURCE=fixtures to run without live Airtable access.',
    );
  }
  return { apiKey, baseId, tableId };
}

async function fetchAllClientRecords(): Promise<AirtableRecord[]> {
  const { apiKey, baseId, tableId } = airtableEnv();
  const records: AirtableRecord[] = [];
  let offset: string | undefined;

  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set('returnFieldsByFieldId', 'true');
    url.searchParams.set('pageSize', '100');
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`Airtable list request failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as AirtableListResponse;
    records.push(...body.records);
    offset = body.offset;
  } while (offset);

  return records;
}

/**
 * Live Status options on the base carry an emoji prefix (confirmed 25 Aug
 * 2026 — real values are '✅ Active', '❌ Inactive', '🔄 Churning', '🌙
 * Paused', '⛵️Other'), so an exact `=== 'active'` match silently filtered
 * out every client, including genuinely active ones — GET /api/clients
 * returned an empty list with CONFIG_SOURCE=airtable even with a valid
 * token. Strips everything but letters/spaces before comparing (rather than
 * a plain `.includes('active')`) because 'Inactive' also contains the
 * substring "active" and must NOT match.
 */
function normalizeStatusLabel(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw
      .replace(/[^\p{L}\s]/gu, '')
      .trim()
      .toLowerCase();
  }
  if (raw && typeof raw === 'object' && 'name' in raw) {
    return normalizeStatusLabel((raw as { name: unknown }).name);
  }
  return '';
}

function activeStatusFilter(record: AirtableRecord): boolean {
  return normalizeStatusLabel(record.fields[EXISTING_FIELDS.status]) === 'active';
}

function safeParseJson<T>(value: unknown, schema: z.ZodType<T>, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return schema.parse(JSON.parse(value));
  } catch {
    return fallback;
  }
}

const credentialsSchema = z.record(z.string());
const fieldMapArraySchema = z.array(
  z.object({
    canonical: z.string(),
    crmObject: z.string(),
    crmField: z.string(),
    direction: z.enum(['in', 'out', 'both']),
  }),
);
const statusMapSchema = z.record(z.string());

function yesNo(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.toLowerCase() === 'yes';
  if (value && typeof value === 'object' && 'name' in value) {
    return String((value as { name: unknown }).name).toLowerCase() === 'yes';
  }
  return false;
}

/**
 * Maps one Airtable record into a ClientConfig. Because the §5.2 fields do
 * not exist yet, every field read through PENDING_WRITEBACK_FIELDS resolves
 * to `undefined`, which this mapper treats as "not configured" rather than
 * throwing — that keeps `GET /api/clients` usable today, returning clients
 * that are all correctly `activated: false` until the fields are added.
 */
export function mapAirtableRecordToClientConfig(record: AirtableRecord): ClientConfig | null {
  const { fields } = record;
  const clientName = fields[EXISTING_FIELDS.business];
  if (typeof clientName !== 'string' || clientName.trim() === '') return null;

  const clientId = (fields[EXISTING_FIELDS.recordId] as string | undefined) ?? record.id;

  const get = (key: keyof typeof PENDING_WRITEBACK_FIELDS): unknown => {
    const fieldId = PENDING_WRITEBACK_FIELDS[key];
    return fieldId ? fields[fieldId] : undefined;
  };

  const activated = yesNo(get('writebackActivated'));
  const modeRaw = get('writebackMode');
  const mode: ClientConfig['mode'] =
    typeof modeRaw === 'string' && modeRaw.toLowerCase() === 'full' ? 'full' : 'partial';

  const crmTypeRaw = get('crmType');
  const crmType = (
    typeof crmTypeRaw === 'string' ? crmTypeRaw.toLowerCase() : 'hubspot'
  ) as CrmType;
  const integrationPathRaw = get('crmIntegrationPath');
  const integrationPath: IntegrationPath =
    typeof integrationPathRaw === 'string' && integrationPathRaw.toLowerCase() === 'outboundsync'
      ? 'outboundsync'
      : crmType === 'salesforce'
        ? 'outboundsync'
        : 'native';

  return {
    clientId,
    clientName,
    activated,
    mode,
    source: {
      platform: 'smartlead',
      apiKey: (fields[EXISTING_FIELDS.smartleadApiKey] as string | undefined) ?? '',
      smartleadClientId: fields[EXISTING_FIELDS.smartleadClientId] as string | undefined,
    },
    crm: {
      type: crmType,
      integrationPath,
      credentials: safeParseJson(get('crmCredentials'), credentialsSchema, {}),
    },
    behaviour: {
      createRecordOnInterestedReply: yesNo(get('createRecordOnInterestedReply')),
      createRecordForAllLeads: yesNo(get('createRecordForAllLeads')),
      createDeal: yesNo(get('createDeal')),
      dealStageOnCreate: get('dealStageOnCreate') as string | undefined,
      planLimitAcknowledged: yesNo(get('planLimitAcknowledged')),
    },
    events: {
      email_sent: false,
      reply: false,
      positive_reply: false,
      bounce: false,
      unsubscribe: false,
      status_change: false,
      meeting_booked: false,
    },
    fieldMap: safeParseJson(get('crmFieldMap'), fieldMapArraySchema, []),
    statusMap: safeParseJson(get('crmStatusMap'), statusMapSchema, {}),
    notifications: {
      slackExternalId: fields[EXISTING_FIELDS.slackExternalId] as string | undefined,
      slackInternalId: fields[EXISTING_FIELDS.slackInternalId] as string | undefined,
      slackNotificationsId: fields[EXISTING_FIELDS.slackNotificationsId] as string | undefined,
    },
  };
}

export async function listClientConfigsFromAirtable(): Promise<ClientConfig[]> {
  const records = await fetchAllClientRecords();
  return records
    .filter(activeStatusFilter)
    .map(mapAirtableRecordToClientConfig)
    .filter((c): c is ClientConfig => c !== null);
}

/**
 * Writes the writeback-specific fields back for one client (wizard step 10).
 * No-ops with a clear error until the §5.2 fields exist — see
 * docs/AIRTABLE-FIELDS.md.
 */
export async function writeClientConfigToAirtable(_config: ClientConfig): Promise<void> {
  const missingFieldIds = Object.entries(PENDING_WRITEBACK_FIELDS).filter(([, v]) => v === null);
  if (missingFieldIds.length > 0) {
    throw new Error(
      `Cannot write writeback config back to Airtable — these fields do not exist yet on the ` +
        `👨‍💻 Clients table: ${missingFieldIds.map(([k]) => k).join(', ')}. See docs/AIRTABLE-FIELDS.md.`,
    );
  }
  // Intentionally unreachable until the fields above are filled in with real
  // IDs — left as a stub rather than a full PATCH implementation so nobody
  // accidentally exercises it against the live base before the fields exist.
  throw new Error('writeClientConfigToAirtable: not yet wired — see docs/AIRTABLE-FIELDS.md');
}
