'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CRM_TYPES,
  IMPLEMENTED_CRM_TYPES,
  MODE_PRESETS,
  DEFAULT_FIELD_MAP,
  type ClientConfig,
  type CrmType,
  type CrmDealStageDescriptor,
  type CrmFieldDescriptor,
  type FieldMapping,
  type WritebackMode,
} from '@/lib/types';

const STEP_TITLES = [
  'Select client',
  'Auto-populated summary',
  'Select campaigns',
  'Writeback mode',
  'Select CRM',
  'CRM branch',
  'CRM credentials',
  'Field mapping',
  'Deliver contacts',
  'Status mapping',
  'Record behaviour + plan check',
  'Review and build',
];

function maskSecret(value: string | undefined): string {
  if (!value) return '(not set)';
  if (value.length <= 4) return '••••';
  return `${value.slice(0, 2)}${'•'.repeat(Math.max(4, value.length - 4))}${value.slice(-2)}`;
}

function StepIndicator({ step }: { step: number }) {
  return (
    <div className="mb-8">
      <ol className="flex items-center">
        {STEP_TITLES.map((title, i) => {
          const n = i + 1;
          const state = n < step ? 'done' : n === step ? 'active' : 'upcoming';
          const isLast = n === STEP_TITLES.length;
          return (
            <li key={title} className={`flex items-center ${isLast ? '' : 'flex-1'}`}>
              <span
                className={`flex h-7 w-7 flex-none items-center justify-center rounded-full text-xs font-semibold transition ${
                  state === 'active'
                    ? 'bg-cymate-orange text-white ring-4 ring-cymate-orange/15'
                    : state === 'done'
                      ? 'bg-cymate-navy text-white'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                {state === 'done' ? '✓' : n}
              </span>
              {!isLast && (
                <span
                  className={`mx-1.5 h-0.5 flex-1 rounded-full transition ${
                    state === 'done' ? 'bg-cymate-navy' : 'bg-slate-200'
                  }`}
                />
              )}
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-cymate-orange">
        Step {step} of {STEP_TITLES.length}
      </p>
      <h2 className="font-display text-lg font-bold text-cymate-navy">{STEP_TITLES[step - 1]}</h2>
    </div>
  );
}

function NavButtons({
  onBack,
  onNext,
  backDisabled,
  nextDisabled,
  nextLabel = 'Next',
}: {
  onBack: () => void;
  onNext: () => void;
  backDisabled?: boolean;
  nextDisabled?: boolean;
  nextLabel?: string;
}) {
  return (
    <div className="mt-8 flex justify-between border-t border-slate-100 pt-6">
      <button
        onClick={onBack}
        disabled={backDisabled}
        className="rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-30"
      >
        ← Back
      </button>
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded-lg bg-cymate-orange px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-cymate-orange-dark disabled:cursor-not-allowed disabled:opacity-30"
      >
        {nextLabel}
      </button>
    </div>
  );
}

const inputClass =
  'w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-cymate-orange focus:outline-none focus:ring-2 focus:ring-cymate-orange/20';

export default function SetupWizard() {
  const [step, setStep] = useState(1);
  const [clients, setClients] = useState<ClientConfig[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string>('');

  const [campaigns, setCampaigns] = useState<{ id: string; name: string; status: string }[]>([]);
  const [campaignsWarning, setCampaignsWarning] = useState<string | null>(null);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([]);

  const [mode, setMode] = useState<WritebackMode>('partial');
  const [crmType, setCrmType] = useState<CrmType>('hubspot');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [fields, setFields] = useState<CrmFieldDescriptor[]>([]);
  const [fieldMap, setFieldMap] = useState<FieldMapping[]>(DEFAULT_FIELD_MAP);

  const [categories, setCategories] = useState<{ id: string | number; name: string }[]>([]);
  const [categoriesWarning, setCategoriesWarning] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});

  const [createRecordOnInterestedReply, setCreateRecordOnInterestedReply] = useState(true);
  const [createRecordForAllLeads, setCreateRecordForAllLeads] = useState(false);
  const [createDeal, setCreateDeal] = useState(false);
  const [dealStageOnCreate, setDealStageOnCreate] = useState('');
  const [dealStages, setDealStages] = useState<CrmDealStageDescriptor[]>([]);
  const [dealStagesWarning, setDealStagesWarning] = useState<string | null>(null);
  const [planLimitAcknowledged, setPlanLimitAcknowledged] = useState(false);

  const [deliveryMaxLeads, setDeliveryMaxLeads] = useState(25);
  const [deliveryResults, setDeliveryResults] = useState<
    Array<{
      campaignId: string;
      error?: string;
      result?: {
        totalLeadsInCampaign: number;
        processed: number;
        created: number;
        alreadyExisted: number;
        activitiesLogged: number;
        errors: Array<{ email: string; reason: string }>;
        cappedAt?: number;
      };
    }>
  >([]);
  const [delivering, setDelivering] = useState(false);

  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<unknown>(null);

  const selectedClient = useMemo(
    () => clients.find((c) => c.clientId === selectedClientId),
    [clients, selectedClientId],
  );

  useEffect(() => {
    fetch('/api/clients')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setLoadError(data.error);
        else setClients(data.clients ?? []);
      })
      .catch((err) => setLoadError(String(err)));
  }, []);

  function applyModePreset(next: WritebackMode) {
    setMode(next);
    const preset = MODE_PRESETS[next];
    setCreateRecordOnInterestedReply(preset.behaviour.createRecordOnInterestedReply ?? true);
    setCreateRecordForAllLeads(preset.behaviour.createRecordForAllLeads ?? false);
  }

  async function loadCampaigns() {
    const res = await fetch(`/api/smartlead/campaigns?clientId=${encodeURIComponent(selectedClientId)}`);
    const data = await res.json();
    setCampaigns(data.campaigns ?? []);
    setCampaignsWarning(data.warning ?? null);
  }

  async function runTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/crm/${crmType}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClientId, credentials }),
      });
      setTestResult(await res.json());
    } finally {
      setTesting(false);
    }
  }

  async function loadFields() {
    const res = await fetch(
      `/api/crm/${crmType}/fields?clientId=${encodeURIComponent(selectedClientId)}&objectType=contact`,
    );
    const data = await res.json();
    setFields(data.fields ?? []);
  }

  async function loadCategories() {
    const res = await fetch(`/api/smartlead/categories?clientId=${encodeURIComponent(selectedClientId)}`);
    const data = await res.json();
    setCategories(data.categories ?? []);
    setCategoriesWarning(data.warning ?? null);
    setStatusMap(data.defaultSuggestions ?? {});
  }

  async function loadDealStages() {
    const res = await fetch(
      `/api/crm/${crmType}/deal-stages?clientId=${encodeURIComponent(selectedClientId)}`,
    );
    const data = await res.json();
    setDealStages(data.stages ?? []);
    setDealStagesWarning(data.warning ?? null);
  }

  async function runDelivery() {
    setDelivering(true);
    setDeliveryResults([]);
    try {
      const results = [];
      for (const campaignId of selectedCampaignIds) {
        const res = await fetch('/api/delivery/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: selectedClientId, campaignId, maxLeads: deliveryMaxLeads }),
        });
        const data = await res.json();
        results.push({ campaignId, result: data.result, error: data.error });
      }
      setDeliveryResults(results);
    } finally {
      setDelivering(false);
    }
  }

  async function runBuild() {
    setBuilding(true);
    setBuildResult(null);
    try {
      const finalConfig: ClientConfig = {
        clientId: selectedClientId,
        clientName: selectedClient?.clientName ?? selectedClientId,
        activated: true,
        mode,
        source: {
          ...(selectedClient?.source ?? { platform: 'smartlead', apiKey: '' }),
          campaignIds: selectedCampaignIds,
        },
        crm: {
          type: crmType,
          integrationPath: crmType === 'salesforce' ? 'outboundsync' : 'native',
          credentials,
        },
        behaviour: {
          createRecordOnInterestedReply,
          createRecordForAllLeads,
          createDeal,
          dealStageOnCreate: dealStageOnCreate || undefined,
          planLimitAcknowledged,
        },
        events: MODE_PRESETS[mode].events,
        fieldMap,
        statusMap,
        notifications: selectedClient?.notifications ?? {},
      };

      // Awaited (not fire-and-forget) — this must complete before the test
      // event fires below, since it's what makes the test event (and any
      // real webhook after it) actually see what was just configured
      // instead of stale fixture/Airtable data. See lib/config.ts.
      const putRes = await fetch(`/api/clients/${selectedClientId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalConfig),
      });
      const putData = await putRes.json();

      const registerRes = await fetch('/api/webhooks/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClientId }),
      });
      const registerData = await registerRes.json();

      const testEventRes = await fetch('/api/test-event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: selectedClientId }),
      });
      const testEventData = await testEventRes.json();

      setBuildResult({
        config: finalConfig,
        persisted: putData.persisted,
        persistWarning: putData.persistWarning,
        registration: registerData,
        testEvent: testEventData,
      });
    } finally {
      setBuilding(false);
    }
  }

  const isSalesforce = crmType === 'salesforce';
  const isImplemented = (IMPLEMENTED_CRM_TYPES as string[]).includes(crmType);

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <div className="mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest text-cymate-orange">
          Cymate · RevOps
        </p>
        <h1 className="mt-1 font-display text-2xl font-bold text-cymate-navy">Configure a client</h1>
        <p className="mt-1 text-sm text-slate-500">
          No real CRM writes happen unless the server was started with DRY_RUN=false. Check the{' '}
          <a href="/log" className="font-medium text-cymate-navy underline decoration-cymate-cyan decoration-2 underline-offset-2">
            event log
          </a>{' '}
          after the last step.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8">
        <StepIndicator step={step} />

        {loadError && (
          <p className="mb-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            Failed to load clients: {loadError}
          </p>
        )}

        {step === 1 && (
          <section>
            <label className="block text-sm font-medium text-slate-700">Client</label>
            <select
              className={`mt-2 ${inputClass}`}
              value={selectedClientId}
              onChange={(e) => setSelectedClientId(e.target.value)}
            >
              <option value="">Select a client…</option>
              {clients.map((c) => (
                <option key={c.clientId} value={c.clientId}>
                  {c.clientName}
                </option>
              ))}
            </select>
            <NavButtons
              onBack={() => {}}
              onNext={() => setStep(2)}
              backDisabled
              nextDisabled={!selectedClientId}
            />
          </section>
        )}

        {step === 2 && selectedClient && (
          <section>
            <dl className="divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-100">
              {[
                ['Smartlead API key', maskSecret(selectedClient.source.apiKey)],
                ['Smartlead Client ID', selectedClient.source.smartleadClientId ?? '(not set)'],
                ['Slack (external)', selectedClient.notifications.slackExternalId ?? '(not set)'],
                ['Slack (internal)', selectedClient.notifications.slackInternalId ?? '(not set)'],
                ['Slack (notifications)', selectedClient.notifications.slackNotificationsId ?? '(not set)'],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 bg-slate-50/60 px-4 py-3 text-sm">
                  <dt className="font-medium text-slate-500">{label}</dt>
                  <dd className="font-mono text-slate-800">{value}</dd>
                </div>
              ))}
            </dl>
            <NavButtons
              onBack={() => setStep(1)}
              onNext={() => {
                loadCampaigns();
                setStep(3);
              }}
            />
          </section>
        )}

        {step === 3 && (
          <section>
            {campaignsWarning && (
              <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                {campaignsWarning}
              </p>
            )}
            <p className="mb-4 text-sm text-slate-600">
              Choose which Smartlead campaigns this client&apos;s writeback covers. Webhooks are only
              registered for campaigns selected here — pick nothing and nothing will sync.
            </p>
            {campaigns.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                No campaigns found for this client&apos;s Smartlead account yet.
              </p>
            ) : (
              <div className="space-y-2">
                {campaigns.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-cymate-orange"
                      checked={selectedCampaignIds.includes(c.id)}
                      onChange={(e) =>
                        setSelectedCampaignIds((prev) =>
                          e.target.checked ? [...prev, c.id] : prev.filter((id) => id !== c.id),
                        )
                      }
                    />
                    <span className="flex-1 text-cymate-navy">{c.name}</span>
                    <span className="text-xs uppercase text-slate-400">{c.status}</span>
                  </label>
                ))}
              </div>
            )}
            <NavButtons
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
              nextDisabled={campaigns.length > 0 && selectedCampaignIds.length === 0}
            />
          </section>
        )}

        {step === 4 && (
          <section className="space-y-3">
            {(['partial', 'full'] as WritebackMode[]).map((m) => (
              <label
                key={m}
                className={`block cursor-pointer rounded-xl border p-4 transition ${
                  mode === m
                    ? 'border-cymate-orange bg-cymate-orange/5 ring-1 ring-cymate-orange/30'
                    : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <span className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="mode"
                    className="accent-cymate-orange"
                    checked={mode === m}
                    onChange={() => applyModePreset(m)}
                  />
                  <span className="font-semibold capitalize text-cymate-navy">{m}</span>
                </span>
                <p className="mt-1 pl-6 text-sm text-slate-600">
                  {m === 'partial'
                    ? 'Only creates a CRM record when an interested reply arrives. Keeps HubSpot marketing-contact volume — and cost — low.'
                    : 'Writes every lead. Only appropriate when the client’s CRM plan supports the contact volume.'}
                </p>
              </label>
            ))}
            <NavButtons onBack={() => setStep(3)} onNext={() => setStep(5)} />
          </section>
        )}

        {step === 5 && (
          <section>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {CRM_TYPES.map((type) => {
                const implemented = (IMPLEMENTED_CRM_TYPES as string[]).includes(type);
                const selected = crmType === type;
                return (
                  <button
                    key={type}
                    onClick={() => setCrmType(type)}
                    className={`rounded-xl border p-3 text-left text-sm capitalize transition ${
                      selected
                        ? 'border-cymate-orange bg-cymate-orange/5 ring-1 ring-cymate-orange/30'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className="font-semibold text-cymate-navy">{type}</span>
                    <div className="mt-1.5">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                          implemented
                            ? 'bg-emerald-50 text-emerald-700'
                            : type === 'salesforce'
                              ? 'bg-cymate-orange/10 text-cymate-orange'
                              : 'bg-slate-100 text-slate-500'
                        }`}
                      >
                        {implemented ? 'Implemented' : type === 'salesforce' ? 'Add-on (OutboundSync)' : 'Not built yet'}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
            <NavButtons onBack={() => setStep(4)} onNext={() => setStep(6)} />
          </section>
        )}

        {step === 6 && (
          <section>
            {isSalesforce ? (
              <div className="rounded-xl border border-cymate-orange/30 bg-cymate-orange/5 p-4 text-sm text-cymate-navy">
                <p className="font-semibold text-cymate-orange">Salesforce requires the OutboundSync add-on.</p>
                <p className="mt-2 text-slate-600">
                  This skeleton does not implement a direct Salesforce integration. Writeback for
                  Salesforce clients routes through OutboundSync, a paid third-party add-on, and
                  needs CSM approval before it can run. This wizard cannot complete a Salesforce
                  setup — raise an approval request instead.
                </p>
              </div>
            ) : !isImplemented ? (
              <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                No adapter has been built yet for {crmType} in this skeleton. You can continue to see
                the rest of the wizard, but connecting and building will fail until an adapter exists
                — see docs/ADDING-A-CRM.md.
              </div>
            ) : (
              <p className="text-sm text-slate-600">
                <span className="font-semibold capitalize text-cymate-navy">{crmType}</span> has a
                working adapter in this skeleton. Continue to enter credentials.
              </p>
            )}
            <NavButtons onBack={() => setStep(5)} onNext={() => setStep(7)} nextDisabled={isSalesforce} />
          </section>
        )}

        {step === 7 && (
          <section>
            <label className="block text-sm font-medium text-slate-700">
              {crmType === 'hubspot' ? 'HubSpot Service Key access token' : 'Access token / API key'}
            </label>
            <input
              type="password"
              className={`mt-2 ${inputClass}`}
              value={credentials.accessToken ?? ''}
              onChange={(e) => setCredentials({ ...credentials, accessToken: e.target.value })}
              placeholder="Paste credential — never committed, stored only in Airtable/env for this skeleton"
            />
            <button
              onClick={runTestConnection}
              disabled={testing}
              className="mt-4 rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
            >
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            {testResult && (
              <p
                className={`mt-3 rounded-lg px-3 py-2 text-sm ${
                  testResult.ok
                    ? 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200'
                    : 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200'
                }`}
              >
                {testResult.message}
              </p>
            )}
            <NavButtons
              onBack={() => setStep(6)}
              onNext={() => {
                loadFields();
                setStep(8);
              }}
              nextDisabled={!testResult?.ok}
            />
          </section>
        )}

        {step === 8 && (
          <section>
            <p className="mb-4 text-sm text-slate-600">
              Canonical field on the left, real {crmType} field on the right. Pre-filled with sane
              defaults — adjust per client.
            </p>
            <div className="space-y-2">
              {fieldMap.map((mapping, i) => (
                <div key={mapping.canonical} className="flex items-center gap-3">
                  <span className="w-44 flex-none rounded-md bg-slate-50 px-2 py-1.5 font-mono text-xs text-slate-600">
                    {mapping.canonical}
                  </span>
                  <select
                    className={inputClass}
                    value={mapping.crmField}
                    onChange={(e) => {
                      const next = [...fieldMap];
                      next[i] = { ...mapping, crmField: e.target.value };
                      setFieldMap(next);
                    }}
                  >
                    {fields.length === 0 && <option value={mapping.crmField}>{mapping.crmField}</option>}
                    {fields.map((f) => (
                      <option key={f.name} value={f.name}>
                        {f.label} ({f.name})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <NavButtons onBack={() => setStep(7)} onNext={() => setStep(9)} />
          </section>
        )}

        {step === 9 && (
          <section>
            <p className="mb-4 text-sm text-slate-600">
              The other half of S1 — bulk-create CRM records for leads that already exist in the
              campaigns selected in step 3, independent of any reply or activity. Separate from
              writeback, which only reacts to new events going forward.
            </p>
            {selectedCampaignIds.length === 0 ? (
              <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                No campaigns were selected in step 3 — go back and select at least one to deliver
                leads from.
              </p>
            ) : (
              <>
                <label className="block text-sm font-medium text-slate-700">
                  Max leads per campaign (safety cap)
                </label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  className={`mt-2 w-40 ${inputClass}`}
                  value={deliveryMaxLeads}
                  onChange={(e) => setDeliveryMaxLeads(Math.min(500, Math.max(1, Number(e.target.value) || 1)))}
                />
                <p className="mt-1 text-xs text-slate-500">
                  Paginates across multiple Smartlead pages automatically, up to a hard ceiling of
                  500 leads per run. Delivering a whole larger campaign at once needs a real background job runner,
                  not built in this skeleton — this cap keeps a single request bounded.
                </p>
                <button
                  onClick={runDelivery}
                  disabled={delivering}
                  className="mt-4 rounded-lg bg-cymate-orange px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-cymate-orange-dark disabled:opacity-50"
                >
                  {delivering
                    ? 'Delivering…'
                    : `Deliver leads from ${selectedCampaignIds.length} campaign${selectedCampaignIds.length === 1 ? '' : 's'}`}
                </button>

                {deliveryResults.length > 0 && (
                  <div className="mt-4 space-y-2">
                    {deliveryResults.map((r) => (
                      <div key={r.campaignId} className="rounded-lg border border-slate-200 p-3 text-sm">
                        <p className="font-medium text-cymate-navy">Campaign {r.campaignId}</p>
                        {r.error ? (
                          <p className="mt-1 text-rose-700">{r.error}</p>
                        ) : r.result ? (
                          <div className="mt-1 text-slate-600">
                            <p>
                              {r.result.created} created · {r.result.alreadyExisted} already existed ·{' '}
                              {r.result.activitiesLogged} activities logged · {r.result.errors.length} errors
                              {r.result.cappedAt
                                ? ` · capped at ${r.result.cappedAt} of ${r.result.totalLeadsInCampaign} total leads`
                                : ''}
                            </p>
                            {r.result.errors.length > 0 && (
                              <ul className="mt-1 list-inside list-disc text-xs text-rose-700">
                                {r.result.errors.map((e) => (
                                  <li key={e.email}>
                                    {e.email}: {e.reason}
                                  </li>
                                ))}
                              </ul>
                            )}
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
            <NavButtons
              onBack={() => setStep(8)}
              onNext={() => {
                loadCategories();
                setStep(10);
              }}
            />
          </section>
        )}

        {step === 10 && (
          <section>
            {categoriesWarning && (
              <p className="mb-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                {categoriesWarning}
              </p>
            )}
            <p className="mb-4 text-sm text-slate-600">
              Map each Smartlead lead category to a status value written into the CRM. Categories
              whose value is <code className="rounded bg-slate-100 px-1 py-0.5">positive_reply</code> or{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5">meeting_booked</code> also unlock
              those event types for dispatch.
            </p>
            <div className="space-y-2">
              {Object.keys(statusMap).map((category) => (
                <div key={category} className="flex items-center gap-3">
                  <span className="w-44 flex-none text-sm text-slate-700">{category}</span>
                  <input
                    className={inputClass}
                    value={statusMap[category]}
                    onChange={(e) => setStatusMap({ ...statusMap, [category]: e.target.value })}
                  />
                </div>
              ))}
              {categories
                .filter((c) => !(c.name in statusMap))
                .map((c) => (
                  <div key={c.name} className="flex items-center gap-3">
                    <span className="w-44 flex-none text-sm text-slate-700">{c.name}</span>
                    <input
                      className={inputClass}
                      placeholder="e.g. nurture"
                      onChange={(e) => setStatusMap({ ...statusMap, [c.name]: e.target.value })}
                    />
                  </div>
                ))}
            </div>
            <NavButtons onBack={() => setStep(9)} onNext={() => setStep(11)} />
          </section>
        )}

        {step === 11 && (
          <section className="space-y-4 text-sm">
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cymate-orange"
                checked={createRecordOnInterestedReply}
                onChange={(e) => setCreateRecordOnInterestedReply(e.target.checked)}
              />
              Create a record on interested reply
            </label>
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cymate-orange"
                checked={createRecordForAllLeads}
                onChange={(e) => setCreateRecordForAllLeads(e.target.checked)}
                disabled={mode !== 'full'}
              />
              Create a record for all leads (full mode only)
            </label>
            <label className="flex items-center gap-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 accent-cymate-orange"
                checked={createDeal}
                onChange={(e) => {
                  setCreateDeal(e.target.checked);
                  if (e.target.checked && dealStages.length === 0 && !dealStagesWarning) {
                    loadDealStages();
                  }
                }}
              />
              Create a deal on positive reply / meeting booked
            </label>
            {createDeal && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Deal stage on create
                </label>
                {dealStagesWarning && (
                  <p className="mb-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                    Couldn&apos;t fetch real stages from {crmType} ({dealStagesWarning}). Enter the
                    stage ID manually, or leave blank to use the pipeline&apos;s default stage.
                  </p>
                )}
                {dealStages.length > 0 ? (
                  <select
                    className={inputClass}
                    value={dealStageOnCreate}
                    onChange={(e) => setDealStageOnCreate(e.target.value)}
                  >
                    <option value="">Use the pipeline&apos;s default stage</option>
                    {dealStages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.pipelineLabel} — {s.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={inputClass}
                    placeholder="Deal stage ID (optional — leave blank for the pipeline default)"
                    value={dealStageOnCreate}
                    onChange={(e) => setDealStageOnCreate(e.target.value)}
                  />
                )}
              </div>
            )}
            {mode === 'full' && (
              <label className="flex items-start gap-2.5 rounded-xl border border-cymate-orange/30 bg-cymate-orange/5 p-3">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 accent-cymate-orange"
                  checked={planLimitAcknowledged}
                  onChange={(e) => setPlanLimitAcknowledged(e.target.checked)}
                />
                <span className="text-cymate-navy">
                  Confirm this client&apos;s CRM plan supports the contact volume that Full mode will
                  create. HubSpot and similar CRMs bill per marketing contact — Full mode writes
                  every lead.
                </span>
              </label>
            )}
            <NavButtons
              onBack={() => setStep(10)}
              onNext={() => setStep(12)}
              nextDisabled={mode === 'full' && !planLimitAcknowledged}
            />
          </section>
        )}

        {step === 12 && (
          <section>
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Client</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{selectedClient?.clientName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Campaigns</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{selectedCampaignIds.length}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Mode</dt>
                <dd className="mt-0.5 font-medium capitalize text-cymate-navy">{mode}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">CRM</dt>
                <dd className="mt-0.5 font-medium capitalize text-cymate-navy">{crmType}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Field mappings</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{fieldMap.length}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Status mappings</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{Object.keys(statusMap).length}</dd>
              </div>
            </dl>

            {selectedCampaignIds.length === 0 && (
              <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                No campaigns selected — webhook registration will fail until at least one is chosen
                back in step 3.
              </p>
            )}

            <button
              onClick={runBuild}
              disabled={building}
              className="mt-6 rounded-lg bg-cymate-orange px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-cymate-orange-dark disabled:opacity-50"
            >
              {building ? 'Building…' : 'Write config, register webhooks, fire test event'}
            </button>

            {buildResult != null && (
              <pre className="mt-6 max-h-96 overflow-auto rounded-xl bg-cymate-navy-dark p-4 text-xs text-cymate-cyan/90">
                {JSON.stringify(buildResult, null, 2)}
              </pre>
            )}

            <p className="mt-4 text-sm text-slate-600">
              Check the{' '}
              <a
                className="font-medium text-cymate-navy underline decoration-cymate-cyan decoration-2 underline-offset-2"
                href="/log"
              >
                event log
              </a>{' '}
              to confirm the test event landed correctly.
            </p>
            <NavButtons onBack={() => setStep(11)} onNext={() => {}} nextDisabled />
          </section>
        )}
      </div>
    </main>
  );
}
