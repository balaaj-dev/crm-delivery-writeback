# Adding a CRM

Adding support for a new CRM should mean: write one file, add one line. If it means more than
that, something has leaked out of the adapter boundary and needs fixing first.

## Steps

1. Copy `lib/adapters/_template.ts` to `lib/adapters/<your-crm>.ts` (e.g. `lib/adapters/pipedrive.ts`).
2. Rename the export (`templateAdapter` → e.g. `pipedriveAdapter`).
3. Set `type` to the matching `CrmType` from `lib/types.ts`, and `integrationPath` to `'native'`
   (or `'outboundsync'` if this CRM, like Salesforce, only integrates through third-party
   middleware).
4. Implement every method:
   - `findRecord` — search by email, return `null` on a genuine not-found. Do not throw for that case.
   - `createRecord` — create using `cfg.fieldMap` to know which canonical fields go where.
   - `writeActivity` — log an activity/note/engagement against the record.
   - `updateStatus` — write the mapped status value (from `cfg.statusMap`) somewhere sensible.
     See the HubSpot adapter's open question (§18.1 of the build brief) about whether this should
     be a native lifecycle field or a custom property — decide deliberately, don't default blindly.
   - `createDeal` (optional) — only implement if this CRM has a deal/opportunity concept relevant
     to writeback.
   - `describeFields` — return the CRM's real, writable fields so the wizard's field-mapping step
     can offer them.
   - `testConnection` — the cheapest possible authenticated call, used by the wizard before
     letting a CSM proceed.
5. Register it in `lib/adapters/index.ts` — one line in `ADAPTER_REGISTRY`.
6. Add it to `IMPLEMENTED_CRM_TYPES` in `lib/types.ts` so the wizard stops marking it "not built".
7. Write fixtures + a test file mirroring `tests/adapters.test.ts`.

## Rules that don't change per CRM

- **DRY_RUN.** Every real HTTP call your adapter makes must be gated so that when `DRY_RUN=true`
  (the default), no request reaches the real API — log the intended call instead and return a
  synthetic result. See `lib/adapters/hubspot.ts`'s `hubspotFetch`/`simulatedResponse` for the
  pattern to copy. Do not route through the generic `lib/adapters/mock.ts` for this — see the
  design-decision note in `docs/HANDOVER.md` for why.
- **Never guess vendor API shapes.** Anything you can't confirm against live docs gets a
  `[VERIFY]` comment and an entry in `docs/HANDOVER.md`, same pattern as the HubSpot adapter.
- **Never subscribe to open/click tracking events for any sending platform.** Not a CRM-adapter
  concern directly, but if your CRM adapter ever touches source-side webhook registration, the
  same deliverability rule applies (brief §2.3).
- **Billing safeguards are CRM-specific — think about them.** HubSpot bills per marketing
  contact; check whether your CRM has an equivalent volume-based cost before defaulting to
  "create everything."

## Testing without real credentials

`lib/adapters/mock.ts` is a fully in-memory `CrmAdapter` seeded with ~20 synthetic contacts. Use
it directly in dispatch/unit tests (see `tests/dispatch.test.ts`) — it is not part of the
registry lookup by CRM type, so it never accidentally stands in for a real adapter at runtime.
