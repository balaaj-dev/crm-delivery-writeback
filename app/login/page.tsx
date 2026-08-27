'use client';

import { Suspense, useState, type FormEvent } from 'react';
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

function EyeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path
        d="M1.5 10S4.5 4 10 4s8.5 6 8.5 6-3 6-8.5 6-8.5-6-8.5-6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10" r="2.25" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function EyeOffIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={className} aria-hidden>
      <path
        d="M2.5 2.5l15 15M8.36 8.36a2.25 2.25 0 003.28 3.28M6.1 6.14C3.6 7.62 1.5 10 1.5 10s3 6 8.5 6c1.4 0 2.62-.38 3.66-.94M11.9 4.2C11.28 4.06 10.65 4 10 4c-.34 0-.67.02-1 .06M17.2 13.9c.85-1.2 1.3-2.4 1.3-2.4s-.86-1.72-2.5-3.28"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  /**
   * Reads values from FormData (the live DOM state) rather than React
   * state synced via onChange — fixes a real bug (27 Aug 2026, Balaaj:
   * "the login button needs to be pressed twice"). Password managers
   * (LastPass here) fill inputs without always firing the events React
   * listens for, so controlled-input state can silently stay empty while
   * the field looks filled; the button's disabled={!username||!password}
   * then blocks the first click, and only a second click (after some
   * other interaction happens to sync state) goes through. Uncontrolled
   * inputs + FormData sidesteps that class of bug entirely.
   */
  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const formData = new FormData(e.currentTarget);
      const username = String(formData.get('username') ?? '');
      const password = String(formData.get('password') ?? '');
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
              name="username"
              autoFocus
              required
              autoComplete="username"
              className="mt-2 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition focus:border-cymate-orange focus:outline-none focus:ring-2 focus:ring-cymate-orange/20"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700" htmlFor="password">
              Password
            </label>
            <div className="relative mt-2">
              <input
                id="password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                autoComplete="current-password"
                className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 pr-10 text-sm text-slate-900 shadow-sm transition focus:border-cymate-orange focus:outline-none focus:ring-2 focus:ring-cymate-orange/20"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                title={showPassword ? 'Hide password' : 'Show password'}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-slate-400 transition hover:text-slate-600"
              >
                {showPassword ? <EyeOffIcon className="h-4 w-4" /> : <EyeIcon className="h-4 w-4" />}
              </button>
            </div>
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
          disabled={submitting}
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

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
