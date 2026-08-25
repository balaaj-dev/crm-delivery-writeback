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
