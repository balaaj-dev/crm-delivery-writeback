/**
 * Adapter registry (brief §9, §17.6). Adding a CRM means: write one file
 * (copy _template.ts), add one line here. See docs/ADDING-A-CRM.md.
 */
import type { ClientConfig, CrmAdapter, CrmType } from '../types';
import { NotImplementedError } from '../types';
import { hubspotAdapter } from './hubspot';
import { salesforceOutboundSyncAdapter } from './salesforce-outboundsync';

function notImplementedAdapter(type: CrmType): CrmAdapter {
  const detail = `No adapter has been built for ${type} in this skeleton yet. Copy lib/adapters/_template.ts to lib/adapters/${type}.ts, implement it, and register it here — see docs/ADDING-A-CRM.md.`;
  return {
    type,
    integrationPath: 'native',
    async findRecord() {
      throw new NotImplementedError(type, detail);
    },
    async createRecord() {
      throw new NotImplementedError(type, detail);
    },
    async writeActivity() {
      throw new NotImplementedError(type, detail);
    },
    async updateStatus() {
      throw new NotImplementedError(type, detail);
    },
    async describeFields() {
      throw new NotImplementedError(type, detail);
    },
    async testConnection() {
      return { ok: false, message: detail };
    },
  };
}

/** `() =>` factories, not bare instances, so a stateful adapter can't leak state across clients. */
export const ADAPTER_REGISTRY: Record<CrmType, () => CrmAdapter> = {
  hubspot: () => hubspotAdapter,
  salesforce: () => salesforceOutboundSyncAdapter,
  pipedrive: () => notImplementedAdapter('pipedrive'),
  zoho: () => notImplementedAdapter('zoho'),
  attio: () => notImplementedAdapter('attio'),
  gohighlevel: () => notImplementedAdapter('gohighlevel'),
  insightly: () => notImplementedAdapter('insightly'),
};

export function getAdapterForClient(cfg: ClientConfig): CrmAdapter {
  return ADAPTER_REGISTRY[cfg.crm.type]();
}

export function isDryRun(): boolean {
  return (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
}
