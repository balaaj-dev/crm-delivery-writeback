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
- `lib/sources/smartlead-api.ts`'s `listCampaignLeads` (paginated via offset/limit) and
  `listLeadMessageHistory` — both confirmed live against a real account's real campaigns and real
  leads (`GET /campaigns/{id}/leads`, `GET /campaigns/{id}/leads/{leadId}/message-history`),
  read-only.
- `POST /api/delivery/run`, wizard step 9 ("Deliver contacts").
- **Deliberately capped** (`maxLeads`, default 25, hard ceiling 500) and synchronous — same "no
  durable job queue" decision as the rest of this repo (brief §3). Paginates across multiple
  Smartlead pages automatically up to the cap. A campaign with many thousands of leads still
  needs a real background job runner to deliver in full; this proves the mechanism, it is not
  that job runner. Never silently drops leads past the cap — `cappedAt` is always reported.
- **Backfills status and real activity for every processed lead, not just newly-created ones.**
  Found live, from a real client screenshot: a delivered contact showed no activity, no status,
  no "last contacted" — because the original version only created the bare contact. Fixed:
  `deliverCampaignLeads` now also (a) best-effort writes `cymate_writeback_status` from
  Smartlead's own sequence status (`delivered_<inprogress|completed|paused|...>`), and
  (b) fetches each lead's real message history and logs every message as a real HubSpot email
  engagement (see below), not a synthetic placeholder. A sub-step failing (bad history fetch,
  etc.) doesn't erase a lead that was otherwise found/created successfully — tracked separately
  in `DeliveryResult.activitiesLogged` and reported per-lead in `/log`.
- **`writeActivity` now logs real email engagements, not generic notes, for `email_sent`/`reply`.**
  Brief §10's own original intent ("for email events prefer the emails object") — this skeleton
  had simplified to notes-only for code-path uniformity; a real client's feedback (an empty
  activity timeline on a delivered contact) is what prompted actually building it. Confirmed live:
  `POST /crm/v3/objects/emails` + the same v4 default-association pattern notes use;
  `hs_email_status` only accepts `BOUNCED/FAILED/SCHEDULED/SENDING/SENT/DRAFT` (confirmed via a
  live validation error — direction, not status, is what distinguishes outbound/inbound); logging
  with the real historical `hs_timestamp` is what makes HubSpot's own `notes_last_contacted` (the
  contact-level "last contacted" HubSpot itself surfaces) populate correctly — confirmed live,
  no separate field for this adapter to set by hand. Non-email events (bounce, unsubscribe,
  status_change) still use notes, per the same brief guidance.
- **Verified live** (25 Aug 2026) against Lotus Labs' real Smartlead account (read-only lead and
  message-history fetching, their campaigns and running sequences untouched, no webhook
  registration attempted) delivering into the HubSpot test portal — never their real CRM.
  Confirmed: correct field mapping from real lead data, correct dedup on a second run
  (already-created leads skipped, not duplicated, but still status/activity-backfilled), real
  email engagements correctly associated and visible on the contact, `notes_last_contacted`
  correctly auto-populated by HubSpot from the logged activity, and results correctly show up in
  `/log`. Writeback (not just delivery) was also re-verified against real Lotus Labs lead
  identity/company data through the actual `/api/webhooks/smartlead` production route (not the
  `/api/test-event` shortcut), confirming the full dispatch decision tree — category promotion to
  `positive_reply`, the create-on-interested-reply policy, and the status write — all work
  correctly with real-shaped data end to end.
- **Still not built**: suppression list sync (a distinct, separate S1 delivery feature, still out
  of scope — see below) and anything resembling a real bulk-import job (progress tracking across
  requests spanning more than one HTTP call, resuming a partial import that failed midway).

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

