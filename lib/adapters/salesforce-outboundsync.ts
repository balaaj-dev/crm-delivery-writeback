/**
 * Salesforce — stub only (brief §12).
 *
 * Jairo's decision on the 19 Aug 2026 call: Salesforce routes through
 * OutboundSync, a third-party middleware, as a paid custom add-on.
 * Native-connector CRMs (HubSpot, etc.) go direct. This adapter exists so
 * selecting Salesforce in the wizard behaves correctly (blocks with an
 * explanation) rather than silently pretending to work.
 *
 * Context: OutboundSync syncs Smartlead activity into Salesforce as Tasks
 * or EmailMessage records and can create/update Leads or
 * Accounts/Contacts. Smartlead has a confirmed native HubSpot connector;
 * whether it now has a genuine native Salesforce connector is disputed —
 * Smartlead's marketing page claims one, their help center has no setup
 * article for it, and OutboundSync (commercially interested in saying no)
 * says there is none. Do not resolve this in code — Balaaj is verifying
 * separately (brief §18.6). If a native connector is confirmed, this file
 * may be replaced by a real direct adapter; because everything sits behind
 * the same CrmAdapter interface, that is a drop-in replacement.
 */
import type { CanonicalEvent, ClientConfig, CrmAdapter, CrmRecordRef } from '../types';
import { NotImplementedError } from '../types';

const DETAIL =
  'Salesforce requires the OutboundSync add-on and CSM approval before writeback can run. ' +
  'This skeleton does not implement a direct Salesforce integration (brief §12) — raise an ' +
  'approval request for the OutboundSync add-on, or confirm a native connector is now ' +
  'available (see file header) before treating this as unblocked.';

export const salesforceOutboundSyncAdapter: CrmAdapter = {
  type: 'salesforce',
  integrationPath: 'outboundsync',

  async findRecord(_email: string, _cfg: ClientConfig): Promise<CrmRecordRef | null> {
    throw new NotImplementedError('salesforce', DETAIL);
  },

  async createRecord(_event: CanonicalEvent, _cfg: ClientConfig): Promise<CrmRecordRef> {
    throw new NotImplementedError('salesforce', DETAIL);
  },

  async writeActivity(): Promise<void> {
    throw new NotImplementedError('salesforce', DETAIL);
  },

  async updateStatus(): Promise<void> {
    throw new NotImplementedError('salesforce', DETAIL);
  },

  async createDeal(): Promise<void> {
    throw new NotImplementedError('salesforce', DETAIL);
  },

  async describeFields() {
    throw new NotImplementedError('salesforce', DETAIL);
  },

  async testConnection() {
    return {
      ok: false,
      message: 'Salesforce requires the OutboundSync add-on — raise an approval request.',
    };
  },
};
