'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CRM_TYPES,
  IMPLEMENTED_CRM_TYPES,
  DEFAULT_FIELD_MAP,
  type ClientConfig,
  type CrmType,
  type CrmDealStageDescriptor,
  type CrmFieldDescriptor,
  type CrmOwnerDescriptor,
  type FieldMapping,
  type WritebackMode,
} from '@/lib/types';

/**
 * Step order reshaped per Jairo's 26 Aug 2026 feedback: the decisions that
 * determine everything downstream (record type, sync scope) now happen
 * right after the client summary instead of being scattered across the old
 * steps 3/4/11 — because whether this is a deal or just a contact changes
 * what step 7 needs to ask for (deal owner + stage vs. just a contact
 * owner), that choice can't come late. Old steps 3 (campaigns) and 4
 * (partial/full) and step 11's create-deal toggle are merged into the new
 * step 3 below; step 11 is now a slimmed "configure the deal" step that
 * only applies once record type is already decided.
 */
const STEP_TITLES = [
  'Select client',
  'Auto-populated summary',
  'Sync scope & record type',
  'Select CRM',
  'CRM branch',
  'CRM credentials',
  'Field mapping',
  'Status mapping',
  'Deliver contacts',
  'Record behaviour',
  'Review and build',
];

type SyncScope = 'positive_replies_only' | 'all_contacts' | 'specific_campaigns';

interface DeliveryJobView {
  id: string;
  campaignId: string;
  status: string;
  processed: number;
  created: number;
  alreadyExisted: number;
  activitiesLogged: number;
  skippedNotInterested: number;
  totalLeadsInCampaign?: number;
  errors: Array<{ email: string; reason: string }>;
}

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

/**
 * The status-mapping step used to be a bare free-text box (found live,
 * 26 Aug 2026) — technically fine, since the HubSpot property this writes
 * to (cymate_writeback_status) is a plain text field with no enum to
 * enforce. But exactly two of these strings — positive_reply and
 * meeting_booked — aren't just labels: they're what this app's own
 * dispatch logic matches on to unlock the "genuinely interested" delivery
 * filter and deal creation (see lib/dispatch.ts's PROMOTABLE_TYPES). A
 * typo in either one silently does nothing, with no error anywhere. This
 * is the fixed set of values that actually mean something to the app;
 * anything else is a real custom label, which stays free text.
 */
const STATUS_VALUE_OPTIONS = [
  { value: 'positive_reply', label: 'positive_reply — unlocks delivery + deal creation' },
  { value: 'meeting_booked', label: 'meeting_booked — unlocks delivery + deal creation' },
  { value: 'closed_lost', label: 'closed_lost' },
  { value: 'nurture', label: 'nurture' },
  { value: 'referral', label: 'referral' },
  { value: 'ignore', label: 'ignore' },
  { value: 'unsubscribed', label: 'unsubscribed' },
];
const CUSTOM_STATUS_VALUE = '__custom__';

