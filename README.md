# CRM Delivery & Writeback — skeleton

Reference implementation of Cymate's S1 RevOps service (CRM Delivery & Writeback). This is
**not** the production system — it's a standalone proof of architecture, built so per-client
differences live as configuration, never as forked code or a hand-built Make.com scenario per
client. See `docs/HANDOVER.md` for exactly what production work remains.

## What this is

Smartlead campaign activity (sends, replies, bounces, unsubscribes, category/status changes)
flows into a client's CRM as contacts, activity notes, status updates, and (optionally) deals.
Per-client behaviour — which CRM, which fields map where, partial vs. full writeback, whether to
create records/deals — is all `ClientConfig`, sourced from Airtable (or `fixtures/clients.json`
for this skeleton).

**Deliverability rule, always on:** this app never subscribes to email open or link-click
tracking. That's disabled deliberately to protect sender domain reputation — see
`lib/sources/smartlead.ts`.

## Quick start

```bash
npm install
cp .env.example .env.local   # defaults: CONFIG_SOURCE=fixtures, DRY_RUN=true
npm run dev
```

Open `http://localhost:3000`. `/setup` walks through configuring a fixture client end to end;
`/log` shows every processed event with its outcome and, for skips, a machine-readable reason.

Fire a fixture event directly:

```bash
curl -X POST "http://localhost:3000/api/webhooks/smartlead?clientId=rec_acme_robotics" \
  -H "Content-Type: application/json" \
  --data @fixtures/smartlead-events/email-reply.json
```

Then check `/log`.

## DRY_RUN — read this before touching a real CRM

`DRY_RUN=true` is the default. With it on, the HubSpot adapter never makes a real HTTP call — it
logs the exact request (method, path, body) it would have sent and returns a synthetic result, so
the whole pipeline is demoable with zero real credentials. Setting `DRY_RUN=false` makes real API
calls against whatever CRM credentials are configured. Do not flip this in a shared environment
without everyone agreeing to it first.

## Config source

`CONFIG_SOURCE=fixtures` (default) reads `fixtures/clients.json`. `CONFIG_SOURCE=airtable` reads
the live Airtable base — but the CRM/writeback-specific fields don't exist there yet; see
`docs/AIRTABLE-FIELDS.md` for exactly what to add and where.

## Testing

```bash
npm run typecheck
npm test
```

Unit tests cover every dispatch skip reason, the mapper for all 7 approved Smartlead events, the
mock adapter's contract, and the Salesforce stub.

## Adding a CRM

See `docs/ADDING-A-CRM.md` — copy `lib/adapters/_template.ts`, implement it, add one line to the
registry in `lib/adapters/index.ts`.

## What's not built here

See `docs/HANDOVER.md` for the full list (Akaiza integration, a real secret store, a durable
queue, Salesforce direct integration, and more) plus every unresolved `[VERIFY]`/`[ASK]` item
carried over from the build brief.
