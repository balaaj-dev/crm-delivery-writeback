'use client';

import { useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function XCircleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.35 7.35l5.3 5.3M12.65 7.35l-5.3 5.3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`animate-spin ${className ?? ''}`} aria-hidden>
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="2" strokeOpacity="0.25" />
      <path d="M17.5 10a7.5 7.5 0 00-7.5-7.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? 'Something went wrong — try again.');
        return;
      }
      const next = searchParams.get('next');
      router.push(next && next.startsWith('/') ? next : '/setup');
      router.refresh();
    } catch {
      setError('Could not reach the server — check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-56px)] max-w-md flex-col justify-center px-6 py-12">
      <div className="mb-8 text-center">
        <p className="text-sm font-semibold uppercase tracking-widest text-cymate-orange">
          Cymate · RevOps
        </p>
        <h1 className="mt-0.5 font-display text-xl font-bold text-cymate-navy">Sign in</h1>
        <p className="mt-0.5 text-sm text-slate-500">CRM Delivery &amp; Writeback</p>
      </div>

      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-200 bg-white p-6 shadow-card sm:p-8"
      >
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="username">
              Username
            </label>
            <input
              id="username"
              autoFocus
              autoComplete="username"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-cymate-orange focus:outline-none focus:ring-2 focus:ring-cymate-orange/20"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="password">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-cymate-orange focus:outline-none focus:ring-2 focus:ring-cymate-orange/20"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>

        {error && (
          <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-inset ring-rose-200">
            <XCircleIcon className="mt-0.5 h-4 w-4 flex-none text-rose-500" />
            <span>{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !username || !password}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg bg-cymate-orange px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-cymate-orange-dark disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting && <Spinner className="h-4 w-4" />}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      <p className="mt-6 text-center text-xs text-slate-400">
        Internal tool — contact your Cymate admin if you need access.
      </p>
    </main>
  );
}
