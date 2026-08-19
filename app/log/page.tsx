import { getEventLog } from '@/lib/log';

export const dynamic = 'force-dynamic';

function OutcomeBadge({ outcome }: { outcome: string }) {
  const styles: Record<string, string> = {
    success: 'bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200',
    skip: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200',
    error: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-200',
  };
  return (
    <span
      className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[outcome] ?? 'bg-slate-100 text-slate-600'}`}
    >
      {outcome}
    </span>
  );
}

export default async function LogPage() {
  const entries = await getEventLog(200);

  return (
    <main className="mx-auto max-w-6xl px-6 py-12">
      <p className="text-xs font-semibold uppercase tracking-widest text-cymate-orange">
        Pipeline visibility
      </p>
      <h1 className="mt-2 font-display text-2xl font-bold text-cymate-navy">Event log</h1>
      <p className="mt-1 max-w-2xl text-sm text-slate-600">
        Reverse-chronological. This is how anyone judges whether the writeback pipeline actually
        works — every skip carries a machine-readable reason, nothing is dropped silently.
      </p>

      {entries.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-slate-300 bg-white/60 p-10 text-center text-sm text-slate-500">
          No events yet. Post a fixture to <code className="rounded bg-slate-100 px-1.5 py-0.5">/api/webhooks/smartlead</code>,
          or fire a test event from the setup wizard&apos;s final step.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-3 font-medium">Timestamp</th>
                  <th className="px-4 py-3 font-medium">Client</th>
                  <th className="px-4 py-3 font-medium">Event type</th>
                  <th className="px-4 py-3 font-medium">Outcome</th>
                  <th className="px-4 py-3 font-medium">Reason / detail</th>
                  <th className="px-4 py-3 font-medium">Dry run</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, i) => (
                  <tr key={`${entry.eventId}-${i}`} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-slate-500">
                      {entry.timestamp}
                    </td>
                    <td className="px-4 py-3 font-medium text-cymate-navy">
                      {entry.clientName ?? entry.clientId}
                    </td>
                    <td className="px-4 py-3 text-slate-700">{entry.eventType}</td>
                    <td className="px-4 py-3">
                      <OutcomeBadge outcome={entry.outcome} />
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 font-mono text-xs text-slate-500">
                      {entry.reason ?? (entry.detail ? JSON.stringify(entry.detail) : '—')}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                          entry.dryRun ? 'bg-cymate-cyan/10 text-cymate-navy' : 'bg-cymate-orange/10 text-cymate-orange'
                        }`}
                      >
                        {entry.dryRun ? 'yes' : 'no'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </main>
  );
}
