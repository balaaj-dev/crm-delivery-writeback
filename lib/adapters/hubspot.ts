/**
 * HubSpot adapter — the one that must actually work (brief §10).
 *
 * Auth: HubSpot Private App / Service Key access token (still a Bearer
 * token — HubSpot rebranded the app-management UI but not the API auth
 * transport), read from cfg.crm.credentials.accessToken.
 *
 * Verification status — CONFIRMED LIVE against a real HubSpot portal on
 * 25 Aug 2026 (see docs/HANDOVER.md for the full trail):
 *   CONFIRMED   GET   /crm/v3/objects/contacts/{email}?idProperty=email  (find by email)
 *   CONFIRMED   POST  /crm/v3/objects/contacts                           (create, {properties})
 *   CONFIRMED   PATCH /crm/v3/objects/contacts/{contactId}               (update)
 *   CONFIRMED   GET   /crm/v3/properties/{objectType}                   (describe fields)
 *   CONFIRMED   POST  /crm/v3/objects/notes  +  PUT .../associations/default/...  (writeActivity, non-email events)
 *   CONFIRMED   POST  /crm/v3/objects/emails +  PUT .../associations/default/...  (writeActivity, email_sent/reply —
 *               real email content, not a note; hs_email_status only accepts
 *               BOUNCED/FAILED/SCHEDULED/SENDING/SENT/DRAFT, confirmed via a live validation error)
 *   CONFIRMED   POST  /crm/v3/properties/{objectType}  (create a missing custom property)
 *
 * Marketing-contact billing risk (brief §10.1) — RESOLVED, not just verified:
 * `hs_marketable_status` is a read-only property (confirmed via a live
 * GET .../properties/contacts/hs_marketable_status — modificationMetadata.readOnlyValue
 * is true) and cannot be set through the standard properties write; HubSpot
 * silently ignores it rather than erroring. That's fine, because per
 * HubSpot's own docs, "Any integration or API sets contacts as non-marketing
 * by default" — https://knowledge.hubspot.com/contacts/default-marketing-statuses-for-created-contacts.
 * There is nothing for this adapter to do here; do not re-add a write to
 * this property.
 */
import type {
  CanonicalEvent,
  ClientConfig,
  CrmAdapter,
  CrmDealStageDescriptor,
  CrmFieldDescriptor,
  CrmOwnerDescriptor,
} from '../types';
import { logger } from '../log';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/**
 * The custom property this adapter writes lifecycle/status updates to. It
 * does not exist by default on any portal — confirmed live (25 Aug 2026):
 * the first PATCH against a fresh portal failed with PROPERTY_DOESNT_EXIST.
 * `updateStatus` below self-heals by creating it on first use per portal,
 * so no manual HubSpot setup step is required per client.
 *
 * Open item (brief §18.1, still genuinely unresolved — ask Balaaj, do not
 * guess): should status updates instead drive `lifecyclestage` or
 * `hs_lead_status` — HubSpot's own native fields — instead of this custom
 * property? The brief's own recommendation is a custom property "so we
 * never fight their marketing automation" — that is the default
 * implemented here. Confirm before relying on this for a real client.
 */
const CYMATE_STATUS_PROPERTY = 'cymate_writeback_status';

class HubspotApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HubspotApiError';
  }
}

/**
 * HubSpot error bodies are JSON with a top-level `message` and sometimes a
 * more specific `errors[].message`. Surfacing the raw body (as this used to)
 * dumps a wall of JSON into /log and the wizard's warning banners — not
 * something a CSM should have to read. This extracts the human-readable
 * part; falls back to the raw text (truncated) if it isn't JSON.
 */
function hubspotErrorSummary(rawText: string): string {
  try {
    const parsed = JSON.parse(rawText) as {
      message?: string;
      errors?: Array<{ message?: string }>;
    };
    const specific = parsed.errors?.[0]?.message;
    if (specific && parsed.message) return `${parsed.message} (${specific})`;
    return specific ?? parsed.message ?? rawText.slice(0, 200);
  } catch {
    return rawText.slice(0, 200);
  }
}

function accessToken(cfg: ClientConfig): string {
  const token = cfg.crm.credentials.accessToken;
  if (!token) {
    throw new Error('HubSpot adapter: cfg.crm.credentials.accessToken is missing');
  }
  return token;
}

