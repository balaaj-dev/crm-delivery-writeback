/**
 * HubSpot adapter — the one that must actually work (brief §10).
 *
 * Auth: HubSpot Private App access token, read from
 * cfg.crm.credentials.accessToken, sent as `Authorization: Bearer <token>`.
 *
 * Verification status (checked against developers.hubspot.com on 19 Aug
 * 2026 — see docs/HANDOVER.md for the full trail):
 *   CONFIRMED   GET   /crm/v3/objects/contacts/{email}?idProperty=email  (find by email)
 *   CONFIRMED   POST  /crm/v3/objects/contacts                           (create, {properties})
 *   CONFIRMED   PATCH /crm/v3/objects/contacts/{contactId}               (update)
 *   CONFIRMED   GET   /crm/v3/properties/{objectType}                   (describe fields)
 *   NOT CONFIRMED  the notes-create endpoint + v4 default-association endpoint shape
 *                  (HubSpot's docs site 404'd the pages checked live in this pass)
 *   NOT CONFIRMED  the exact mechanism for marking a contact non-marketing
 *
 * The two NOT CONFIRMED items are implemented below using the best-known
 * shape from general HubSpot API conventions, but — per brief rule #1 —
 * must be re-verified against live HubSpot docs (or a real sandbox account)
 * before DRY_RUN is ever set to false for a HubSpot client. Do not treat
 * this file as verified for those two calls.
 */
import type { CanonicalEvent, ClientConfig, CrmAdapter, CrmFieldDescriptor } from '../types';
import { logger } from '../log';

const HUBSPOT_API_BASE = 'https://api.hubapi.com';

/**
 * The custom property this adapter writes lifecycle/status updates to.
 *
 * Open item (brief §18.1, unresolved — ask Balaaj, do not guess): should
 * status updates instead drive `lifecyclestage`, `hs_lead_status`, or this
 * custom property? The brief's own recommendation is a custom property "so
 * we never fight their marketing automation" — that is the default
 * implemented here. Confirm before relying on this in a real client.
 */
const CYMATE_STATUS_PROPERTY = 'cymate_writeback_status';

/**
 * [VERIFY] before DRY_RUN=false — see file header. Best-known property for
 * HubSpot's Marketing Contacts feature. Setting this incorrectly either does
 * nothing (contact silently becomes/stays a paid marketing contact) or
 * errors — verify against a real portal before trusting it.
 */
const MARKETING_STATUS_PROPERTY = 'hs_marketable_status';

class HubspotApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HubspotApiError';
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
 * HubSpot adapter: every call this adapter would make is logged with its
 * method, path, and body, and a synthetic 200 response is returned so the
 * calling method's parsing logic still runs — but no request ever reaches
 * HubSpot. The generic mock adapter remains the fixture used directly by
 * dispatch's own unit tests (Milestone 3), independent of any real CRM.
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
  if (isDryRun()) {
    return simulatedResponse(init.method ?? 'GET', path, init.body ? JSON.parse(String(init.body)) : undefined);
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

function fieldMapValue(event: CanonicalEvent, canonicalPath: string): string | undefined {
  const parts = canonicalPath.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let value: any = event;
  for (const part of parts) {
    value = value?.[part];
  }
  return typeof value === 'string' ? value : undefined;
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
      throw new HubspotApiError(res.status, `HubSpot findRecord failed: ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    return { objectType: 'contact', id: body.id, url: `https://app.hubspot.com/contacts/${body.id}` };
  },

  async createRecord(event, cfg) {
    const properties = buildContactProperties(event, cfg);

    // Billing safeguard (brief §10.1): default every contact created by this
    // service to non-marketing so bulk writeback doesn't silently inflate a
    // client's HubSpot invoice. [VERIFY] — see file header. Do not remove
    // this without confirming the correct mechanism first.
    if (cfg.crm.credentials.treatAsMarketingContacts !== 'true') {
      properties[MARKETING_STATUS_PROPERTY] = 'false';
    }

    const res = await hubspotFetch(cfg, '/crm/v3/objects/contacts', {
      method: 'POST',
      body: JSON.stringify({ properties }),
    });
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot createRecord failed: ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string };
    logger.info('hubspot: created contact', { id: body.id, nonMarketing: true });
    return { objectType: 'contact', id: body.id, url: `https://app.hubspot.com/contacts/${body.id}` };
  },

  async writeActivity(ref, event, cfg) {
    // [VERIFY] before DRY_RUN=false — see file header. Uses a note (brief
    // §10 table: "for other events a note is acceptable") rather than the
    // dedicated emails engagement object, to keep one code path for every
    // event type in this skeleton.
    const noteBody = [
      `Cymate writeback — ${event.type}`,
      event.detail.subject ? `Subject: ${event.detail.subject}` : null,
      event.detail.category ? `Category: ${event.detail.category}` : null,
      event.detail.bounceReason ? `Bounce reason: ${event.detail.bounceReason}` : null,
      event.detail.bodyPreview ?? null,
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
        `HubSpot writeActivity (create note) failed: ${await createRes.text()}`,
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
        `HubSpot writeActivity (associate note) failed: ${await assocRes.text()}`,
      );
    }
  },

  async updateStatus(ref, status, cfg) {
    const res = await hubspotFetch(cfg, `/crm/v3/objects/contacts/${ref.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ properties: { [CYMATE_STATUS_PROPERTY]: status } }),
    });
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot updateStatus failed: ${await res.text()}`);
    }
  },

  async createDeal(ref, _event, cfg) {
    const createRes = await hubspotFetch(cfg, '/crm/v3/objects/deals', {
      method: 'POST',
      body: JSON.stringify({
        properties: {
          dealname: `Cymate writeback — ${ref.id}`,
          ...(cfg.behaviour.dealStageOnCreate
            ? { dealstage: cfg.behaviour.dealStageOnCreate }
            : {}),
        },
      }),
    });
    if (!createRes.ok) {
      throw new HubspotApiError(
        createRes.status,
        `HubSpot createDeal failed: ${await createRes.text()}`,
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
        `HubSpot createDeal (associate) failed: ${await assocRes.text()}`,
      );
    }
  },

  async describeFields(cfg, objectType) {
    const res = await hubspotFetch(cfg, `/crm/v3/properties/${objectType}`);
    if (!res.ok) {
      throw new HubspotApiError(res.status, `HubSpot describeFields failed: ${await res.text()}`);
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
