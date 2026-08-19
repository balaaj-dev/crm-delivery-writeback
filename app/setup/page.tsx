'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  CRM_TYPES,
  IMPLEMENTED_CRM_TYPES,
  MODE_PRESETS,
  DEFAULT_FIELD_MAP,
  type ClientConfig,
  type CrmType,
  type CrmFieldDescriptor,
  type FieldMapping,
  type WritebackMode,
} from '@/lib/types';

const STEP_TITLES = [
  'Select client',
  'Auto-populated summary',
  'Writeback mode',
  'Select CRM',
  'CRM branch',
  'CRM credentials',
  'Field mapping',
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
  const [planLimitAcknowledged, setPlanLimitAcknowledged] = useState(false);

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

  async function runBuild() {
    setBuilding(true);
    setBuildResult(null);
    try {
      const finalConfig: ClientConfig = {
        clientId: selectedClientId,
        clientName: selectedClient?.clientName ?? selectedClientId,
        activated: true,
        mode,
        source: selectedClient?.source ?? { platform: 'smartlead', apiKey: '' },
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

      await fetch(`/api/clients/${selectedClientId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(finalConfig),
      }).catch(() => null); // fixtures mode logs-only; failures here are non-fatal for the demo

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

      setBuildResult({ config: finalConfig, registration: registerData, testEvent: testEventData });
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
          after step 10.
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
            <NavButtons onBack={() => setStep(1)} onNext={() => setStep(3)} />
          </section>
        )}

        {step === 3 && (
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
            <NavButtons onBack={() => setStep(2)} onNext={() => setStep(4)} />
          </section>
        )}

        {step === 4 && (
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
            <NavButtons onBack={() => setStep(3)} onNext={() => setStep(5)} />
          </section>
        )}

        {step === 5 && (
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
            <NavButtons onBack={() => setStep(4)} onNext={() => setStep(6)} nextDisabled={isSalesforce} />
          </section>
        )}

        {step === 6 && (
          <section>
            <label className="block text-sm font-medium text-slate-700">
              {crmType === 'hubspot' ? 'HubSpot Private App access token' : 'Access token / API key'}
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
              onBack={() => setStep(5)}
              onNext={() => {
                loadFields();
                setStep(7);
              }}
              nextDisabled={!testResult?.ok}
            />
          </section>
        )}

        {step === 7 && (
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
            <NavButtons
              onBack={() => setStep(6)}
              onNext={() => {
                loadCategories();
                setStep(8);
              }}
            />
          </section>
        )}

        {step === 8 && (
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
            <NavButtons onBack={() => setStep(7)} onNext={() => setStep(9)} />
          </section>
        )}

        {step === 9 && (
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
                onChange={(e) => setCreateDeal(e.target.checked)}
              />
              Create a deal on positive reply / meeting booked
            </label>
            {createDeal && (
              <input
                className={inputClass}
                placeholder="Deal stage on create (optional)"
                value={dealStageOnCreate}
                onChange={(e) => setDealStageOnCreate(e.target.value)}
              />
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
              onBack={() => setStep(8)}
              onNext={() => setStep(10)}
              nextDisabled={mode === 'full' && !planLimitAcknowledged}
            />
          </section>
        )}

        {step === 10 && (
          <section>
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Client</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{selectedClient?.clientName}</dd>
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
            <NavButtons onBack={() => setStep(9)} onNext={() => {}} nextDisabled />
          </section>
        )}
      </div>
    </main>
  );
}