function isDryRun(): boolean {
  return (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
}

/**
 * Deviation from a literal reading of brief §11, documented here and in
 * docs/HANDOVER.md: §11 describes DRY_RUN as routing "all adapters" through
 * the generic lib/adapters/mock.ts. But Milestone 4's own accept test
 * requires that "the log shows the exact HubSpot calls that would be made
 * for each event type" — a generic CRM-agnostic mock cannot produce that.
 * So DRY_RUN is intercepted here, at the HTTP layer, inside the real
 * HubSpot adapter: every *write* this adapter would make is logged with its
 * method, path, and body, and a synthetic 200 response is returned so the
 * calling method's parsing logic still runs — but no write ever reaches
 * HubSpot. The generic mock adapter remains the fixture used directly by
 * dispatch's own unit tests (Milestone 3), independent of any real CRM.
 *
 * GET requests are deliberately NOT simulated (see hubspotFetch below) —
 * fixed 26 Aug 2026 after two independent live testers hit the same real
 * bug: with DRY_RUN=true (the safe default this app runs with normally),
 * every read-only lookup the wizard needs — describeFields, listOwners,
 * listDealStages, even testConnection's own credential check — came back
 * empty, because they were being simulated exactly like a write. That's not
 * just an annoyance: testConnection reporting a false "Connected to
 * HubSpot" for a bad token, purely because DRY_RUN happened to be on, is a
 * real correctness bug. None of these calls mutate anything in HubSpot, so
 * there is no dry-run reason to fake them — only writes need faking.
 */
async function simulatedResponse(method: string, path: string, body: unknown): Promise<Response> {
  logger.info('hubspot dry-run: intended call', { dryRun: true, method, path, body });
  // Synthetic id lets callers (createRecord/writeActivity/createDeal) keep
  // working without a real HubSpot object id to reference.
  const syntheticId = `dryrun_${Math.abs(hashCode(`${method} ${path} ${JSON.stringify(body)}`))}`;
  return new Response(JSON.stringify({ id: syntheticId, results: [] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function hashCode(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}

/**
 * Rate limiting (brief §10.2): [VERIFY] current HubSpot rate limits before
 * relying on this. This is deliberately simple — serial requests, a small
 * fixed delay, and a single retry on 429 — not a full backoff system, which
 * is flagged as production work in docs/HANDOVER.md.
 */
async function hubspotFetch(
  cfg: ClientConfig,
  path: string,
  init: RequestInit = {},
  attempt = 1,
): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  // Only writes get simulated under DRY_RUN — see the comment above
  // simulatedResponse for why GETs always execute for real.
  if (isDryRun() && method !== 'GET') {
    return simulatedResponse(method, path, init.body ? JSON.parse(String(init.body)) : undefined);
  }

  const res = await fetch(`${HUBSPOT_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken(cfg)}`,
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (res.status === 429 && attempt === 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return hubspotFetch(cfg, path, init, attempt + 1);
  }

  return res;
}

interface HubspotPipeline {
  id: string;
  label: string;
  stages: Array<{ id: string; label: string }>;
}

/** Shared by listDealStages (wizard picker) and createDeal (pipeline lookup for a chosen stage). */
async function fetchDealPipelines(cfg: ClientConfig): Promise<HubspotPipeline[]> {
  const res = await hubspotFetch(cfg, '/crm/v3/pipelines/deals');
  if (!res.ok) {
    throw new HubspotApiError(res.status, `HubSpot fetchDealPipelines failed: ${hubspotErrorSummary(await res.text())}`);
  }
  const body = (await res.json()) as { results: HubspotPipeline[] };
  return body.results;
}

function fieldMapValue(event: CanonicalEvent, canonicalPath: string): string | undefined {
  const parts = canonicalPath.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let value: any = event;
  for (const part of parts) {
    value = value?.[part];
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * Creates CYMATE_STATUS_PROPERTY as a plain single-line text property if it
 * doesn't already exist on this portal. Text, not an enum, because status
 * values come from the client's own statusMap (brief §7.5) and are
 * open-ended per client — see fixtures/clients.json for examples like
 * "positive_reply", "nurture", "closed_lost".
 */
async function ensureCymateStatusProperty(cfg: ClientConfig): Promise<void> {
  const res = await hubspotFetch(cfg, '/crm/v3/properties/contacts', {
    method: 'POST',
    body: JSON.stringify({
      name: CYMATE_STATUS_PROPERTY,
      label: 'Cymate writeback status',
      type: 'string',
      fieldType: 'text',
      groupName: 'contactinformation',
      description:
        "Status value written by Cymate's CRM writeback service, driven by the client's Smartlead lead-category mapping.",
    }),
  });
  // 409 = another concurrent request already created it — not an error.
  if (!res.ok && res.status !== 409) {
    throw new HubspotApiError(
      res.status,
      `HubSpot: failed to create ${CYMATE_STATUS_PROPERTY} property: ${hubspotErrorSummary(await res.text())}`,
    );
  }
}

/**
 * Real lead details in the deal name, not a bare record id — found live,
 * 26 Aug 2026: a deal titled "Cymate writeback — 540713893599" tells a CSM
 * scanning their deals list nothing about who it's for. Falls back to the
 * old id-based name only when no prospect name/company/email survived.
 */
function dealNameFor(event: CanonicalEvent, ref: { id: string }): string {
  const name = [event.prospect.firstName, event.prospect.lastName].filter(Boolean).join(' ');
  const who = name || event.prospect.email || undefined;
  const label = [who, event.prospect.company].filter(Boolean).join(' — ');
  return label || `Cymate writeback — ${ref.id}`;
}

function buildContactProperties(event: CanonicalEvent, cfg: ClientConfig): Record<string, string> {
  const properties: Record<string, string> = {};
  for (const mapping of cfg.fieldMap) {
    if (mapping.crmObject !== 'contact' || mapping.direction === 'in') continue;
    const value = fieldMapValue(event, mapping.canonical);
    if (value) properties[mapping.crmField] = value;
  }
  return properties;
}

export const hubspotAdapter: CrmAdapter = {
  type: 'hubspot',
  integrationPath: 'native',

  async findRecord(email, cfg) {
    if (isDryRun()) {
      // Deliberately always "not found" in dry-run — this is the more
      // informative demo path, since it exercises the create-record policy
      // branches in lib/dispatch.ts (brief §8 step 6) for every fixture
      // event instead of short-circuiting on a fake hit.
      logger.info('hubspot dry-run: intended call', {
        dryRun: true,
        method: 'GET',
        path: `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
        result: 'simulated not-found',
      });
      return null;
    }

    const res = await hubspotFetch(
      cfg,
      `/crm/v3/objects/contacts/${encodeURIComponent(email)}?idProperty=email`,
    );
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot findRecord failed: ${hubspotErrorSummary(await res.text())}`);
    }
    const body = (await res.json()) as { id: string };
    return { objectType: 'contact', id: body.id, url: `https://app.hubspot.com/contacts/${body.id}` };
  },

  async createRecord(event, cfg) {
    const properties = buildContactProperties(event, cfg);

    // Billing safeguard (brief §10.1): confirmed resolved, not something
    // this adapter needs to do — see file header. HubSpot defaults every
    // API-created contact to non-marketing on its own, and the property
    // that would flag otherwise is read-only via the API regardless.

    // Required owner (Jairo's 26 Aug 2026 feedback) — same `hubspot_owner_id`
    // property HubSpot uses on both contacts and deals. The wizard blocks
    // completion without cfg.behaviour.ownerId set; this is the one place
    // that value actually lands on a real object.
    if (cfg.behaviour.ownerId) {
      properties.hubspot_owner_id = cfg.behaviour.ownerId;
    }

    const res = await hubspotFetch(cfg, '/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot createRecord failed: ${hubspotErrorSummary(await res.text())}`);
    }
    const body = (await res.json()) as { id: string };
    logger.info('hubspot: created contact', { id: body.id });
    return { objectType: 'contact', id: body.id, url: `https://app.hubspot.com/contacts/${body.id}` };
  },

  async writeActivity(ref, event, cfg) {
    // Real email content (brief §10 table's original intent: "for email
    // events prefer the emails object") — confirmed live, 25 Aug 2026:
    // POST /crm/v3/objects/emails + the same v4 default-association pattern
    // notes use. hs_email_status only accepts a small fixed set of values
    // (BOUNCED/FAILED/SCHEDULED/SENDING/SENT/DRAFT — confirmed via a live
    // validation error) — direction, not status, is what distinguishes
    // outbound from inbound, so SENT is correct for both. Logging these
    // with their real historical hs_timestamp is also what makes HubSpot's
    // own hs_engagements_last_contacted populate correctly — no separate
    // "last contacted" field for this adapter to set by hand.
    if (event.type === 'email_sent' || event.type === 'reply') {
      const createRes = await hubspotFetch(cfg, '/crm/v3/objects/emails', {
        method: 'POST',
        body: JSON.stringify({
          properties: {
            hs_timestamp: event.occurredAt,
            hs_email_direction: event.type === 'reply' ? 'INCOMING_EMAIL' : 'EMAIL',
            hs_email_status: 'SENT',
            hs_email_subject: event.detail.subject ?? '(no subject)',
            hs_email_text: event.detail.bodyPreview ?? '',
          },
        }),
      });
      if (!createRes.ok) {
        throw new HubspotApiError(
          createRes.status,
          `HubSpot writeActivity (create email) failed: ${hubspotErrorSummary(await createRes.text())}`,
        );
      }
      const email = (await createRes.json()) as { id: string };

      const assocRes = await hubspotFetch(
        cfg,
        `/crm/v4/objects/emails/${email.id}/associations/default/contacts/${ref.id}`,
        { method: 'PUT' },
      );
      if (!assocRes.ok) {
        throw new HubspotApiError(
          assocRes.status,
          `HubSpot writeActivity (associate email) failed: ${hubspotErrorSummary(await assocRes.text())}`,
        );
      }
      return;
    }

    // Non-email events (bounce, unsubscribe, status_change) — brief §10
    // table: "for other events a note is acceptable".
    const noteBody = [
      `Cymate writeback — ${event.type}`,
      event.detail.category ? `Category: ${event.detail.category}` : null,
      event.detail.bounceReason ? `Bounce reason: ${event.detail.bounceReason}` : null,
    ]
      .filter(Boolean)
      .join('\n');

    const createRes = await hubspotFetch(cfg, '/crm/v3/objects/notes', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          hs_note_body: noteBody,
          hs_timestamp: event.occurredAt,
        },
      }),
    });
    if (!createRes.ok) {
      throw new HubspotApiError(
        createRes.status,
        `HubSpot writeActivity (create note) failed: ${hubspotErrorSummary(await createRes.text())}`,
      );
    }
    const note = (await createRes.json()) as { id: string };

    const assocRes = await hubspotFetch(
      cfg,
      `/crm/v4/objects/notes/${note.id}/associations/default/contacts/${ref.id}`,
      { method: 'PUT' },
    );
    if (!assocRes.ok) {
      throw new HubspotApiError(
        assocRes.status,
        `HubSpot writeActivity (associate note) failed: ${hubspotErrorSummary(await assocRes.text())}`,
      );
    }
  },

  async updateStatus(ref, status, cfg) {
    const patch = () =>
      hubspotFetch(cfg, `/crm/v3/objects/contacts/${ref.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ properties: { [CYMATE_STATUS_PROPERTY]: status } }),
      });

    let res = await patch();
    if (!res.ok) {
      const detail = await res.text();
      if (detail.includes('PROPERTY_DOESNT_EXIST')) {
        // Self-heals per portal (confirmed necessary live, 25 Aug 2026 — see
        // file header): the first client on a fresh HubSpot portal always
        // hits this once, then never again for that portal.
        logger.info('hubspot: creating missing custom property', { property: CYMATE_STATUS_PROPERTY });
        await ensureCymateStatusProperty(cfg);
        res = await patch();
      } else {
        throw new HubspotApiError(res.status, `HubSpot updateStatus failed: ${hubspotErrorSummary(detail)}`);
      }
    }
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot updateStatus failed: ${hubspotErrorSummary(await res.text())}`);
    }
  },

  async createDeal(ref, event, cfg) {
    // HubSpot silently drops `dealstage` unless `pipeline` is sent alongside
    // it (confirmed live, 25 Aug 2026 — no error, the value just comes back
    // null). Resolve which pipeline the configured stage actually belongs
    // to rather than guessing.
    let stageProperties: Record<string, string> = {};
    if (cfg.behaviour.dealStageOnCreate) {
      const pipelines = await fetchDealPipelines(cfg);
      const match = pipelines
        .flatMap((p) => p.stages.map((s) => ({ pipelineId: p.id, stageId: s.id })))
        .find((s) => s.stageId === cfg.behaviour.dealStageOnCreate);
      if (match) {
        stageProperties = { pipeline: match.pipelineId, dealstage: match.stageId };
      } else {
        logger.warn(
          'hubspot: configured dealStageOnCreate not found in any pipeline — sending it alone, HubSpot will likely drop it silently',
          { dealStageOnCreate: cfg.behaviour.dealStageOnCreate },
        );
        stageProperties = { dealstage: cfg.behaviour.dealStageOnCreate };
      }
    }

    const createRes = await hubspotFetch(cfg, '/crm/v3/objects/deals', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          dealname: dealNameFor(event, ref),
          ...stageProperties,
          // Required owner (Jairo's 26 Aug 2026 feedback) — deal owner in
          // this case, same property name HubSpot uses for contact owner.
          ...(cfg.behaviour.ownerId ? { hubspot_owner_id: cfg.behaviour.ownerId } : {}),
        },
      }),
    });
    if (!createRes.ok) {
      throw new HubspotApiError(
        createRes.status,
        `HubSpot createDeal failed: ${hubspotErrorSummary(await createRes.text())}`,
      );
    }
    const deal = (await createRes.json()) as { id: string };

    const assocRes = await hubspotFetch(
      cfg,
      `/crm/v4/objects/deals/${deal.id}/associations/default/contacts/${ref.id}`,
      { method: 'PUT' },
    );
    if (!assocRes.ok) {
      throw new HubspotApiError(
        assocRes.status,
        `HubSpot createDeal (associate) failed: ${hubspotErrorSummary(await assocRes.text())}`,
      );
    }
  },

  async describeFields(cfg, objectType) {
    const res = await hubspotFetch(cfg, `/crm/v3/properties/${objectType}`);
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot describeFields failed: ${hubspotErrorSummary(await res.text())}`);
    }
    const body = (await res.json()) as {
      results: Array<{
        name: string;
        label: string;
        type: string;
        fieldType: string;
        modificationMetadata?: { readOnlyValue?: boolean };
        options?: Array<{ value: string }>;
      }>;
    };
    return body.results
      .filter((p) => !p.modificationMetadata?.readOnlyValue)
      .map(
        (p): CrmFieldDescriptor => ({
          name: p.name,
          label: p.label,
          type: p.type,
          required: false,
          options: p.options?.map((o) => o.value),
        }),
      );
  },

  /**
   * Powers the wizard's deal-stage picker. [VERIFY-once-scoped]: requires
   * crm.objects.deals.read (or crm.schemas.deals.read) — confirmed live
   * (25 Aug 2026) this is a separate scope from crm.objects.deals.write,
   * which is enough to create deals but not to list pipeline stages.
   */
  async listDealStages(cfg): Promise<CrmDealStageDescriptor[]> {
    const pipelines = await fetchDealPipelines(cfg);
    return pipelines.flatMap((pipeline) =>
      pipeline.stages.map((stage) => ({
        id: stage.id,
        label: stage.label,
        pipelineLabel: pipeline.label,
        pipelineId: pipeline.id,
      })),
    );
  },

  /**
   * Powers the wizard's required owner picker (step 7, added per Jairo's
   * 26 Aug 2026 feedback). `GET /crm/v3/owners` confirmed a real, live
   * endpoint (26 Aug 2026) — it correctly returns a MISSING_SCOPES error
   * naming `crm.objects.owners.read` rather than a 404, which only happens
   * for a genuine, recognized route. Not yet verified with a token that
   * actually has that scope — add it to any Service Key that needs this
   * step to work, alongside the deal scopes.
   */
  async listOwners(cfg): Promise<CrmOwnerDescriptor[]> {
    const res = await hubspotFetch(cfg, '/crm/v3/owners?limit=200');
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot listOwners failed: ${hubspotErrorSummary(await res.text())}`);
    }
    const body = (await res.json()) as {
      results: Array<{ id: string; email?: string; firstName?: string; lastName?: string }>;
    };
    return body.results.map((o) => ({
      id: o.id,
      label: [o.firstName, o.lastName].filter(Boolean).join(' ') || o.email || o.id,
      email: o.email,
    }));
  },

  async testConnection(cfg) {
    try {
      const res = await hubspotFetch(cfg, '/crm/v3/properties/contacts?limit=1');
      if (!res.ok) {
        return { ok: false, message: `HubSpot connection test failed: ${res.status}` };
      }
      return { ok: true, message: 'Connected to HubSpot.' };
    } catch (err) {
      return {
        ok: false,
        message: `HubSpot connection test threw: ${err instanceof Error ? err.message : err}`,
      };
    }
  },
};
