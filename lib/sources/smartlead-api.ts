/**
 * Thin client for calling Smartlead's own REST API (distinct from
 * lib/sources/smartlead.ts, which maps *incoming webhooks*). Used by the
 * wizard to list a client's live lead categories (step 8) and to register
 * the 7 approved webhook events (step 10).
 *
 * Verification status (checked against api.smartlead.ai's public reference
 * on 19 Aug 2026):
 *   CONFIRMED    Base URL is https://server.smartlead.ai/api/v1/ (NOT
 *                api.smartlead.ai — that host serves the docs, not the API).
 *   CONFIRMED    Auth is an `api_key` query parameter, not a bearer token.
 *   CONFIRMED    GET /campaigns/ lists a workspace's campaigns (used for the
 *                wizard's campaign-selection step).
 *   CONFIRMED    GET /campaigns/{id}/leads lists a campaign's leads, paginated
 *                via offset/limit, response shape { total_leads, data, offset,
 *                limit } — used for delivery (lib/delivery.ts). Verified live
 *                against a real account's real campaigns (25 Aug 2026),
 *                read-only, no campaign data modified. Each entry also
 *                carries `lead_category_id` (confirmed live, 25 Aug 2026,
 *                null until Smartlead triages the lead) — this is what
 *                resolveInterestCategoryIds below filters delivery on.
 *   CONFIRMED    GET /campaigns/{id}/leads/{leadId}/message-history returns
 *                real sent/reply email content { history: [{ type, subject,
 *                email_body, time, open_count, click_count }] }. Verified
 *                live against a real account's real lead (25 Aug 2026).
 *   NOT CONFIRMED  The exact path for listing lead categories.
 *   NOT CONFIRMED  The exact path/payload shape for webhook registration.
 *
 * Both NOT CONFIRMED items are brief §6/§7.5 [VERIFY] items and are
 * implemented below as a best-effort guess at the path, clearly marked.
 * Confirm against a real Smartlead account before relying on either call
 * in production — see docs/HANDOVER.md.
 */
import { logger } from '../log';
import { SMARTLEAD_EVENT_TYPES } from './smartlead';

const SMARTLEAD_API_BASE = 'https://server.smartlead.ai/api/v1';

/**
 * Retry-with-backoff on 429, added 26 Aug 2026 after a real failure: running
 * several delivery jobs concurrently against the same client (one per
 * active campaign, as "sync all contacts"/"positive replies only" both do)
 * legitimately exceeds Smartlead's real account-wide limit — confirmed
 * live: "Account rate limit exceeded. You have exceeded the 200 requests
 * in 1 min limit." Every call in this file went straight through a bare
 * `fetch`, so a single 429 killed the whole job outright, discarding real
 * progress (the pagination call sits outside any per-lead try/catch).
 * Three retries with growing delays is enough to ride out a shared,
 * per-minute account limit when multiple jobs are contending for it —
 * deliberately simple, same "not a full backoff system" scope as
 * hubspotFetch's single 429 retry, just sized for an account-wide limit
 * instead of a per-request one.
 */
async function smartleadFetch(url: URL, attempt = 1): Promise<Response> {
  const res = await fetch(url);
  if (res.status === 429 && attempt <= 3) {
    const delayMs = attempt * 3000;
    logger.warn('smartlead: rate limited, retrying with backoff', { attempt, delayMs, path: url.pathname });
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return smartleadFetch(url, attempt + 1);
  }
  return res;
}

export interface SmartleadLeadCategory {
  id: string | number;
  name: string;
}

export interface SmartleadCampaign {
  id: string;
  name: string;
  status: string;
}

/**
 * Confirmed live against Smartlead's public API reference (19 Aug 2026):
 * GET https://server.smartlead.ai/api/v1/campaigns/ — returns a plain array
 * of campaign objects. Powers the wizard's campaign-selection step, which
 * previously didn't exist at all (see docs/HANDOVER.md — without it,
 * source.campaignIds always stayed empty and webhook registration had no
 * way to succeed).
 */
