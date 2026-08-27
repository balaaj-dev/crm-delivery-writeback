import type { Metadata } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import Image from 'next/image';
import Link from 'next/link';
import { HeaderNav } from './components/HeaderNav';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const display = Space_Grotesk({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display' });

export const metadata: Metadata = {
  title: 'Cymate — CRM Delivery & Writeback',
  description: 'Internal reference implementation. Not the production system.',
};

function DryRunBadge() {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        dryRun ? 'bg-cymate-cyan/15 text-cymate-cyan' : 'bg-cymate-orange/20 text-cymate-orange'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dryRun ? 'bg-cymate-cyan' : 'bg-cymate-orange'}`} />
      {dryRun ? 'DRY_RUN — no live writes' : 'LIVE — writing to real CRM'}
    </span>
  );
}

/** Runs before paint so a stored/system dark preference doesn't flash light-then-dark on load. See ThemeToggle for the write side. */
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('cymate-theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-screen font-sans text-slate-900">
        <header className="bg-cymate-navy">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-2.5">
              <Image src="/cymate-logo-mark.png" alt="" width={28} height={28} className="rounded-md" />
              <span className="font-display text-base font-bold tracking-tight text-white">
                CYMATE
              </span>
              <span className="hidden text-sm text-white/50 sm:inline">RevOps · S1 Writeback</span>
            </Link>
            <HeaderNav
              showLogout={Boolean(process.env.SETUP_AUTH_USER && process.env.SETUP_AUTH_PASS)}
              dryRunBadge={<DryRunBadge />}
            />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
