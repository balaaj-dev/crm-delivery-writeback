import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-semibold">CRM Delivery & Writeback</h1>
      <p className="mt-2 text-slate-600">
        Reference implementation of Cymate&apos;s S1 RevOps service. Configure a client, then
        watch Smartlead events flow into the CRM (or the mock adapter, if DRY_RUN is on).
      </p>
      <div className="mt-8 flex gap-4">
        <Link
          href="/setup"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
        >
          Configure a client →
        </Link>
        <Link
          href="/log"
          className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100"
        >
          View event log →
        </Link>
      </div>
    </main>
  );
}
