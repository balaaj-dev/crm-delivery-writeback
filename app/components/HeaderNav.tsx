'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LogoutButton } from './LogoutButton';

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

export function HeaderNav({ showLogout, dryRunBadge }: { showLogout: boolean; dryRunBadge: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return null;

  return (
    <nav className="flex items-center gap-1">
      <NavLink href="/setup">Setup</NavLink>
      <NavLink href="/log">Event log</NavLink>
      {showLogout && <LogoutButton />}
      <div className="ml-3 border-l border-white/10 pl-3">{dryRunBadge}</div>
    </nav>
  );
}
