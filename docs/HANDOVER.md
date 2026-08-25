# Handover

Read this before extending or productionising this repo. It is a **standalone reference
implementation**, not the production system (see `README.md`). Everything below is either
explicitly out of scope, a known limitation of the "no database, no queue" decision, or an
unresolved `[VERIFY]`/`[ASK]` item carried over from the build brief.

## What this repo proves

That per-client CRM writeback difference can live entirely as *configuration* (Airtable fields +
a `ClientConfig` object), not as forked code or a hand-built Make.com scenario per client. Adding
a CRM means one new file + one registry line (`docs/ADDING-A-CRM.md`). Adding a client means
filling in Airtable fields, not writing code.

## Delivery — the other half of S1 (added after the original brief)

The build brief this repo was originally built from scoped it to writeback only (Jairo's own
framing on the 19 Aug call: *"there's essentially two parts to it... taking our data and having
that uploaded to the CRM... and then the second part is writeback"*). Delivery — bulk-creating
CRM contacts from a client's existing Smartlead leads, independent of any triggering event — was
added afterward at Balaaj's request, once writeback was proven against a real HubSpot portal.

- `lib/delivery.ts` — the core logic. Reuses `CrmAdapter.findRecord`/`createRecord` unchanged by
  representing a delivered lead as a minimal `CanonicalEvent`-shaped object, rather than inventing
  a parallel contact-creation path.
- `lib/sources/smartlead-api.ts`'s `listCampaignLeads` — confirmed live against a real account's
  real campaigns (`GET /campaigns/{id}/leads`), read-only.
- `POST /api/delivery/run`, wizard step 9 ("Deliver contacts").
- **Deliberately capped** (`maxLeads`, default 25) and synchronous — same "no durable job queue"
  decision as the rest of this repo (brief §3). A campaign with thousands of leads needs a real
  background job runner to deliver in full; this proves the mechanism works, it is not that job
  runner. Never silently drops leads past the cap — `cappedAt` is always reported.
- **Verified live** (25 Aug 2026) against Lotus Labs' real Smartlead account (read-only lead
  fetching, their campaigns untouched) delivering into the HubSpot test portal — never their real
  CRM. Confirmed: correct field mapping from real lead data, correct dedup on a second run
  (already-created leads skipped, not duplicated), and results correctly show up in `/log`.
- **Still not built**: suppression list sync (a distinct, separate S1 delivery feature, still out
  of scope — see below) and anything resembling a real bulk-import job (progress tracking across
  requests, resuming a partial import, syncing more than one `maxLeads` batch automatically).

## Explicitly out of scope (brief §3 / §17) — do not build these here

- Akaiza integration — a separate team owns that platform; this repo must not reference it.
- Production secret management — env vars + Airtable plaintext are used here; see "Credentials in
  Airtable" below.