export async function listCampaigns(apiKey: string): Promise<SmartleadCampaign[]> {
  const url = new URL(`${SMARTLEAD_API_BASE}/campaigns/`);
  url.searchParams.set('api_key', apiKey);

  const res = await smartleadFetch(url);
  if (!res.ok) {
    throw new Error(`Smartlead list-campaigns call failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as Array<{ id: number | string; name: string; status: string }>;
  return body.map((c) => ({ id: String(c.id), name: c.name, status: c.status }));
}

export interface SmartleadLead {
  /** Smartlead's own lead id — needed for the message-history endpoint. */
  id: string;
  email: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  title?: string;
  phone?: string;
  linkedinUrl?: string;
  /** Raw sequence status (e.g. INPROGRESS, COMPLETED, PAUSED) — Smartlead's own term, not a CRM lifecycle stage. */
  sequenceStatus?: string;
  /** Smartlead's own lead-category id for this campaign (null until the lead replies/gets triaged) — see resolveInterestCategoryIds. */
  leadCategoryId?: number | null;
  /** Company website/domain — Smartlead's own top-level `website` lead field (confirmed live, 26 Aug 2026). */
  domain?: string;
  /** Per-workspace custom fields (e.g. Company_City, Apollo_Industry), keyed by their raw Smartlead name. */
  customFields?: Record<string, string>;
}

/**
 * Confirmed live (25 Aug 2026) against a real Smartlead account's real
 * campaigns — read-only, does not modify anything about the campaign. One
 * page per call — `offset`/`limit` let the caller (lib/delivery.ts) page
 * through a large campaign across several calls rather than assuming this
 * fetches everything at once.
 */
export async function listCampaignLeads(
  apiKey: string,
  campaignId: string,
  limit = 100,
  offset = 0,
): Promise<{ leads: SmartleadLead[]; totalLeads: number }> {
  const url = new URL(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads`);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('limit', String(limit));

  const res = await smartleadFetch(url);
  if (!res.ok) {
    throw new Error(`Smartlead list-campaign-leads call failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    total_leads: string;
    data: Array<{
      status?: string;
      lead_category_id?: number | null;
      lead: {
        id: number | string;
        email: string;
        first_name?: string;
        last_name?: string;
        company_name?: string;
        website?: string | null;
        phone_number?: string | null;
        linkedin_profile?: string | null;
        custom_fields?: Record<string, string>;
      };
    }>;
  };
  return {
    totalLeads: Number(body.total_leads),
    leads: body.data.map((entry) => ({
      id: String(entry.lead.id),
      email: entry.lead.email,
      firstName: entry.lead.first_name,
      lastName: entry.lead.last_name,
      company: entry.lead.company_name,
      domain: entry.lead.website ?? undefined,
      title: entry.lead.custom_fields?.Title,
      phone: entry.lead.phone_number ?? undefined,
      linkedinUrl: entry.lead.linkedin_profile ?? undefined,
      sequenceStatus: entry.status,
      leadCategoryId: entry.lead_category_id ?? null,
      customFields: entry.lead.custom_fields,
    })),
  };
}

/**
 * Samples one real lead from a campaign and returns the keys of whatever
 * custom fields exist on it (e.g. Company_City, Apollo_Industry) — these are
 * per-workspace and not knowable in advance, so this is the only way to
 * discover them short of Smartlead exposing a real fields-schema endpoint
 * (it doesn't). Powers the wizard's "browse Smartlead fields" step (added
 * per Jairo's 26 Aug 2026 feedback). Returns an empty list, not an error, if
 * the campaign has no leads yet — nothing to browse is a normal state, not
 * a failure.
 */
export async function sampleLeadCustomFieldKeys(apiKey: string, campaignId: string): Promise<string[]> {
  const { leads } = await listCampaignLeads(apiKey, campaignId, 1, 0);
  return leads[0]?.customFields ? Object.keys(leads[0].customFields) : [];
}

export interface SmartleadMessage {
  /** 'SENT' (outbound) or 'REPLY' (inbound) — confirmed live, 25 Aug 2026. */
  type: string;
  subject: string;
  body: string;
  time: string;
}

/**
 * Confirmed live (25 Aug 2026) against a real lead's real message history —
 * read-only. The raw response also includes `open_count`/`click_count` per
 * message; deliberately not read here. Brief §2.3's deliverability rule
 * forbids *subscribing to* open/click tracking, and while passively reading
 * a count that happens to be in a response requested for other reasons is a
 * different mechanism, staying away from it entirely keeps this code
 * unambiguously on the right side of that rule — nothing downstream ever
 * sees or acts on open/click data.
 */
export async function listLeadMessageHistory(
  apiKey: string,
  campaignId: string,
  leadId: string,
): Promise<SmartleadMessage[]> {
  const url = new URL(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/leads/${leadId}/message-history`);
  url.searchParams.set('api_key', apiKey);

  const res = await smartleadFetch(url);
  if (!res.ok) {
    throw new Error(`Smartlead message-history call failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    history: Array<{ type: string; subject: string; email_body: string; time: string }>;
  };
  return body.history.map((m) => ({ type: m.type, subject: m.subject, body: m.email_body, time: m.time }));
}

/**
 * [VERIFY] path not confirmed — see file header. Best guess based on
 * Smartlead's REST conventions (server.smartlead.ai/api/v1, ?api_key= auth).
 */
export async function listLeadCategories(apiKey: string): Promise<SmartleadLeadCategory[]> {
  const url = new URL(`${SMARTLEAD_API_BASE}/leads/fetch-categories`);
  url.searchParams.set('api_key', apiKey);

  const res = await smartleadFetch(url);
  if (!res.ok) {
    throw new Error(
      `[VERIFY] Smartlead fetch-categories call failed (${res.status}). This endpoint path is ` +
        `unconfirmed against live docs — check helpcenter.smartlead.ai before assuming this is a ` +
        `real bug. ${await res.text()}`,
    );
  }
  return (await res.json()) as SmartleadLeadCategory[];
}

/**
 * Resolves which of a workspace's live Smartlead lead-category IDs count as
 * a genuine interest signal for one client, per that client's own statusMap
 * (brief §7.5) — the same mapping the writeback path already uses to
 * promote a status_change event to positive_reply/meeting_booked (see
 * resolveEffectiveEventType in lib/dispatch.ts). Used by delivery
 * (lib/delivery.ts, lib/jobs.ts) to decide, in partial mode, which leads are
 * even worth creating a CRM contact for.
 *
 * Real incident this fixes (25 Aug 2026): partial-mode delivery was
 * creating a HubSpot contact for every lead in a campaign regardless of
 * category — confirmed against a real Lotus Labs lead (Tracie Cranford)
 * who only ever bounced (never replied) but still got delivered and
 * incorrectly flagged as a positive-reply Lead. This is what
 * `lead.leadCategoryId` (see listCampaignLeads) is filtered against.
 */
export async function resolveInterestCategoryIds(
  apiKey: string,
  statusMap: Record<string, string>,
): Promise<Set<number>> {
  const categories = await listLeadCategories(apiKey);
  const ids = new Set<number>();
  for (const category of categories) {
    const mapped = statusMap[category.name];
    if (mapped === 'positive_reply' || mapped === 'meeting_booked') {
      ids.add(Number(category.id));
    }
  }
  return ids;
}

/**
 * Registers exactly the 7 approved events (brief §6) for one campaign.
 * Never pass EMAIL_OPEN or EMAIL_LINK_CLICK here — see brief §2.3 and
 * lib/sources/smartlead.ts's FORBIDDEN_EVENT_TYPES guard, which this call
 * cannot bypass even if asked to.
 *
 * Path/method CONFIRMED live, 26 Aug 2026 (real Lotus Labs account,
 * real wizard run): every attempt failed with a 400 whose body was
 * `{"message":"\"name\" is required","validation":{"source":"body","keys":["name"]}}`
 * — a genuine, previously-unconfirmed requirement, not a guess. `name`
 * added below; still worth a supervised re-test to confirm 200s land
 * before relying on this for a real client's live sync.
 */
export async function registerSmartleadWebhook(
  apiKey: string,
  campaignId: string,
  targetUrl: string,
): Promise<{ ok: boolean; message: string }> {
  const url = new URL(`${SMARTLEAD_API_BASE}/campaigns/${campaignId}/webhooks`);
  url.searchParams.set('api_key', apiKey);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Cymate CRM Writeback',
      // Never EMAIL_OPEN / EMAIL_LINK_CLICK — see brief §2.3.
      event_types: SMARTLEAD_EVENT_TYPES,
      webhook_url: targetUrl,
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    logger.warn('smartlead webhook registration failed — endpoint shape is unverified', {
      campaignId,
      status: res.status,
      detail,
    });
    return {
      ok: false,
      message: `[VERIFY] Registration call failed (${res.status}). This endpoint is unconfirmed — see docs/HANDOVER.md. ${detail}`,
    };
  }

  return { ok: true, message: 'Webhook registration call succeeded (verify event list in Smartlead UI).' };
}
