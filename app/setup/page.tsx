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
    <ol className="mb-8 flex flex-wrap gap-2 text-xs">
      {STEP_TITLES.map((title, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <li
            key={title}
            className={`rounded-full px-3 py-1 ${
              active
                ? 'bg-slate-900 text-white'
                : done
                  ? 'bg-slate-200 text-slate-700'
                  : 'bg-slate-100 text-slate-400'
            }`}
          >
            {n}. {title}
          </li>
        );
      })}
    </ol>
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
    <div className="mt-8 flex justify-between">
      <button
        onClick={onBack}
        disabled={backDisabled}
        className="rounded-md border border-slate-300 px-4 py-2 text-sm disabled:opacity-30"
      >
        ← Back
      </button>
      <button
        onClick={onNext}
        disabled={nextDisabled}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-30"
      >
        {nextLabel}
      </button>
    </div>
  );
}

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
    <main className="mx-auto max-w-3xl px-6 py-10">
      <h1 className="text-xl font-semibold">Configure a client</h1>
      <p className="mt-1 text-sm text-slate-600">
        DRY_RUN is {process.env.NEXT_PUBLIC_DRY_RUN_HINT ?? 'on by default'} — no real CRM writes
        happen unless the server was started with DRY_RUN=false. Check the /log page after step 10.
      </p>
      <StepIndicator step={step} />

      {loadError && (
        <p className="mb-4 rounded bg-red-50 p-3 text-sm text-red-700">
          Failed to load clients: {loadError}
        </p>
      )}

      {step === 1 && (
        <section>
          <label className="block text-sm font-medium">Client</label>
          <select
            className="mt-2 w-full rounded border border-slate-300 p-2"
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
        <section className="space-y-2 text-sm">
          <p>
            <span className="font-medium">Smartlead API key:</span>{' '}
            {maskSecret(selectedClient.source.apiKey)}
          </p>
          <p>
            <span className="font-medium">Smartlead Client ID:</span>{' '}
            {selectedClient.source.smartleadClientId ?? '(not set)'}
          </p>
          <p>
            <span className="font-medium">Slack (external):</span>{' '}
            {selectedClient.notifications.slackExternalId ?? '(not set)'}
          </p>
          <p>
            <span className="font-medium">Slack (internal):</span>{' '}
            {selectedClient.notifications.slackInternalId ?? '(not set)'}
          </p>
          <p>
            <span className="font-medium">Slack (notifications):</span>{' '}
            {selectedClient.notifications.slackNotificationsId ?? '(not set)'}
          </p>
          <NavButtons onBack={() => setStep(1)} onNext={() => setStep(3)} />
        </section>
      )}

      {step === 3 && (
        <section className="space-y-4">
          {(['partial', 'full'] as WritebackMode[]).map((m) => (
            <label
              key={m}
              className={`block cursor-pointer rounded border p-4 ${
                mode === m ? 'border-slate-900' : 'border-slate-200'
              }`}
            >
              <input
                type="radio"
                name="mode"
                className="mr-2"
                checked={mode === m}
                onChange={() => applyModePreset(m)}
              />
              <span className="font-medium capitalize">{m}</span>
              <p className="mt-1 text-sm text-slate-600">
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
              return (
                <button
                  key={type}
                  onClick={() => setCrmType(type)}
                  className={`rounded border p-3 text-left text-sm capitalize ${
                    crmType === type ? 'border-slate-900' : 'border-slate-200'
                  }`}
                >
                  {type}
                  <div className="mt-1 text-xs text-slate-500">
                    {implemented ? 'Implemented' : type === 'salesforce' ? 'Add-on (OutboundSync)' : 'Not built yet'}
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
            <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              <p className="font-medium">Salesforce requires the OutboundSync add-on.</p>
              <p className="mt-2">
                This skeleton does not implement a direct Salesforce integration. Writeback for
                Salesforce clients routes through OutboundSync, a paid third-party add-on, and
                needs CSM approval before it can run. This wizard cannot complete a Salesforce
                setup — raise an approval request instead.
              </p>
            </div>
          ) : !isImplemented ? (
            <div className="rounded border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
              No adapter has been built yet for {crmType} in this skeleton. You can continue to see
              the rest of the wizard, but connecting and building will fail until an adapter exists
              — see docs/ADDING-A-CRM.md.
            </div>
          ) : (
            <p className="text-sm text-slate-600">
              {crmType} has a working adapter in this skeleton. Continue to enter credentials.
            </p>
          )}
          <NavButtons onBack={() => setStep(4)} onNext={() => setStep(6)} nextDisabled={isSalesforce} />
        </section>
      )}

      {step === 6 && (
        <section>
          <label className="block text-sm font-medium">
            {crmType === 'hubspot' ? 'HubSpot Private App access token' : 'Access token / API key'}
          </label>
          <input
            type="password"
            className="mt-2 w-full rounded border border-slate-300 p-2"
            value={credentials.accessToken ?? ''}
            onChange={(e) => setCredentials({ ...credentials, accessToken: e.target.value })}
            placeholder="Paste credential — never committed, stored only in Airtable/env for this skeleton"
          />
          <button
            onClick={runTestConnection}
            disabled={testing}
            className="mt-4 rounded border border-slate-300 px-4 py-2 text-sm"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          {testResult && (
            <p className={`mt-3 text-sm ${testResult.ok ? 'text-green-700' : 'text-red-700'}`}>
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
                <span className="w-48 font-mono text-xs text-slate-600">{mapping.canonical}</span>
                <select
                  className="flex-1 rounded border border-slate-300 p-2 text-sm"
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
            <p className="mb-4 rounded bg-amber-50 p-3 text-sm text-amber-800">{categoriesWarning}</p>
          )}
          <p className="mb-4 text-sm text-slate-600">
            Map each Smartlead lead category to a status value written into the CRM. Categories
            whose value is <code>positive_reply</code> or <code>meeting_booked</code> also unlock
            those event types for dispatch.
          </p>
          <div className="space-y-2">
            {Object.keys(statusMap).map((category) => (
              <div key={category} className="flex items-center gap-3">
                <span className="w-48 text-sm">{category}</span>
                <input
                  className="flex-1 rounded border border-slate-300 p-2 text-sm"
                  value={statusMap[category]}
                  onChange={(e) => setStatusMap({ ...statusMap, [category]: e.target.value })}
                />
              </div>
            ))}
            {categories
              .filter((c) => !(c.name in statusMap))
              .map((c) => (
                <div key={c.name} className="flex items-center gap-3">
                  <span className="w-48 text-sm">{c.name}</span>
                  <input
                    className="flex-1 rounded border border-slate-300 p-2 text-sm"
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
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={createRecordOnInterestedReply}
              onChange={(e) => setCreateRecordOnInterestedReply(e.target.checked)}
            />
            Create a record on interested reply
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={createRecordForAllLeads}
              onChange={(e) => setCreateRecordForAllLeads(e.target.checked)}
              disabled={mode !== 'full'}
            />
            Create a record for all leads (full mode only)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={createDeal} onChange={(e) => setCreateDeal(e.target.checked)} />
            Create a deal on positive reply / meeting booked
          </label>
          {createDeal && (
            <input
              className="w-full rounded border border-slate-300 p-2"
              placeholder="Deal stage on create (optional)"
              value={dealStageOnCreate}
              onChange={(e) => setDealStageOnCreate(e.target.value)}
            />
          )}
          {mode === 'full' && (
            <label className="flex items-start gap-2 rounded border border-amber-300 bg-amber-50 p-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={planLimitAcknowledged}
                onChange={(e) => setPlanLimitAcknowledged(e.target.checked)}
              />
              <span>
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
          <h2 className="font-medium">Review</h2>
          <ul className="mt-2 space-y-1 text-sm text-slate-700">
            <li>Client: {selectedClient?.clientName}</li>
            <li>Mode: {mode}</li>
            <li>CRM: {crmType}</li>
            <li>Field mappings: {fieldMap.length}</li>
            <li>Status mappings: {Object.keys(statusMap).length}</li>
          </ul>
          <button
            onClick={runBuild}
            disabled={building}
            className="mt-6 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-30"
          >
            {building ? 'Building…' : 'Write config, register webhooks, fire test event'}
          </button>
          {buildResult != null && (
            <pre className="mt-6 overflow-x-auto rounded bg-slate-900 p-4 text-xs text-slate-100">
              {JSON.stringify(buildResult, null, 2)}
            </pre>
          )}
          <p className="mt-4 text-sm">
            Check the <a className="underline" href="/log">event log</a> to confirm the test event
            landed correctly.
          </p>
          <NavButtons onBack={() => setStep(9)} onNext={() => {}} nextDisabled />
        </section>
      )}
    </main>
  );
}