- ~~In-memory idempotency, event log, and deal-creation dedupe~~ — **FIXED 28 Aug 2026.** All
  three (`lib/idempotency.ts`, `lib/log.ts`'s event log, `lib/dispatch.ts`'s `dealsCreatedForRef`)
  used to be plain in-memory state that reset on every Vercel cold start — a duplicate webhook
  delivery landing on a fresh instance could get reprocessed or create a second deal, and `/log`
  could look empty right after a real event actually ran. All three now persist to Upstash Redis
  (same `lib/kv.ts` connection as `lib/config.ts`/`lib/jobs.ts`) when `KV_REST_API_URL`/`TOKEN` are
  set, with the exact same in-memory fallback for local dev/tests where they aren't. Idempotency
  specifically got a correctness upgrade beyond just persistence: it's now one atomic Redis `SET
  NX` + TTL call (`kvSetNX`) instead of a separate check-then-mark, closing a real (if narrow) race
  window where two concurrent deliveries of the same webhook could both pass the check before
  either recorded it. Deal dedupe has no TTL (permanent key) since it should hold for the life of
  the CRM record, not just a retry window; idempotency uses a 7-day TTL.
- **Still no CRM-side "does a deal already exist" check** in the `CrmAdapter` interface — the
  dedupe above is this app's own bookkeeping, not a query against HubSpot itself. Would need
  adding if the KV-backed dedupe key were ever lost or cleared.
- **No live-verified real Smartlead webhook payload, still** — but the gap in how we'd respond to
  one is smaller now. `app/api/webhooks/smartlead/route.ts` captures the exact raw body of every
  call that passes the per-client secret check (valid or not) via `lib/log.ts`'s
  `recordRawWebhookPayload`, viewable at `/api/diagnostics/raw-webhooks` (behind the normal auth
  gate — deliberately not under `/api/webhooks/smartlead`, which middleware.ts excludes from auth
  entirely). Previously, a real payload that didn't match the assumed schema left nothing to fix
  the parser against beyond a list of validation issues. Still need an actual live event to land —
  see the chat history around 28 Aug 2026 for what was tried (Cymate's own test Smartlead account,
  reachable via this session's MCP connection, had no webhook delivery history on its test
  campaigns to retrigger) and what's left: either a real reply/bounce on an activated real client,
  or checking whether Smartlead's own dashboard has a manual "send test event" option.
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
  `setSessionOverride`/`applySessionOverrides`). Fixes a real bug found live: neither
  `fixtures/clients.json` (a static committed file) nor Airtable (write-back is a stub — see
  above) could actually persist what the wizard configures, so the wizard's own "fire a test
  event" step silently ran against stale data instead of what had just been selected — confirmed
  live with a deal-stage choice that was completely ignored. The first fix attempt used an
  in-memory `Map` and **did not work** — confirmed live that Next.js dev mode compiles different
  API route files as separate on-demand bundles, each getting its own independent instance of
  `lib/config.ts`'s top-level state, so a value set by the PUT route was invisible to
  `/api/webhooks/smartlead`'s route. **Takeaway for anything added later that needs cross-route
  shared state in this codebase: do not use a bare module-level variable — use the filesystem
  (locally) or a real store (in production).**

  The second fix attempt (a local JSON file at `data/client-overrides.json`) fixed local dev but
  **confirmed live 27 Aug 2026 to silently fail on Vercel** — the write threw on the read-only
  filesystem, was caught and logged at debug level (not surfaced), so `PUT
  /api/clients/[id]/config` reported `ok: true` while nothing actually persisted. A client
  activated through the wizard on Vercel was gone by the very next request; a real incoming
  webhook would have found it `activated: false` and silently skipped every event. Confirmed via
  the wizard's own step 11 build summary showing "Config not durably persisted" and the synthetic
  test event correctly skipping with reason `not_activated`.

  **Fixed for real 27 Aug 2026** by adding Upstash Redis (`lib/kv.ts`, via the Vercel↔Upstash
  Marketplace integration, free tier) as the persistence backend when `KV_REST_API_URL`/
  `KV_REST_API_TOKEN` are set (i.e. on Vercel with the integration connected), falling back to the
  local JSON file when they aren't (i.e. local dev — unchanged, verified live). `lib/jobs.ts`'s
  delivery-job records got the same fix in the same pass — its file-only version had no
  fallback/catch at all (unlike `lib/config.ts`'s), so it threw outright on Vercel: "Could not
  start any delivery jobs" for every campaign. Both now check `kvAvailable()` first.

  This did **not** fix everything about background delivery jobs on Vercel by itself — confirmed
  live the same day: a job record persisted correctly, but sat at status `"queued"` with zero
  progress indefinitely, because Vercel had already frozen the function instance that started it
  before it processed anything.

## Queue trigger for delivery jobs on Vercel (Upstash QStash, 27 Aug 2026)

Fixes the gap immediately above. `lib/jobs.ts`'s single long `while` loop (`runJob`) was split into
`processJobPage` — processes exactly one page of leads (`PAGE_SIZE`, reduced from 100 to 20 for
serverless safety — see that constant's comment) and returns whether more work remains — plus a
thin `runJob` wrapper that just loops `processJobPage` until done, unchanged behavior for local dev.

New self-chaining path when QStash is configured (`lib/qstash.ts`, `qstashAvailable()`):
`startDeliveryJob`/`resumeDeliveryJob` publish a "process this job" message to QStash instead of
running the job in-process. A new route, `app/api/delivery/jobs/[id]/process/route.ts`, handles that
message: verifies it really came from QStash (cryptographic signature, not Basic Auth — that route
is deliberately excluded from `middleware.ts`'s auth gate, since QStash can't present one), calls
`processJobPage` for one page, and — if there's more work — publishes the *next* chunk message back
to QStash targeting the same route. QStash delivers that as a fresh HTTP request, which Vercel runs
as a brand-new, un-frozen function instance. Repeats until the job reports no more work.

Local dev is unchanged and reconfirmed live after this refactor: `QSTASH_TOKEN` isn't set locally,
so `qstashAvailable()` is false, so `startDeliveryJob` falls through to the original in-process
`runJob` loop — ran a real job against Outspeak's campaign 3845003 after the refactor, completed
correctly (`status: "completed"`, same skip/create counts as before the change).

**Confirmed live 27 Aug 2026**, same day, once the Upstash QStash Marketplace integration was
connected on Vercel. First check was a stuck job from before the fix: resuming it moved its offset
from 5 to 185 in roughly 6–8 seconds — each chunk genuinely running as a fresh, un-frozen function
instance instead of the single frozen one that had been stuck at offset 5 indefinitely. Confirmed
again live during the actual Jairo demo the same day: a real delivery run against a real HubSpot
portal (DRY_RUN=false) reached `"completed"`, with 1 contact created, 1 deal created, and 5
activities logged — the exact failure mode this fix targets (jobs stuck at `"queued"`/`"running"`
forever) did not recur. `PUBLIC_BASE_URL` needing to be Vercel env type "Config" (not "Secret" —
see the Vercel-quirk note elsewhere in this doc) was a real blocker hit and fixed along the way;
once fixed, chunk hand-off was fast enough that a multi-hundred-lead campaign that used to hang
indefinitely completed within seconds.

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

## Live incident — partial-mode delivery ignored lead category (25 Aug 2026)

Found via a real Lotus Labs contact (Tracie Cranford, `tcranford@archgroup.com`) showing up in the
test HubSpot portal as a "Lead" despite never having replied — her only real Smartlead activity was
a bounce (`lead_category_id: 9`, name `"Sender Originated Bounce"`, confirmed via
`GET /leads/fetch-categories` — see below). Root cause: `deliverCampaignLeads` (`lib/delivery.ts`)
and the background job runner (`lib/jobs.ts`) created a CRM contact for **every** lead returned by
`GET /campaigns/{id}/leads`, with no regard for `cfg.mode` or the lead's actual category — this
defeats partial mode's entire premise (create a record only on a genuine interest signal).

**Fixed:** both files now call `resolveInterestCategoryIds` (new, `lib/sources/smartlead-api.ts`)
in partial mode, which resolves the client's own `statusMap` against the workspace's live
categories and only proceeds for leads whose `lead_category_id` maps to `positive_reply` or
`meeting_booked`. Full mode is unchanged (delivers everyone, by design). If the categories lookup
itself fails, delivery now throws rather than silently delivering everyone — fail safe, not fail
open. `lead_category_id` (confirmed live in the `GET /campaigns/{id}/leads` response, previously
discarded) now flows through `SmartleadLead`. Regression tests in `tests/delivery.test.ts`.

**Re-verified against Lotus Labs' 8 currently-ACTIVE campaigns** (not the ~72 draft/subsequence
campaigns Smartlead auto-generates alongside them), real reads, real writes to the test HubSpot
portal only, `DRY_RUN=false` for the duration of the run only: **10,579 leads scanned across all 8
campaigns, only 5 leads had a live category of Interested/Meeting Request, and only those 5 became
HubSpot contacts** (0 errors, 32 real email engagements logged — both outreach and reply content —
across the 5). Before this fix, all 10,579 would have been created. Tracie's stale test data
(`cymate_writeback_status` incorrectly showing "Interested" from an earlier ad hoc synthetic test
event fired to debug a separate missing-activity issue) was corrected to `"bounced"`; her
`lifecyclestage` remains HubSpot's own native `lead` — this app has never written to that field, so
there's nothing in our code to fix there, and it's a disposable test portal.

## Live incident — Airtable client dropdown returned zero clients (25 Aug 2026)

With a real `AIRTABLE_API_KEY` and `CONFIG_SOURCE=airtable`, `GET /api/clients` returned `{clients:
[]}` — no error, just empty. Root cause: `activeStatusFilter` in `lib/airtable.ts` compared the
Status field with `=== 'active'`, but the live base's actual option text is `'✅ Active'` (with an
emoji prefix) — confirmed by fetching the base directly (real values: `✅ Active`, `❌ Inactive`,
`🔄 Churning`, `🌙 Paused`, `⛵️Other`). Fixed by stripping non-letter characters before comparing
(not a plain `.includes('active')` — `'Inactive'` contains that substring too and must not match).
Confirmed live afterward: 30 real active clients now populate the wizard's dropdown.

Separately, `lib/config.ts`'s `applySessionOverrides` only ever replaced an existing client in the
list — a session override for a clientId not already present (e.g. testing a real Airtable client,
like Lotus Labs, whose Status isn't "Active" yet) silently vanished. Fixed to append any override
that doesn't match an existing entry, since the whole point of a session override is testing a
client outside the base list's normal filtering.

## Deal-stage-per-signal + company/deal association (27 Aug 2026)

Per Balaaj's feedback on a real HubSpot deal (Robert Watts/WattsAssociates.Org, id `344329258735`):
"will it automatically assign the interested deal stage?" (differentiated by signal type), "its not
creating a company record for the deal", and "I also can't see the info about this deal like last
contacted". Three changes, all in `lib/adapters/hubspot.ts` unless noted:

- `CrmAdapter.createDeal` (`lib/types.ts`) now takes a 4th argument, `dealSignal: 'positive_reply' |
  'meeting_booked'`, threaded through from `lib/dispatch.ts`'s already-computed `effectiveType` and
  from `lib/delivery.ts`/`lib/jobs.ts`'s `resolveInterestCategoryIds` (now returns a
  `Map<categoryId, signal>` instead of a `Set<categoryId>`, so callers know *which* signal matched,
  not just that one did). The wizard's step 9 ("Record behaviour") now shows two independent deal
  stage pickers — confirmed live against a real HubSpot portal (Outspeak's Service Key): both
  populate from the same live `listDealStages` call and hold independent values
  (`dealStageOnPositiveReply=4203141827` "Interested", `dealStageOnMeetingBooked=4203141830`
  "Meeting Booked" on that portal's real "Sales Outreach Pipeline").
- `findOrCreateCompany`/`associateWithCompany` — **not yet confirmed live**, see the VERIFY table
  below (missing `crm.objects.companies.*` scope on the token used this session).
- `findAssociatedDealIds`/`associateEngagementWithDeals` — extends `writeActivity` to also put the
  email/note engagement on any deal already associated with the contact, not just the contact
  itself, so `hs_engagements_last_contacted` populates on the deal too. Also not yet confirmed live
  (same session, same missing-scope blocker didn't block this one specifically, but it hasn't been
  separately exercised against a real portal either — see VERIFY table).

Also fixed in passing: step 3's copy still said "step 10 will ask which pipeline stage" for the
deal-stage picker — stale from before the wizard steps were reordered earlier this session; the
picker has been step 9 since then. Confirmed live the corrected copy renders.

## Local live test of company/deal association, and two real bugs it found (27 Aug 2026)

Balaaj asked directly whether company find/create and deal↔engagement association could be tested
locally rather than waiting on Vercel — yes: `DRY_RUN=false` plus a synthetic POST straight to
`/api/webhooks/smartlead` exercises the exact same code path a real webhook would, no tunnel or
deployment needed. Three requests against a real Outspeak/HubSpot portal (cleaned up after) found:

1. **`dealStageOnPositiveReply`/`dealStageOnMeetingBooked` were silently stripped on every config
   save.** `lib/schemas.ts`'s `clientConfigSchema` never got these two fields added when they were
   added to `lib/types.ts` earlier the same day — the exact same "z.object() strips unknown keys"
   bug class as the 26 Aug owner-guardrail incident. Every deal since the feature shipped landed
   with `dealstage: null, pipeline: null` despite the wizard's pickers showing real values. Fixed by
   adding both fields to the schema (see the ownerId comment right above them for the established
   pattern) — **whenever a field is added to `ClientConfig`, it must be added to `lib/schemas.ts` in
   the same change, not as a follow-up.**
2. **`writeActivity` ran before `createDeal`, so the deal-engagement association could never fire
   for a brand-new contact's first interested reply** — the single most common real case, where one
   dispatch call creates the record, writes the activity, *and* creates the deal. `findAssociatedDealIds`
   found nothing because the deal didn't exist yet when it ran. Fixed by reordering `lib/dispatch.ts`
   to create the deal before writing activity (step 7, was step 9) — confirmed live afterward:
   `deal_to_note` associations present on all three test deals.

**Update — fixed later the same day.** The duplicate-company finding above was real: HubSpot
auto-creates its own company the instant a contact's `website` property is set, independent of our
API calls, and that auto-created company was consistently invisible to
`GET /crm/v3/objects/companies/{domain}?idProperty=domain` even several seconds later. Per Balaaj's
direction, tried the search-based approach first: `POST /crm/v3/objects/companies/search` *does*
see the auto-created company, but not immediately — confirmed live it became searchable anywhere
from ~3s to ~3.5s after contact creation, so a single fixed retry wasn't reliable either (one test
run still produced a duplicate on a 2s wait). Final fix in `lib/adapters/hubspot.ts`:
`findOrCreateCompany` now searches (not GETs) up to 3 times, 3s apart, before creating — and when it
finds an existing company with no name (HubSpot's auto-created one never has one), it PATCHes in the
real name instead of leaving a nameless company just because we didn't have to create it ourselves.
Confirmed live across two more full test runs: exactly one company each time, correctly named. Adds
up to ~6s of latency, but only for a domain this adapter has never seen before — a repeat domain
resolves on the first, immediate search. All test data across every run in this section (5 contacts,
8 companies, 5 deals, 5 notes total) was created then deleted from the real portal.

## Unresolved [VERIFY] items — confirm against live vendor docs/accounts before DRY_RUN=false

| Item | Where | Status |
| --- | --- | --- |
| Exact Smartlead webhook payload shape per event | `lib/sources/smartlead.ts` | Built against a documented, reasonable assumption. Not confirmed live. |
| ~~Smartlead webhook signature/verification mechanism~~ | `app/api/webhooks/smartlead/route.ts` | **RESOLVED 26 Aug 2026.** Smartlead doesn't document a request-signing scheme, so this uses a shared secret instead: a random value generated per client at registration time, embedded in the registered URL, required on every call — a client with no secret configured (registration never run) rejects everything. Fail closed, not open. |
| ~~Smartlead webhook-registration endpoint + payload shape~~ | `lib/sources/smartlead-api.ts` `registerSmartleadWebhook` | **SUPERSEDED 27 Aug 2026.** The `POST /campaigns/{id}/webhooks` path (confirmed 26 Aug) worked, but is one webhook *per campaign* with no dedup — a real client with 8 active campaigns and several test runs accumulated 40+ duplicate webhooks in one day. Switched to `POST /webhook/create` with `association_type: 1` ("User Level"), confirmed live: one call registers a single account-wide webhook covering every campaign, present and future, and it accepts the exact same 7 event names already confirmed (including `LEAD_CATEGORY_UPDATED` — checked directly, since a different account-level webhook variant documented elsewhere in Smartlead's docs does NOT support it, which would have been a silent, serious regression). The response's `data.id.id` is the webhook's real id; `email_campaign_id: null` on read-back confirms account-wide scope. `DELETE /webhook/delete/{id}` works for webhooks created either the old or new way. **Still unverified**: what a live-fired event's actual JSON body looks like — registering successfully doesn't prove that. This has been the single biggest untested gap in this project since Milestone 2 and remains so; a documented generic example shows `{event, timestamp, campaign_id, lead: {...}, reply: {...}}`, which does NOT match this app's schema (`event_type`, `event_timestamp`, `lead_category`, etc.) — but that example is for a different, simpler webhook variant, so it may not apply here. Do not assume `lib/sources/smartlead.ts`'s parser is correct for a real payload until one has actually been received and inspected. |
| ~~Smartlead lead-categories endpoint~~ | `lib/sources/smartlead-api.ts` `listLeadCategories` | **CONFIRMED LIVE 25 Aug 2026** against a real Lotus Labs account: `GET /leads/fetch-categories?api_key=...` returns `[{id, name, sentiment_type}]`. Real category names differ from the brief's assumed defaults — Smartlead's own default set is `Interested`, `Meeting Request` (not "Meeting Booked"), `Not Interested`, `Do Not Contact`, `Information Request`, `Out Of Office`, `Wrong Person`, plus per-workspace custom categories like `Uncategorizable by Ai`/`Sender Originated Bounce`/`Nurturing`. `DEFAULT_STATUS_MAP` in `lib/types.ts` still says "Meeting Booked" — harmless because the wizard always overwrites it with a client's live categories (step 8), but worth fixing the constant itself so nobody copies it verbatim into a real client's statusMap. |
| HubSpot rate limits | `lib/adapters/hubspot.ts` | Not checked live. Implemented: serial requests, single 429 retry with a 1s delay, no backoff system (by design — full backoff is out of scope). |
| ~~HubSpot company find/create (`findOrCreateCompany`)~~ | `lib/adapters/hubspot.ts` | **CONFIRMED LIVE end-to-end 27 Aug 2026** via three real synthetic webhook POSTs to the actual `/api/webhooks/smartlead` route (DRY_RUN=false, real Outspeak HubSpot portal, cleaned up after). Company created, dealstage/pipeline set correctly, contact↔company and deal↔company associations all confirmed via direct API reads. See "Duplicate company on new-contact creation" below for a real issue this surfaced. |
| ~~HubSpot deal↔engagement association (`findAssociatedDealIds`/`associateEngagementWithDeals`)~~ | `lib/adapters/hubspot.ts` | **CONFIRMED LIVE end-to-end 27 Aug 2026**, same three-request test. Required a real fix first — see "Deal created after activity written" below; once fixed, `deal_to_note` associations confirmed via direct API reads on all three test deals. |

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

1. ~~**HubSpot status field**~~ — **RESOLVED 28 Aug 2026.** Balaaj's call: `hs_lead_status` (a
   standard field, not the custom `cymate_writeback_status` property this used to default to),
   specifically because every client's HubSpot account is configured differently — a standard
   field needs no per-portal setup, where a custom property's label/group/existence was all
   portal-specific. Implemented in `lib/adapters/hubspot.ts`: since `hs_lead_status` is an
   enumeration property, `ensureLeadStatusOption` adds a client's statusMap value as a new option
   before writing it, the first time that value is used per portal. **Not yet confirmed live** —
   see that function's own comment for exactly what's unverified before trusting this for a real
   client.
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

- Pushed to GitHub 27 Aug 2026: `https://github.com/balaaj-dev/crm-delivery-writeback` (private,
  Balaaj's personal account — the Cymate org was still blocked on Kenley's access grant at the
  time, so this is a working location, not necessarily the final one).