function StatusValueField({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const known = STATUS_VALUE_OPTIONS.some((o) => o.value === value);
  const [customMode, setCustomMode] = useState(value !== '' && !known);

  return (
    <div className="flex-1 space-y-1.5">
      <select
        className={inputClass}
        value={customMode ? CUSTOM_STATUS_VALUE : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM_STATUS_VALUE) {
            setCustomMode(true);
            onChange('');
          } else {
            setCustomMode(false);
            onChange(e.target.value);
          }
        }}
      >
        <option value="">Select a status value…</option>
        {STATUS_VALUE_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        <option value={CUSTOM_STATUS_VALUE}>Custom…</option>
      </select>
      {customMode && (
        <input
          className={inputClass}
          value={value}
          placeholder="Custom status value"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}

export default function SetupWizard() {
  const [step, setStep] = useState(1);
  const [clients, setClients] = useState<ClientConfig[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string>('');

  const [campaigns, setCampaigns] = useState<{ id: string; name: string; status: string }[]>([]);
  const [campaignsWarning, setCampaignsWarning] = useState<string | null>(null);
  const [selectedCampaignIds, setSelectedCampaignIds] = useState<string[]>([]);

  const [syncScope, setSyncScope] = useState<SyncScope>('positive_replies_only');
  const [mode, setMode] = useState<WritebackMode>('partial');
  const [createRecordOnInterestedReply, setCreateRecordOnInterestedReply] = useState(true);
  const [createRecordForAllLeads, setCreateRecordForAllLeads] = useState(false);
  const [createDeal, setCreateDeal] = useState(false);

  const [crmType, setCrmType] = useState<CrmType>('hubspot');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testing, setTesting] = useState(false);

  const [fields, setFields] = useState<CrmFieldDescriptor[]>([]);
  const [fieldMap, setFieldMap] = useState<FieldMapping[]>(DEFAULT_FIELD_MAP);

  const [owners, setOwners] = useState<CrmOwnerDescriptor[]>([]);
  const [ownersWarning, setOwnersWarning] = useState<string | null>(null);
  const [ownerId, setOwnerId] = useState('');

  const [smartleadFieldOptions, setSmartleadFieldOptions] = useState<string[]>([]);
  const [smartleadFieldsWarning, setSmartleadFieldsWarning] = useState<string | null>(null);
  const [smartleadFieldsLoaded, setSmartleadFieldsLoaded] = useState(false);
  const [smartleadFieldsLoading, setSmartleadFieldsLoading] = useState(false);

  const [categories, setCategories] = useState<{ id: string | number; name: string }[]>([]);
  const [categoriesWarning, setCategoriesWarning] = useState<string | null>(null);
  const [statusMap, setStatusMap] = useState<Record<string, string>>({});

  const [dealStageOnCreate, setDealStageOnCreate] = useState('');
  const [dealStages, setDealStages] = useState<CrmDealStageDescriptor[]>([]);
  const [dealStagesWarning, setDealStagesWarning] = useState<string | null>(null);
  const [planLimitAcknowledged, setPlanLimitAcknowledged] = useState(false);

  const [deliveryTargetLeads] = useState(100000); // effectively "scan the whole campaign" — the background job stops on its own once the campaign is exhausted
  const [deliveryJobs, setDeliveryJobs] = useState<DeliveryJobView[]>([]);
  const [delivering, setDelivering] = useState(false);
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const pollingRef = useRef(false);

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

  function applySyncScope(scope: SyncScope) {
    setSyncScope(scope);
    if (scope === 'positive_replies_only') {
      setMode('partial');
      setCreateRecordOnInterestedReply(true);
      setCreateRecordForAllLeads(false);
      setSelectedCampaignIds([]); // no campaign scoping needed — Jairo's feedback: PRs-only shouldn't require picking campaigns
    } else if (scope === 'all_contacts') {
      setMode('full');
      setCreateRecordOnInterestedReply(true);
      setCreateRecordForAllLeads(true);
      setSelectedCampaignIds([]); // "everything" option — empty campaignIds already means all campaigns
    } else {
      setMode('full');
      setCreateRecordOnInterestedReply(true);
      setCreateRecordForAllLeads(true);
      // selectedCampaignIds is left as-is — the picker below drives it
    }
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
    const res = await fetch(`/api/crm/${crmType}/fields`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: selectedClientId, credentials, objectType: 'contact' }),
    });
    const data = await res.json();
    setFields(data.fields ?? []);
  }

  async function loadOwners() {
    const res = await fetch(`/api/crm/${crmType}/owners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: selectedClientId, credentials }),
    });
    const data = await res.json();
    setOwners(data.owners ?? []);
    setOwnersWarning(data.warning ?? null);
  }

  async function loadSmartleadFieldOptions() {
    setSmartleadFieldsLoading(true);
    try {
      const campaignId = selectedCampaignIds[0];
      const url = new URL('/api/smartlead/sample-fields', window.location.origin);
      url.searchParams.set('clientId', selectedClientId);
      if (campaignId) url.searchParams.set('campaignId', campaignId);
      const res = await fetch(url);
      const data = await res.json();
      setSmartleadFieldOptions(data.fields ?? []);
      setSmartleadFieldsWarning(data.warning ?? null);
      setSmartleadFieldsLoaded(true);
    } finally {
      setSmartleadFieldsLoading(false);
    }
  }

  function addCustomFieldMapping(key: string) {
    const canonical = `prospect.custom.${key}`;
    if (fieldMap.some((m) => m.canonical === canonical)) return;
    setFieldMap([...fieldMap, { canonical, crmObject: 'contact', crmField: fields[0]?.name ?? '', direction: 'out' }]);
  }

  function removeFieldMapping(canonical: string) {
    setFieldMap(fieldMap.filter((m) => m.canonical !== canonical));
  }

  async function loadCategories() {
    const res = await fetch(`/api/smartlead/categories?clientId=${encodeURIComponent(selectedClientId)}`);
    const data = await res.json();
    setCategories(data.categories ?? []);
    setCategoriesWarning(data.warning ?? null);
    setStatusMap(data.defaultSuggestions ?? {});
  }

  async function loadDealStages() {
    const res = await fetch(`/api/crm/${crmType}/deal-stages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: selectedClientId, credentials }),
    });
    const data = await res.json();
    setDealStages(data.stages ?? []);
    setDealStagesWarning(data.warning ?? null);
  }

  /** Which campaigns delivery should actually run against — explicit picks, or every currently-active campaign when the sync scope skipped campaign selection. */
  function deliveryCampaignIds(): string[] {
    if (selectedCampaignIds.length > 0) return selectedCampaignIds;
    return campaigns.filter((c) => c.status === 'ACTIVE').map((c) => c.id);
  }

  /**
   * The client config as the wizard currently understands it — shared by
   * startDelivery (an interim, not-yet-activated save) and runBuild (the
   * final, activated one). Extracted 26 Aug 2026 after a real bug: Deliver
   * contacts (this step) used to run against whatever was already durably
   * saved for this client, which for any client being configured for the
   * first time is empty — so partial-mode delivery's category filter had
   * no statusMap to check against and treated every lead as "not
   * interested." Saving this first means delivery actually sees the
   * mapping just chosen in the previous step, not stale/empty data.
   */
  function buildConfig(activated: boolean): ClientConfig {
    return {
      clientId: selectedClientId,
      clientName: selectedClient?.clientName ?? selectedClientId,
      activated,
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
        ownerId: ownerId || undefined,
      },
      events: {
        email_sent: syncScope === 'all_contacts' || syncScope === 'specific_campaigns',
        reply: true,
        positive_reply: true,
        bounce: true,
        unsubscribe: true,
        status_change: true,
        meeting_booked: true,
      },
      fieldMap,
      statusMap,
      notifications: selectedClient?.notifications ?? {},
    };
  }

  async function pollDeliveryJobs(jobIds: string[]) {
    pollingRef.current = true;
    while (pollingRef.current) {
      const results = await Promise.all(
        jobIds.map((id) => fetch(`/api/delivery/jobs/${id}`).then((r) => r.json())),
      );
      const views: DeliveryJobView[] = results.map((r) => r.job).filter(Boolean);
      setDeliveryJobs(views);
      const allDone = views.length === jobIds.length && views.every((j) => j.status === 'completed' || j.status === 'failed');
      if (allDone) {
        pollingRef.current = false;
        setDelivering(false);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }

  async function startDelivery() {
    setDeliveryError(null);
    const targetCampaignIds = deliveryCampaignIds();
    if (targetCampaignIds.length === 0) {
      setDeliveryError('No campaigns to deliver from — none are selected and none are currently active.');
      return;
    }
    setDelivering(true);
    setDeliveryJobs([]);
    try {
      // Interim save (not yet activated) so /api/delivery/jobs reads the
      // statusMap/fieldMap/credentials actually chosen in this wizard run
      // instead of whatever was previously saved for this client — see
      // buildConfig's comment for the real bug this fixes.
      const stageRes = await fetch(`/api/clients/${selectedClientId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildConfig(false)),
      });
      if (!stageRes.ok) {
        const stageData = await stageRes.json().catch(() => ({}));
        setDeliveryError(stageData.error ?? 'Could not save the current setup before delivering.');
        setDelivering(false);
        return;
      }

      const started = await Promise.all(
        targetCampaignIds.map((campaignId) =>
          fetch('/api/delivery/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientId: selectedClientId, campaignId, targetLeads: deliveryTargetLeads }),
          }).then((r) => r.json()),
        ),
      );
      const jobIds = started.map((s) => s.job?.id).filter(Boolean) as string[];
      if (jobIds.length === 0) {
        setDeliveryError('Could not start any delivery jobs — see the errors below.');
        setDelivering(false);
        return;
      }
      pollDeliveryJobs(jobIds);
    } catch (err) {
      setDeliveryError(err instanceof Error ? err.message : String(err));
      setDelivering(false);
    }
  }

  useEffect(() => {
    return () => {
      pollingRef.current = false;
    };
  }, []);

  async function runBuild() {
    setBuilding(true);
    setBuildResult(null);
    try {
      const finalConfig = buildConfig(true);

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
  const ownerLabel = createDeal ? 'Deal owner' : 'Contact owner';
  const ownerGuardrailBlocked = owners.length === 0 || !ownerId;

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
          <section className="space-y-6">
            <div>
              <p className="mb-3 text-sm text-slate-600">
                What should get synced from Smartlead into the CRM. This decision drives what step 7
                asks for next, so it happens up front.
              </p>
              <div className="space-y-3">
                {(
                  [
                    {
                      value: 'positive_replies_only' as SyncScope,
                      title: 'Sync only positive replies',
                      desc: 'Only creates a CRM record once someone replies with genuine interest. No campaign picker needed — covers the whole account. Keeps CRM contact volume — and cost — low.',
                    },
                    {
                      value: 'all_contacts' as SyncScope,
                      title: 'Sync all contacts',
                      desc: 'Creates a CRM record for every lead across the whole account. No campaign picker needed — this is the "everything" option.',
                    },
                    {
                      value: 'specific_campaigns' as SyncScope,
                      title: 'Sync specific campaigns',
                      desc: 'Pick exactly which Smartlead campaigns should sync — every lead in those campaigns gets a CRM record.',
                    },
                  ] as const
                ).map((opt) => (
                  <label
                    key={opt.value}
                    className={`block cursor-pointer rounded-xl border p-4 transition ${
                      syncScope === opt.value
                        ? 'border-cymate-orange bg-cymate-orange/5 ring-1 ring-cymate-orange/30'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="syncScope"
                        className="accent-cymate-orange"
                        checked={syncScope === opt.value}
                        onChange={() => applySyncScope(opt.value)}
                      />
                      <span className="font-semibold text-cymate-navy">{opt.title}</span>
                    </span>
                    <p className="mt-1 pl-6 text-sm text-slate-600">{opt.desc}</p>
                  </label>
                ))}
              </div>
            </div>

            {syncScope === 'specific_campaigns' && (
              <div>
                {campaignsWarning && (
                  <p className="mb-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                    {campaignsWarning}
                  </p>
                )}
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
              </div>
            )}

            <div className="border-t border-slate-100 pt-5">
              <p className="mb-3 text-sm font-medium text-slate-700">
                What should get created — a contact, or a contact and a deal?
              </p>
              <div className="grid grid-cols-2 gap-3">
                <label
                  className={`cursor-pointer rounded-xl border p-3 text-sm transition ${
                    !createDeal
                      ? 'border-cymate-orange bg-cymate-orange/5 ring-1 ring-cymate-orange/30'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="recordType"
                    className="mr-2 accent-cymate-orange"
                    checked={!createDeal}
                    onChange={() => setCreateDeal(false)}
                  />
                  <span className="font-semibold text-cymate-navy">Contact only</span>
                </label>
                <label
                  className={`cursor-pointer rounded-xl border p-3 text-sm transition ${
                    createDeal
                      ? 'border-cymate-orange bg-cymate-orange/5 ring-1 ring-cymate-orange/30'
                      : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="recordType"
                    className="mr-2 accent-cymate-orange"
                    checked={createDeal}
                    onChange={() => setCreateDeal(true)}
                  />
                  <span className="font-semibold text-cymate-navy">Contact + Deal</span>
                </label>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Contact + Deal means step 7 will ask for a deal owner and step 10 will ask which
                pipeline stage new deals open in. Contact only just needs a contact owner.
              </p>
            </div>

            <NavButtons
              onBack={() => setStep(2)}
              onNext={() => setStep(4)}
              nextDisabled={syncScope === 'specific_campaigns' && campaigns.length > 0 && selectedCampaignIds.length === 0}
            />
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
              {crmType === 'hubspot' ? 'HubSpot Service Key access token' : 'Access token / API key'}
            </label>
            <input
              type="password"
              className={`mt-2 ${inputClass}`}
              value={credentials.accessToken ?? ''}
              onChange={(e) => setCredentials({ ...credentials, accessToken: e.target.value })}
              placeholder="Paste credential — never committed, encrypted at rest for this skeleton"
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
                loadOwners();
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
              {fieldMap.map((mapping, i) => {
                const isCustom = mapping.canonical.startsWith('prospect.custom.');
                return (
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
                    {isCustom && (
                      <button
                        onClick={() => removeFieldMapping(mapping.canonical)}
                        className="flex-none rounded-md px-2 py-1.5 text-xs text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                        title="Remove this field mapping"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-6 rounded-xl border border-slate-200 p-4">
              <p className="text-sm font-medium text-slate-700">Browse other Smartlead fields</p>
              <p className="mt-1 text-xs text-slate-500">
                Every client&apos;s Smartlead workspace can have its own custom fields (e.g. industry,
                city). This samples one real lead to show what&apos;s actually available for this
                client, rather than a fixed list.
              </p>
              {!smartleadFieldsLoaded ? (
                <button
                  onClick={loadSmartleadFieldOptions}
                  disabled={smartleadFieldsLoading}
                  className="mt-3 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
                >
                  {smartleadFieldsLoading ? 'Sampling a lead…' : 'Browse Smartlead fields'}
                </button>
              ) : (
                <>
                  {smartleadFieldsWarning && (
                    <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
                      {smartleadFieldsWarning}
                    </p>
                  )}
                  {smartleadFieldOptions.length === 0 && !smartleadFieldsWarning ? (
                    <p className="mt-2 text-xs text-slate-500">
                      No custom fields found on the sampled lead for this client.
                    </p>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {smartleadFieldOptions
                        .filter((key) => !fieldMap.some((m) => m.canonical === `prospect.custom.${key}`))
                        .map((key) => (
                          <button
                            key={key}
                            onClick={() => addCustomFieldMapping(key)}
                            className="rounded-full border border-cymate-cyan/40 bg-cymate-cyan/10 px-3 py-1 text-xs font-medium text-cymate-navy transition hover:bg-cymate-cyan/20"
                          >
                            + {key}
                          </button>
                        ))}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="mt-6 rounded-xl border border-cymate-orange/30 bg-cymate-orange/5 p-4">
              <label className="block text-sm font-semibold text-cymate-navy">{ownerLabel} — required</label>
              <p className="mt-1 text-xs text-slate-600">
                Every record created needs an explicit owner. No default, no falling back to
                whoever happens to be signed in — pick a real {crmType} user.
              </p>
              {ownersWarning && (
                <p className="mt-2 rounded-lg bg-amber-50 p-2 text-xs text-amber-800 ring-1 ring-inset ring-amber-200">
                  Couldn&apos;t load {crmType} owners ({ownersWarning}). This step stays blocked until
                  it can — check the credential&apos;s scopes.
                </p>
              )}
              <select
                className={`mt-2 ${inputClass}`}
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
                disabled={owners.length === 0}
              >
                <option value="">{owners.length === 0 ? 'No owners available' : `Select a ${ownerLabel.toLowerCase()}…`}</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                    {o.email ? ` (${o.email})` : ''}
                  </option>
                ))}
              </select>
            </div>

            <NavButtons
              onBack={() => setStep(6)}
              onNext={() => {
                loadCategories();
                setStep(8);
              }}
              nextDisabled={ownerGuardrailBlocked}
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
              those event types for dispatch — and this decides which leads the next step
              (Deliver contacts) treats as worth creating a record for, in partial mode. That
              dependency is exactly why this step comes before Deliver, not after.
            </p>
            <div className="space-y-2">
              {Object.keys(statusMap).map((category) => (
                <div key={category} className="flex items-center gap-3">
                  <span className="w-44 flex-none text-sm text-slate-700">{category}</span>
                  <StatusValueField
                    value={statusMap[category] ?? ''}
                    onChange={(v) => setStatusMap({ ...statusMap, [category]: v })}
                  />
                </div>
              ))}
              {categories
                .filter((c) => !(c.name in statusMap))
                .map((c) => (
                  <div key={c.name} className="flex items-center gap-3">
                    <span className="w-44 flex-none text-sm text-slate-700">{c.name}</span>
                    <StatusValueField
                      value={statusMap[c.name] ?? ''}
                      onChange={(v) => setStatusMap({ ...statusMap, [c.name]: v })}
                    />
                  </div>
                ))}
            </div>
            <NavButtons onBack={() => setStep(7)} onNext={() => setStep(9)} />
          </section>
        )}

        {step === 9 && (
          <section>
            <p className="mb-4 text-sm text-slate-600">
              The other half of S1 — bulk-creates CRM records for leads that already exist in
              Smartlead, independent of any reply or activity. Runs as a real background job, so a
              whole campaign gets scanned even if it takes a while — safe to leave this page once
              it&apos;s started.
            </p>
            {(() => {
              const targets = deliveryCampaignIds();
              return targets.length === 0 ? (
                <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">
                  No campaigns to deliver from yet — none are currently active on this client&apos;s
                  Smartlead account.
                </p>
              ) : (
                <>
                  <p className="text-sm text-slate-600">
                    Will deliver from <b className="text-cymate-navy">{targets.length}</b> campaign
                    {targets.length === 1 ? '' : 's'}
                    {syncScope !== 'specific_campaigns' ? ' (every currently-active campaign)' : ''}.
                  </p>
                  <button
                    onClick={startDelivery}
                    disabled={delivering}
                    className="mt-4 rounded-lg bg-cymate-orange px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-cymate-orange-dark disabled:opacity-50"
                  >
                    {delivering ? 'Delivering…' : `Deliver leads from ${targets.length} campaign${targets.length === 1 ? '' : 's'}`}
                  </button>

                  {deliveryError && (
                    <p className="mt-3 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
                      {deliveryError}
                    </p>
                  )}

                  {deliveryJobs.length > 0 && (
                    <div className="mt-4 space-y-2">
                      {deliveryJobs.map((j) => (
                        <div key={j.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                          <p className="flex items-center justify-between font-medium text-cymate-navy">
                            <span>Campaign {j.campaignId}</span>
                            <span
                              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${
                                j.status === 'completed'
                                  ? 'bg-emerald-50 text-emerald-700'
                                  : j.status === 'failed'
                                    ? 'bg-rose-50 text-rose-700'
                                    : 'bg-cymate-cyan/10 text-cymate-navy'
                              }`}
                            >
                              {j.status}
                            </span>
                          </p>
                          <p className="mt-1 text-slate-600">
                            {j.created} created · {j.alreadyExisted} already existed ·{' '}
                            {j.skippedNotInterested} skipped (not interested) · {j.activitiesLogged}{' '}
                            activities logged · {j.errors.length} errors
                            {j.totalLeadsInCampaign ? ` · ${j.totalLeadsInCampaign} leads in campaign` : ''}
                          </p>
                          {j.errors.length > 0 && (
                            <ul className="mt-1 list-inside list-disc text-xs text-rose-700">
                              {j.errors.slice(0, 5).map((e) => (
                                <li key={e.email}>
                                  {e.email}: {e.reason}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
            <NavButtons onBack={() => setStep(8)} onNext={() => setStep(10)} />
          </section>
        )}

        {step === 10 && (
          <section className="space-y-4 text-sm">
            <p className="rounded-lg bg-slate-50 p-3 text-slate-600">
              Record type was already decided in step 3:{' '}
              <b className="text-cymate-navy">{createDeal ? 'Contact + Deal' : 'Contact only'}</b>.
            </p>
            {createDeal && (
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-500">
                  Deal stage on create
                </label>
                {dealStages.length === 0 && !dealStagesWarning && (
                  <button
                    onClick={loadDealStages}
                    className="mb-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
                  >
                    Load pipeline stages
                  </button>
                )}
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
                  Confirm this client&apos;s CRM plan supports the contact volume that syncing all
                  contacts will create. HubSpot and similar CRMs bill per marketing contact.
                </span>
              </label>
            )}
            <NavButtons
              onBack={() => setStep(9)}
              onNext={() => setStep(11)}
              nextDisabled={mode === 'full' && !planLimitAcknowledged}
            />
          </section>
        )}

        {step === 11 && (
          <section>
            <dl className="grid grid-cols-2 gap-3 rounded-lg border border-slate-100 bg-slate-50/60 p-4 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Client</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{selectedClient?.clientName}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Sync scope</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">
                  {syncScope === 'positive_replies_only'
                    ? 'Positive replies only'
                    : syncScope === 'all_contacts'
                      ? 'All contacts'
                      : `${selectedCampaignIds.length} specific campaign${selectedCampaignIds.length === 1 ? '' : 's'}`}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">Record type</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">{createDeal ? 'Contact + Deal' : 'Contact only'}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">CRM</dt>
                <dd className="mt-0.5 font-medium capitalize text-cymate-navy">{crmType}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{ownerLabel}</dt>
                <dd className="mt-0.5 font-medium text-cymate-navy">
                  {owners.find((o) => o.id === ownerId)?.label ?? '(none)'}
                </dd>
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

            {ownerGuardrailBlocked && (
              <p className="mt-4 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
                No owner was selected in step 7 — go back and pick one before building. Records will
                not be created without an owner.
              </p>
            )}

            <button
              onClick={runBuild}
              disabled={building || ownerGuardrailBlocked}
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
            <NavButtons onBack={() => setStep(10)} onNext={() => {}} nextDisabled />
          </section>
        )}
      </div>
    </main>
  );
}
