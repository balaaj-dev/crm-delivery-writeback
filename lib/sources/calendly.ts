/**
 * Extension point only — not implemented in this skeleton (brief §6.1, §3).
 *
 * There is no MEETING_BOOKED Smartlead webhook. In v1, meeting_booked is
 * derived entirely from LEAD_CATEGORY_UPDATED via the client's status map
 * (see lib/dispatch.ts). The Onboarding Client Airtable table has a
 * Calendly Logins field and booking links, so a future version could add a
 * real Calendly (or Cal.com) webhook source here, normalising bookings into
 * the same CanonicalEvent shape with type: 'meeting_booked'.
 *
 * TODO: build a real Calendly source adapter here when that becomes a
 * priority. Do not build it now — it is explicitly out of scope for this
 * milestone (brief §3).
 */
export {};
