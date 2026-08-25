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
 *                read-only, no campaign data modified.
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

  const res = await fetch(url);
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

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Smartlead list-campaign-leads call failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    total_leads: string;
    data: Array<{
      status?: string;
      lead: {
        id: number | string;
        email: string;
        first_name?: string;
        last_name?: string;
        company_name?: string;
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
      title: entry.lead.custom_fields?.Title,
      phone: entry.lead.phone_number ?? undefined,
      linkedinUrl: entry.lead.linkedin_profile ?? undefined,
      sequenceStatus: entry.status,
    })),
  };
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

  const res = await fetch(url);
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

  const res = await fetch(url);
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
 * [VERIFY] path and payload shape not confirmed — see file header.
 * Registers exactly the 7 approved events (brief §6) for one campaign.
 * Never pass EMAIL_OPEN or EMAIL_LINK_CLICK here — see brief §2.3 and
 * lib/sources/smartlead.ts's FORBIDDEN_EVENT_TYPES guard, which this call
 * cannot bypass even if asked to.
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