- Not yet deployed to Vercel — Kenley is being asked to do this. The app is a standard Next.js App
  Router project with no non-Vercel-compatible dependencies, so the GitHub→Vercel integration
  should work with zero build config. Env vars to set (see `.env.example` for the full picture):
  `CONFIG_SOURCE=airtable`, `AIRTABLE_API_KEY`, `DRY_RUN=true` (flip only right before the live
  webhook test, deliberately, with everyone aware), `PUBLIC_BASE_URL` (the assigned `*.vercel.app`
  URL — needs a second deploy pass once known), `SETUP_AUTH_USER`/`SETUP_AUTH_PASS` (genuinely
  needed now — see below), `CONFIG_ENCRYPTION_KEY` (generated this pass, see chat history — do not
  regenerate, or already-encrypted session data becomes unreadable).
- `middleware.ts`'s auth gate and `lib/crypto.ts`'s credential encryption are now **active
  locally** (27 Aug 2026, per Balaaj: "that's our responsibility, not Kenley's") — both set in
  `.env.local` and confirmed live: unauthenticated requests get gated, the Smartlead webhook route
  stays correctly exempt, valid credentials work, and a fresh config save lands on disk with the
  `enc:v1:` prefix (a stale pre-encryption entry in `data/client-overrides.json` confirmed this
  wasn't a false positive — only *new* writes are encrypted, existing plaintext entries stay as-is
  until next written). The same `SETUP_AUTH_USER`/`PASS`/`CONFIG_ENCRYPTION_KEY` values need to be
  set on Vercel too — see chat history for the actual values, do not regenerate
  `CONFIG_ENCRYPTION_KEY` independently or already-encrypted local data becomes unreadable.

