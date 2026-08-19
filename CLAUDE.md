# CLAUDE.md

Context for future AI-assisted work in this repo.

## What this is

A standalone reference implementation of Cymate's S1 CRM Delivery & Writeback service. Not the
production system — see `README.md` and `docs/HANDOVER.md`.

## Hard constraints — do not violate these

- **No LLM/AI SDK calls anywhere in the sync path** (webhook → dispatch → adapter). This repo
  exists specifically so it does not depend on Claude/Anthropic/OpenAI at runtime — see the
  build brief's §2.1. AI is fine for *writing* this code; it must not appear in the running path.
- **Never subscribe to or process `EMAIL_OPEN` / `EMAIL_LINK_CLICK`** Smartlead events. See
  `lib/sources/smartlead.ts`'s `FORBIDDEN_EVENT_TYPES` guard and the deliverability rule in the
  build brief §2.3.
- **Do not touch Akaiza.** Separate platform, separate team.
- **Do not read or write the `🖨️ CRM Automation (don't touch)` Airtable table**
  (`tblOccZhfaBN362uR`). Unrelated internal prospect pipeline.
- **Do not create Airtable fields programmatically.** Document new fields in
  `docs/AIRTABLE-FIELDS.md` instead.
- **`DRY_RUN` defaults to `true`.** Never make this default `false`.

## Where things live

- `lib/types.ts` — the contract everything depends on. Read this first.
- `lib/dispatch.ts` — the decision tree; takes an adapter as an explicit parameter so it's
  testable without touching env vars.
- `lib/adapters/` — one file per CRM, all implementing `CrmAdapter`. See `docs/ADDING-A-CRM.md`.
- `docs/HANDOVER.md` — every known limitation and every unverified vendor API assumption. Read
  before trusting any HTTP call shape in `lib/adapters/hubspot.ts` or `lib/sources/smartlead*.ts`.

## Testing

`npm test` (Vitest). Any change to `lib/dispatch.ts` should come with a corresponding test in
`tests/dispatch.test.ts` covering the new/changed branch, including its skip reason if it adds
one.
