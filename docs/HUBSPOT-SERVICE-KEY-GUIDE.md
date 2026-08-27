# Setting up a HubSpot Service Key for Cymate

Cymate's CRM writeback connects to your HubSpot account using a **Service Key** — HubSpot's name
for what used to be called a "Private App." It's a single access token, scoped to only the
permissions listed below, that lets Cymate create and update contacts, deals, and activity in your
portal on your behalf. It is not a login, doesn't expose your HubSpot password, and can be revoked
by you at any time from within HubSpot.

## Steps

1. Log into your HubSpot account as an admin (or a user with permission to create Private Apps).
2. Go to **Settings** (gear icon, top right) → **Integrations** → **Private Apps**. Depending on
   which HubSpot rollout you're on, this may instead be labeled **Service Keys** — same feature,
   HubSpot renamed it recently.
3. Click **Create a private app** (or **Create a service key**).
4. On the **Basic Info** tab, give it a name — e.g. `Cymate CRM Writeback`.
5. On the **Scopes** tab, enable the following. HubSpot groups these by object with Read/Write
   checkboxes — check exactly these boxes:

   | Object | Read | Write |
   | --- | --- | --- |
   | Contacts | ✅ | ✅ |
   | Companies | ✅ | ✅ |
   | Deals | ✅ | ✅ |
   | Owners | ✅ | — (no write option exists for this) |
   | Contact properties / schema | ✅ | ✅ |

   If your HubSpot instance shows more granular checkboxes than the table above, look for scope
   names containing `crm.objects.contacts`, `crm.objects.companies`, `crm.objects.deals`,
   `crm.objects.owners.read`, and `crm.schemas.contacts` — enable both read and write for each
   except owners, which is read-only.

   Leave everything else unchecked — Cymate's writeback doesn't touch marketing emails, workflows,
   tickets, or any other part of your portal.

6. Click **Create app** (or **Create service key**), then confirm on the warning dialog.
7. HubSpot shows you the access token **once**. Copy it immediately — it's a long string starting
   with `pat-`. If you navigate away before copying it, you'll need to regenerate it.
8. Send that token back to Cymate through a secure channel (not email or Slack in plain text —
   ask your Cymate contact for their preferred way to receive it).

## Why these specific scopes

Cymate's writeback needs to:
- **Find and create contacts** from your Smartlead campaign leads (Contacts read/write).
- **Find or create the company** each contact belongs to, based on their email domain, so contacts
  and deals are properly organized under the right company (Companies read/write).
- **Create deals** when a lead replies with genuine interest or books a meeting, and read your
  pipeline's stage names so Cymate's setup wizard can show you real stage names to pick from
  instead of raw IDs (Deals read/write).
- **List your HubSpot users** so a real person — not a default or whoever happens to be logged
  in — gets assigned as the owner of every contact and deal it creates (Owners read).
- **Create one small custom property** (`Cymate writeback status`) the first time it runs, to
  track lifecycle status without touching your existing lifecycle-stage or marketing automation
  setup (Contact properties/schema read/write).

## If something doesn't work

If Cymate reports an error mentioning `MISSING_SCOPES` followed by a specific permission name
(e.g. `crm.objects.companies.write`), that scope wasn't enabled. Go back to the Private App /
Service Key, add the missing scope on the Scopes tab, save, and the same token will pick up the
new permission automatically — no need to regenerate it or send a new token.

## Revoking access

If you ever need to cut off Cymate's access, go back to **Settings → Integrations → Private Apps
(or Service Keys)**, find the app, and click **Delete** (or **Deactivate**). The token stops
working immediately.