### Branded login page replacing the Basic Auth dialog (27 Aug 2026)

Same evening as the item above: once the Basic Auth gate was confirmed working live on a Vercel
preview URL, Balaaj's reaction was "it worked but can't we have a good looking sign in page with
Cymate's brand colours" — the native browser credential dialog is browser chrome, not a stylable
page, so there was no way to reskin it directly. Replaced with a real session-cookie login flow:

- `lib/session.ts` — stateless HMAC-SHA256 session tokens (`${expiry}.${hmac}`, no session store,
  no DB). Verifying just recomputes the HMAC and checks it matches plus hasn't expired. Uses the
  **Web Crypto API** (`crypto.subtle`), not `node:crypto` — this file is imported by
  `middleware.ts`, and Next.js 14 middleware runs on the Edge runtime by default, which does not
  have `node:crypto`. First draft used `node:crypto`'s `createHmac`/`timingSafeEqual` and would
  have broken on Vercel (works fine in local `next dev` since that route only gets hit in Node
  contexts there in practice, but the Edge runtime constraint is real on deploy) — caught before
  pushing, not from a live failure.
- `app/login/page.tsx` — the actual branded page (navy/orange, same rounded-2xl card and
  `shadow-card` styling as the setup wizard). Posts to `app/api/login/route.ts`, which validates
  against `SETUP_AUTH_USER`/`PASS` (unchanged) and sets an `httpOnly` cookie
  (`cymate_session`, 7-day expiry). `app/api/logout/route.ts` clears it.
