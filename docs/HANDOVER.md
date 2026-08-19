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

## Unresolved [VERIFY] items — confirm against live vendor docs/accounts before DRY_RUN=false

| Item | Where | Status |
| --- | --- | --- |
| Exact Smartlead webhook payload shape per event | `lib/sources/smartlead.ts` | Built against a documented, reasonable assumption. Not confirmed live. |
| Smartlead webhook signature/verification mechanism | `app/api/webhooks/smartlead/route.ts` | Not implemented at all — `SMARTLEAD_WEBHOOK_SECRET` is an unused env var placeholder. This endpoint is not verified against payload spoofing. |
| Smartlead webhook-registration endpoint + payload shape | `lib/sources/smartlead-api.ts` `registerSmartleadWebhook` | Best-guess path under the confirmed `server.smartlead.ai/api/v1` base. Path itself unconfirmed. |
| Smartlead lead-categories endpoint | `lib/sources/smartlead-api.ts` `listLeadCategories` | Same — confirmed base URL/auth style (`?api_key=` query param, **not** a bearer token — this was a real correction made during this build, see below), unconfirmed path. Fails soft to default suggestions in the wizard. |
| HubSpot non-marketing-contact property/mechanism | `lib/adapters/hubspot.ts` `MARKETING_STATUS_PROPERTY` | Implemented using `hs_marketable_status: 'false'` as the best-known mechanism. **Not confirmed live** — HubSpot's docs site 404'd the specific page checked during this build. This is a real financial-risk item (brief §10.1) — verify against a real HubSpot portal before any HubSpot client goes to `DRY_RUN=false`. |
| HubSpot notes-create + v4 default-association endpoint shape | `lib/adapters/hubspot.ts` `writeActivity`/`createDeal` | Same — docs 404'd live during this build. Implemented using the well-established `POST /crm/v3/objects/notes` + `PUT /crm/v4/objects/{type}/{id}/associations/default/{toType}/{toId}` pattern from HubSpot's general API conventions, not confirmed against the current docs in this pass. |
| HubSpot rate limits | `lib/adapters/hubspot.ts` | Not checked live. Implemented: serial requests, single 429 retry with a 1s delay, no backoff system (by design — full backoff is out of scope). |

**What WAS confirmed live during this build** (via HubSpot's and Smartlead's public developer
docs, so worth recording rather than re-checking):
- HubSpot: `GET /crm/v3/objects/contacts/{email}?idProperty=email` (find by email — simpler and
  more confirmed than a `/search` call, used instead of the brief's suggested search endpoint),
  `POST /crm/v3/objects/contacts` (create), `PATCH /crm/v3/objects/contacts/{id}` (update),
  `GET /crm/v3/properties/{objectType}` (describe fields).
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
