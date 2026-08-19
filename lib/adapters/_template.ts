/**
 * TEMPLATE — copy this file to lib/adapters/<your-crm>.ts, rename
 * TemplateAdapter, fill in every TODO, then register it in
 * lib/adapters/index.ts. See docs/ADDING-A-CRM.md for the full walkthrough.
 *
 * Do not import this file anywhere — it is a starting point, not a runtime
 * adapter, and is intentionally excluded from the registry.
 */
/* eslint-disable @typescript-eslint/no-unused-vars -- template signatures document the real params */
import type {
  CanonicalEvent,
  ClientConfig,
  CrmAdapter,
  CrmFieldDescriptor,
  CrmRecordRef,
} from '../types';

export const templateAdapter: CrmAdapter = {
  type: 'hubspot', // TODO: change to your CrmType
  integrationPath: 'native', // TODO: 'native' or 'outboundsync'

  async findRecord(email: string, cfg: ClientConfig): Promise<CrmRecordRef | null> {
    // TODO: search the CRM for a contact/lead by email using cfg.crm.credentials.
    // Return null if not found — do not throw for a normal "not found" case.
    throw new Error('templateAdapter.findRecord not implemented');
  },

  async createRecord(event: CanonicalEvent, cfg: ClientConfig): Promise<CrmRecordRef> {
    // TODO: create the record, mapping fields via cfg.fieldMap.
    throw new Error('templateAdapter.createRecord not implemented');
  },

  async writeActivity(ref: CrmRecordRef, event: CanonicalEvent, cfg: ClientConfig): Promise<void> {
    // TODO: log an activity/engagement/note against ref.
    throw new Error('templateAdapter.writeActivity not implemented');
  },

  async updateStatus(ref: CrmRecordRef, status: string, cfg: ClientConfig): Promise<void> {
    // TODO: write `status` to whatever field cfg/this CRM uses for lifecycle stage.
    throw new Error('templateAdapter.updateStatus not implemented');
  },

  // createDeal is optional — omit entirely if this CRM has no deal/opportunity concept
  // relevant to writeback, or implement it following the same pattern as the others.

  async describeFields(cfg: ClientConfig, objectType: string): Promise<CrmFieldDescriptor[]> {
    // TODO: return the real, writable fields for objectType so the wizard's
    // field-mapping step (brief §13 step 7) can offer them as choices.
    return [];
  },

  async testConnection(cfg: ClientConfig): Promise<{ ok: boolean; message: string }> {
    // TODO: make the cheapest possible authenticated request and report the result.
    return { ok: false, message: 'templateAdapter.testConnection not implemented' };
  },
};