- `middleware.ts` now checks, in order: Basic Auth header (kept as a fallback — convenient for
  curl/script testing, and avoids breaking anything already relying on it) → the session cookie →
  otherwise gate. Content-negotiated on failure: `/api/*` paths get a plain 401 JSON body (so the
  wizard's own `fetch()` calls don't choke trying to `JSON.parse()` an HTML redirect page);
  everything else 307-redirects to `/login?next=<original path>`. `/login`, `/api/login`, and
  `/api/logout` are carved out of the gate itself (matcher-level, same pattern as the Smartlead
  webhook and QStash processor exemptions) — otherwise every request bounces to `/login` and the
  login page's own POST to `/api/login` would 401 before it could ever set the cookie.
- Nav bar (`app/layout.tsx` → `app/components/HeaderNav.tsx`) hides itself entirely on `/login`
  (a client component checking `usePathname()`) and otherwise shows a "Sign out" button
  (`app/components/LogoutButton.tsx`) next to the existing Setup/Event log links, gated on
  `SETUP_AUTH_USER`/`PASS` being set at all — same graceful no-auth-configured fallback as
  everywhere else in this app.
- Verified live locally end-to-end: unauthenticated `/setup` redirects to
  `/login?next=%2Fsetup`, submitting valid credentials lands back on `/setup` with the cookie set,
  unauthenticated `/api/clients` returns `401 {"error":"Authentication required"}` (not a
  redirect), Basic Auth still works as a fallback (`curl -u`), and "Sign out" clears the cookie and
  bounces back to `/login`. `tsc --noEmit`, `eslint .`, and `npm test` (44 tests) all clean.
  **Not yet re-verified on the actual Vercel deployment** — the Basic-Auth-only version was
  confirmed live there on 27 Aug 2026, but this cookie-based replacement hasn't been redeployed
  yet. Do that before assuming the branded page is what a fresh visitor to the `*.vercel.app` URL
  actually sees.
