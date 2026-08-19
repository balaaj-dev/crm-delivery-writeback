import { getEventLog } from '@/lib/log';

export const dynamic = 'force-dynamic';

function OutcomeBadge({ outcome }: { outcome: string }) {
  const styles: Record<string, string> = {
    success: 'bg-green-100 text-green-800',
    skip: 'bg-amber-100 text-amber-800',
    error: 'bg-red-100 text-red-800',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${styles[outcome] ?? 'bg-slate-100'}`}>
      {outcome}
    </span>
  );
}

export default async function LogPage() {
  const entries = await getEventLog(200);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="text-xl font-semibold">Event log</h1>
      <p className="mt-1 text-sm text-slate-600">
        Reverse-chronological. This is how anyone judges whether the writeback pipeline actually
        works — every skip carries a machine-readable reason, nothing is dropped silently.
      </p>

      {entries.length === 0 ? (
        <p className="mt-8 rounded border border-dashed border-slate-300 p-6 text-sm text-slate-500">
          No events yet. Post a fixture to <code>/api/webhooks/smartlead</code>, or fire a test
          event from the setup wizard&apos;s final step.
        </p>
      ) : (
        <div className="mt-6 overflow-x-auto rounded border border-slate-200">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="bg-slate-100 text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2">Timestamp</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Event type</th>
                <th className="px-3 py-2">Outcome</th>
                <th className="px-3 py-2">Reason / detail</th>
                <th className="px-3 py-2">Dry run</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry, i) => (
                <tr key={`${entry.eventId}-${i}`} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-mono text-xs">{entry.timestamp}</td>
                  <td className="px-3 py-2">{entry.clientName ?? entry.clientId}</td>
                  <td className="px-3 py-2">{entry.eventType}</td>
                  <td className="px-3 py-2">
                    <OutcomeBadge outcome={entry.outcome} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">
                    {entry.reason ?? (entry.detail ? JSON.stringify(entry.detail) : '—')}
                  </td>
                  <td className="px-3 py-2">{entry.dryRun ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
