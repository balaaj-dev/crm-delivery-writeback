import Link from 'next/link';
import Image from 'next/image';

const FEATURES = [
  {
    title: 'Smartlead → CRM, live',
    body: 'Sends, replies, bounces, and status changes flow straight into HubSpot as contacts and activity — no spreadsheet in between.',
  },
  {
    title: 'Partial or full writeback',
    body: 'Only create records on an interested reply, or sync every lead — the client’s CRM plan decides which.',
  },
  {
    title: 'Nothing drops silently',
    body: 'Every event lands in the log with a clear outcome — success, a machine-readable skip reason, or an error.',
  },
];

export default function HomePage() {
  return (
    <main className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-[420px] w-[420px] opacity-[0.05]"
      >
        <Image src="/cymate-logo-mark.png" alt="" fill className="object-contain" />
      </div>

      <div className="relative mx-auto max-w-3xl px-6 py-20">
        <p className="text-xs font-semibold uppercase tracking-widest text-cymate-orange">
          Cymate · RevOps service catalogue
        </p>
        <h1 className="mt-3 font-display text-4xl font-bold leading-tight tracking-tight text-cymate-navy sm:text-5xl">
          CRM Delivery <span className="text-cymate-orange">&amp; Writeback</span>
        </h1>
        <p className="mt-4 max-w-xl text-base text-slate-600">
          Configure a client, then watch Smartlead campaign activity write itself into their CRM —
          real calls in production, safely simulated and logged here in DRY_RUN.
        </p>

        <div className="mt-8 flex gap-3">
          <Link
            href="/setup"
            className="rounded-lg bg-cymate-orange px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-cymate-orange-dark"
          >
            Configure a client →
          </Link>
          <Link
            href="/log"
            className="rounded-lg border border-slate-200 bg-white px-5 py-2.5 text-sm font-semibold text-cymate-navy shadow-sm transition hover:border-slate-300"
          >
            View event log
          </Link>
        </div>

        <ul className="mt-14 space-y-6 border-t border-slate-200 pt-10">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-4">
              <span className="mt-1 h-2 w-2 flex-none rounded-full bg-cymate-cyan" />
              <div>
                <p className="font-semibold text-cymate-navy">{f.title}</p>
                <p className="mt-1 text-sm text-slate-600">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </main>
  );
}
