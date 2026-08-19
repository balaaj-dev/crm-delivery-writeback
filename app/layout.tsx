import type { Metadata } from 'next';
import { Inter, Space_Grotesk } from 'next/font/google';
import Image from 'next/image';
import Link from 'next/link';
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

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-white/70 transition hover:bg-white/10 hover:text-white"
    >
      {children}
    </Link>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${display.variable}`}>
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
            <nav className="flex items-center gap-1">
              <NavLink href="/setup">Setup</NavLink>
              <NavLink href="/log">Event log</NavLink>
              <div className="ml-3 border-l border-white/10 pl-3">
                <DryRunBadge />
              </div>
            </nav>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
