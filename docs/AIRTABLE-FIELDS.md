# Airtable fields to add — 👨‍💻 Clients table

Base: `⚡ Cymate | Business OS` (`applraTn50dXBSMrM`)
Table: `👨‍💻 Clients` (`tblt13hM89s9U72J9`)

Verified live on **19 Aug 2026**: every field this app reads today (Business, Status, Record ID,
Smartlead API key, Smartlead Client ID, all three Slack IDs) already exists with the field IDs
hardcoded in [`lib/airtable.ts`](../lib/airtable.ts). A full search of every table in the base for
`CRM|HubSpot|Salesforce|Pipedrive|Zoho|Attio|GoHighLevel|Insightly|Writeback` turned up **no**
client-CRM configuration fields anywhere. The only CRM-adjacent field on this table is
`🖨️ CRM Automation (don't touch)` — that is Cymate's own internal prospect pipeline, unrelated to
client writeback. **Do not read or write it.**

This app does **not** create fields programmatically (see `docs/HANDOVER.md` and brief §17.3).
Add these by hand, then update `PENDING_WRITEBACK_FIELDS` in `lib/airtable.ts` with each field's
generated ID (visible in the Airtable API docs for the base, or via `list_tables_for_base` if
you're doing this through an Airtable MCP connection).

## Fields to add

| Field name | Type | Options | Purpose |
| --- | --- | --- | --- |
| 🔁 RevOps Writeback Activated | Single select | Yes / No | Master toggle — follows the same pattern as the existing Reports Activated fields |
| 🔁 Writeback Mode | Single select | Partial / Full | See §7.3 of the build brief — partial only writes on interested reply, full writes everything |
| 🔁 CRM Type | Single select | HubSpot, Pipedrive, Zoho, Attio, GoHighLevel, Insightly, Salesforce | Selects which adapter runs |
| 🔁 CRM Integration Path | Single select | Native / OutboundSync | Salesforce always forces OutboundSync |
| 🔁 CRM Credentials | Long text | — | JSON blob. Skeleton-grade only — plaintext in Airtable is not a production secret store, see HANDOVER.md |
| 🔁 CRM Field Map | Long text | — | JSON array of `{ canonical, crmObject, crmField, direction }` |
| 🔁 CRM Status Map | Long text | — | JSON object mapping raw Smartlead lead category → canonical status |
| 🔁 Create Record On Interested Reply | Single select | Yes / No | |
| 🔁 Create Record For All Leads | Single select | Yes / No | Full mode only, plan-gated |
| 🔁 Create Deal | Single select | Yes / No | |
| 🔁 Deal Stage On Create | Single line text | — | Optional |
| 🔁 Plan Limit Acknowledged | Single select | Yes / No | CSM confirms the client's CRM plan supports Full-mode contact volume |

## After adding

1. Open each field in Airtable, find its field ID (starts with `fld`).
2. Edit `lib/airtable.ts` → `PENDING_WRITEBACK_FIELDS` → replace the matching `null` with the real
   field ID string.
3. Set `CONFIG_SOURCE=airtable` and `AIRTABLE_API_KEY` locally or in Vercel, then hit
   `GET /api/clients` — clients with `🔁 RevOps Writeback Activated = Yes` should now resolve with
   a real CRM config instead of the safe `activated: false` default.