- A durable job queue, exponential backoff, or dead-letter queue.
- A reconciliation poller against the Smartlead API to recover dropped webhooks.
- Multi-tenant OAuth app registration and refresh-token rotation.
- Bulk historical backfill of past campaign activity.
- Custom CRM objects, campaign-member / multi-touch attribution mapping.
- Suppression list sync (that's the delivery half of S1, not writeback).
- Authentication or user accounts on the `/setup` wizard — anyone who can reach the deployed URL
  can configure any client. Fine for an internal skeleton demo, not fine for anything else.
- A direct Salesforce API integration — see `lib/adapters/salesforce-outboundsync.ts`.

## Known architectural limitations (accepted for this milestone)

- **In-memory idempotency** (`lib/idempotency.ts`). The processed-event `Map` resets on cold
  start. On Vercel serverless, a duplicate webhook delivery can get reprocessed if it lands on a
  fresh instance. Production needs a persistent store (Redis, a database row, whatever the
  eventual platform already has).
- **In-memory + best-effort file event log** (`lib/log.ts`). Same story — the in-memory array is
  the source of truth for `/log` within one running instance; the JSON-lines file mirror is a
  local-dev convenience and silently no-ops on a read-only filesystem (e.g. Vercel). Production
  needs a real log sink.
- **In-memory deal-creation dedupe** (`lib/dispatch.ts`'s `dealsCreatedForRef`). Same limitation —
  resets on cold start, so a repeated positive signal after a cold start could create a second
  deal. No CRM-side "does a deal already exist" check exists in the `CrmAdapter` interface; that
  would need to be added if this becomes a real requirement.
- **Credentials in Airtable.** `🔁 CRM Credentials` is a plaintext long-text field. That is fine
  for a skeleton, not for production. A real secret store (e.g. a vault, or Vercel encrypted env
  vars per client) is real work for whoever integrates this into Akaiza.
- **No Airtable fields created programmatically.** The `🔁 RevOps Writeback...` fields (brief
  §5.2) do not exist on the live base as of 19 Aug 2026. `docs/AIRTABLE-FIELDS.md` lists exactly
  what to add by hand; until then, every client resolves to `activated: false` via
  `lib/airtable.ts`'s safe defaults, and `fixtures/clients.json` is what actually exercises the
  app end-to-end.
- **Fixed — campaign selection.** The wizard is now 11 steps; step 3 fetches the client's live
  Smartlead campaigns (`lib/sources/smartlead-api.ts`'s `listCampaigns`, confirmed against a real
  endpoint) and lets the CSM multi-select which ones this client's writeback covers, wiring the
  result into `source.campaignIds`. Falls back cleanly (no campaigns shown, Next stays enabled) if
  the fetch fails, same graceful-degradation pattern as the categories/fields steps.
- **Config-source-agnostic session override for wizard-configured values** (`lib/config.ts`'s
  `setSessionOverride`/`applySessionOverrides`, backed by a local JSON file at
  `data/client-overrides.json`, gitignored). Fixes a real bug found live: neither
  `fixtures/clients.json` (a static committed file) nor Airtable (write-back is a stub — see
  above) could actually persist what the wizard configures, so the wizard's own "fire a test
  event" step silently ran against stale data instead of what had just been selected — confirmed
  live with a deal-stage choice that was completely ignored. The first fix attempt used an
  in-memory `Map` and **did not work** — confirmed live that Next.js dev mode compiles different
  API route files as separate on-demand bundles, each getting its own independent instance of
  `lib/config.ts`'s top-level state, so a value set by the PUT route was invisible to
  `/api/webhooks/smartlead`'s route. This isn't dev-mode-only either: Vercel typically runs each
  API route as its own serverless function in production, so in-memory cross-route state would
  fail there for the same underlying reason (separate execution contexts), just with a different
  mechanism. The filesystem doesn't have this problem — any route reading/writing the same path
  sees the same data. Same "doesn't survive Vercel's read-only fs" caveat as `lib/log.ts`'s file
  mirror; this is a local-testing convenience, not a production persistence layer. **Takeaway for
  anything added later that needs cross-route shared state in this codebase: do not use a bare
  module-level variable — use the filesystem (locally) or a real store (in production).**

## Design decision: how DRY_RUN actually routes calls (deviates from a literal reading of brief §11)

Brief §11 describes `DRY_RUN=true` as routing "all adapters" through the generic
`lib/adapters/mock.ts`. But Milestone 4's own accept test requires "the log shows the exact
HubSpot calls that would be made for each event type" — a CRM-agnostic mock cannot produce that.

**What's actually built:** `lib/adapters/hubspot.ts` is DRY_RUN-aware at its own HTTP layer
(`hubspotFetch`/`simulatedResponse`) — every call it would make is logged with method, path, and
body, and a synthetic response is returned so the rest of the method's logic still runs, but no
request ever reaches HubSpot. `findRecord` specifically always simulates "not found" in dry-run,
so every fixture event exercises the create-record policy branches in `lib/dispatch.ts` rather
than short-circuiting.

`lib/adapters/mock.ts` (the literal §11 "mock adapter") still exists and is used directly by
`tests/dispatch.test.ts` and `tests/adapters.test.ts` as the CRM-agnostic fixture for testing the
dispatch decision tree itself, independent of any one real CRM's shape.

If a future CRM adapter is added, follow the HubSpot pattern (DRY_RUN-aware at the HTTP layer),
not a mock-swap — see `docs/ADDING-A-CRM.md`.

## Live HubSpot test — 25 Aug 2026 (real portal, real writes, DRY_RUN=false)

Tested against a real free HubSpot portal using a Service Key (HubSpot's current replacement for
what used to be called a Private App — same Bearer-token auth transport, renamed app-management
UI; `pat-na2-...` token format confirmed unchanged). Findings, all confirmed by re-fetching the
actual objects from HubSpot's API afterward, not just by reading a 200 response:

- **The marketing-contact billing risk (brief §10.1) is a non-issue, confirmed two ways.**
  `hs_marketable_status` is a read-only property via the API (`modificationMetadata.readOnlyValue: true`,
  confirmed via a live `GET /crm/v3/properties/contacts/hs_marketable_status`) — attempting to set
  it on create is silently ignored, not an error. And per HubSpot's own docs, *"Any integration or
  API sets contacts as non-marketing by default"*
  (https://knowledge.hubspot.com/contacts/default-marketing-statuses-for-created-contacts). The
  code that tried to set this property has been **removed** — it never did anything, and nothing
  needs to replace it.
- **`cymate_writeback_status` does not exist on a fresh portal and must be created.** The first
  `updateStatus` PATCH against a real client hits `PROPERTY_DOESNT_EXIST`. Fixed:
  `lib/adapters/hubspot.ts`'s `updateStatus` now self-heals — on that specific error it creates
  the property (`POST /crm/v3/properties/contacts`, plain single-line text) and retries once. No
  manual HubSpot setup step is required per client; confirmed the retry succeeds and the property
  persists correctly for later events on the same portal.
- **`crm.objects.deals.write` is a real, separate scope requirement**, not covered by
  `crm.objects.contacts.write`. Confirmed live: `createDeal` failed with
  `MISSING_SCOPES` (`crm.objects.deals.write` specifically) on a Service Key that only had the
  contacts/schemas scopes. Anyone setting up a client's Service Key needs this scope *only if*
  `behaviour.createDeal` will be turned on for them — otherwise skip it, per least-privilege.
- **HubSpot deal pipeline stage IDs are portal-specific, not universal strings.** The fixture
  originally set `dealStageOnCreate: "appointmentscheduled"` — a real stage ID from HubSpot's
  classic default pipeline — but this test portal's default pipeline uses raw numeric stage IDs
  instead (confirmed live via the resulting `INVALID_OPTION` error, which usefully lists the
  portal's actual valid IDs). Fixed by removing the hardcoded value from `fixtures/clients.json`.
- **Fixed — deal-stage picker.** Wizard step 10 now fetches the client's real pipeline stages
  (`CrmAdapter.listDealStages`, `GET /crm/v3/pipelines/deals`) and offers them by name instead of
  requiring a raw ID. Needs its own scope, confirmed live: `crm.objects.deals.read` (or
  `crm.schemas.deals.read`) — separate from `crm.objects.deals.write`, which alone is enough to
  create deals but not to list pipeline stages. Falls back to a plain text field if the fetch
  fails (missing scope, etc.), same graceful-degradation pattern used elsewhere.
- **HubSpot silently drops `dealstage` on create unless `pipeline` is sent alongside it** — no
  error, the property just comes back `null`. Confirmed live by isolating it with a raw API call:
  sending `dealstage` alone → `null` on read-back; sending `pipeline` + `dealstage` together →
  sticks correctly. `createDeal` in `lib/adapters/hubspot.ts` now resolves which pipeline a chosen
  stage belongs to (via the same pipelines endpoint the picker uses) and sends both. If a
  configured `dealStageOnCreate` can't be matched to any pipeline (e.g. a stale/hand-typed ID),
  it logs a warning and sends `dealstage` alone rather than blocking deal creation entirely.
- **Confirmed working end-to-end, real objects verified via GET afterward:** `findRecord` (real
  404 → not-found), `createRecord` (contact created with correct field-mapped properties),
  `writeActivity` (note created **and** correctly associated to the contact via the v4 default
  association endpoint), `updateStatus` (after the self-heal above), `createDeal` (deal created
  and correctly associated to the contact via the v4 default association endpoint, once the
  `crm.objects.deals.write` scope and a valid stage were in place).
- **Fixed:** the partial-success-lost-on-error gap this test session found (a later step like
  `createDeal` failing after earlier steps already succeeded used to make the whole event log as
  a bare `error` with no record of what actually worked). `DispatchOutcome`'s error variant now
  carries `actions`/`ref` — see `lib/dispatch.ts` and the regression test in
  `tests/dispatch.test.ts`. Re-verified live: the same real failure now correctly shows
  `actions: ["wrote_activity", "updated_status:meeting_booked"]` in `/log` instead of nothing.
  **Still open:** `markProcessed(event.eventId)` runs before the try block, so a retry of the
  *same* event after a partial failure is still skipped as a duplicate rather than retried — a
  failed `createDeal` won't get a second attempt just because the webhook fires again. Fixing that
  would mean deciding whether partial failures should count as "processed" at all, which trades
  off against the concurrent-duplicate-delivery protection idempotency exists for in the first
  place — a real design decision, not a one-line fix.

## Unresolved [VERIFY] items — confirm against live vendor docs/accounts before DRY_RUN=false

| Item | Where | Status |
| --- | --- | --- |
| Exact Smartlead webhook payload shape per event | `lib/sources/smartlead.ts` | Built against a documented, reasonable assumption. Not confirmed live. |
| Smartlead webhook signature/verification mechanism | `app/api/webhooks/smartlead/route.ts` | Not implemented at all — `SMARTLEAD_WEBHOOK_SECRET` is an unused env var placeholder. This endpoint is not verified against payload spoofing. |
| Smartlead webhook-registration endpoint + payload shape | `lib/sources/smartlead-api.ts` `registerSmartleadWebhook` | Best-guess path under the confirmed `server.smartlead.ai/api/v1` base. Path itself unconfirmed. |
| Smartlead lead-categories endpoint | `lib/sources/smartlead-api.ts` `listLeadCategories` | Same — confirmed base URL/auth style (`?api_key=` query param, **not** a bearer token — this was a real correction made during this build, see below), unconfirmed path. Fails soft to default suggestions in the wizard. |
| HubSpot rate limits | `lib/adapters/hubspot.ts` | Not checked live. Implemented: serial requests, single 429 retry with a 1s delay, no backoff system (by design — full backoff is out of scope). |

**What WAS confirmed live** (via HubSpot's/Smartlead's public docs and, for HubSpot, an actual
test portal — see the section above — so worth recording rather than re-checking):
- HubSpot: `GET /crm/v3/objects/contacts/{email}?idProperty=email` (find by email — simpler and
  more confirmed than a `/search` call, used instead of the brief's suggested search endpoint),
  `POST /crm/v3/objects/contacts` (create), `PATCH /crm/v3/objects/contacts/{id}` (update),
  `GET /crm/v3/properties/{objectType}` (describe fields), `POST /crm/v3/objects/notes` +
  `PUT /crm/v4/objects/notes/{id}/associations/default/contacts/{id}` (writeActivity),
  `POST /crm/v3/properties/{objectType}` (create a missing custom property).
- HubSpot's "Private Apps" UI has been renamed/replaced by "Service Keys" as of this pass — same
  underlying Bearer-token auth, no code changes needed, but future setup instructions for CSMs
  should say "Service Key" not "Private App".
- Smartlead: the real API host is `server.smartlead.ai/api/v1` — **not** `api.smartlead.ai`
  (that host serves the docs site only). Auth is an `api_key` query parameter, not a bearer
  token. This corrected an assumption that would otherwise have shipped wrong.

## Unresolved [ASK] items (brief §18) — do not guess, confirm with Balaaj/Jairo

1. **HubSpot status field** — should `updateStatus` drive `lifecyclestage`, `hs_lead_status`, or
   the custom `cymate_writeback_status` property this skeleton defaults to? The brief's own
   stated preference is a custom property "so we never fight their marketing automation" — that
   default is what's implemented, but it is still unconfirmed as a final decision.
2. **Airtable credentials** — who provisions the real `AIRTABLE_API_KEY` (personal access token
   scoped to base `applraTn50dXBSMrM`), Balaaj or Kenley.
3. **Demo client** — which real client record to use for a live walkthrough once the §5.2 fields
   exist. The brief notes Blue Mantis is Salesforce (blocked by the OutboundSync stub), so a
   HubSpot client is the better first live demo.
4. **HubSpot test account** — is there a Cymate HubSpot developer/sandbox portal for eventual
   `DRY_RUN=false` testing?
5. **GitHub org / repo name and Vercel project** — not created in this pass; built and committed
   locally only, per Balaaj's explicit instruction, pending a decision on where it lives.
6. **Smartlead native Salesforce connector** — disputed (see `lib/adapters/salesforce-outboundsync.ts`
   file header). Balaaj is verifying separately. If a native connector is confirmed, the
   Salesforce stub can be replaced by a real adapter — it sits behind the same `CrmAdapter`
   interface, so that's a drop-in replacement, not a rearchitecture.

## Known npm audit findings (accepted for this milestone)

`npm audit` flags several Next.js 14→16 advisories (Server Actions DoS, i18n Middleware bypass,
custom-server SSRF, WebSocket-upgrade SSRF, Image Optimization cache issues, etc.). This app uses
none of those surfaces — no Server Actions, no custom server, no i18n routing, no `next/image`
remote patterns, no Middleware. The only real fix npm offers is a major-version jump to Next 16,
which is a bigger decision than this milestone's tech-stack call (brief §4 pins "Next.js (App
Router)" without a major version) and wasn't asked for. `postcss` was bumped to a patched version
via an `overrides` entry in `package.json` since that one *was* a straightforward, non-breaking
fix. Re-run `npm audit` before deploying anywhere internet-facing and decide then whether to
upgrade Next.

## Deployment

- Not deployed to Vercel in this pass (scaffold-only, per explicit instruction). The app is
  structured as a standard Next.js App Router project with no non-Vercel-compatible dependencies,
  so `vercel deploy` (or the GitHub→Vercel integration) should work once a project is created —
  set the env vars from `.env.example` in the Vercel project settings first, especially leaving
  `DRY_RUN=true` until someone deliberately decides otherwise.
- Not pushed to a remote GitHub repo in this pass — committed locally only. Push once the repo
  name/org is decided (open item 5 above).
