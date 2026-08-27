import { NextResponse, type NextRequest } from 'next/server';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/session';

/**
 * Login/auth layer, added per Jairo's 26 Aug 2026 feedback ("needs a
 * login/auth layer once it's off Balaaj's laptop"). Gates the wizard, the
 * event log, and every API route except:
 * - the incoming Smartlead webhook (its own per-client secret check — see
 *   app/api/webhooks/smartlead/route.ts; Smartlead's own dispatcher can't
 *   present a session cookie), and
 * - the QStash-triggered delivery-job processor (its own cryptographic
 *   signature check — see lib/qstash.ts and
 *   app/api/delivery/jobs/[id]/process/route.ts; QStash can't present one
 *   either), and
 * - /login, /api/login, /api/logout — have to stay reachable to log in at
 *   all, otherwise every request bounces to /login and back forever.
 * These stay outside this gate by design, not by oversight.
 *
 * Primary mechanism is a signed session cookie (see lib/session.ts) set by
 * a real Cymate-branded /login page — HTTP Basic Auth's native browser
 * dialog can't be restyled, per Balaaj's 27 Aug 2026 request. Basic Auth is
 * still accepted as a fallback (handy for curl/script testing) but is
 * never what prompts a browser popup: an unauthenticated page navigation
 * always redirects to /login instead of returning a WWW-Authenticate 401.
 *
 * If SETUP_AUTH_USER/SETUP_AUTH_PASS aren't set, this is a no-op — local
 * dev stays open, same graceful-degradation pattern as the rest of this
 * app. This is intentionally simple (a shared password, not per-user
 * login) — good enough to gate a small internal tool, not a substitute for
 * real SSO if this grows past a handful of CSMs.
 */
const PUBLIC_PATHS = new Set(['/login', '/api/login', '/api/logout']);

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const user = process.env.SETUP_AUTH_USER;
  const pass = process.env.SETUP_AUTH_PASS;
  if (!user || !pass) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const [presentedUser, presentedPass] = atob(header.slice(6)).split(':');
      if (presentedUser === user && presentedPass === pass) {
        return NextResponse.next();
      }
    } catch {
      // malformed header — fall through
    }
  }

  if (await verifySessionToken(req.cookies.get(SESSION_COOKIE_NAME)?.value)) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const loginUrl = new URL('/login', req.url);
  loginUrl.searchParams.set('next', pathname + req.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!api/webhooks/smartlead|api/delivery/jobs/.*/process|_next/static|_next/image|favicon.ico).*)',
  ],
};
