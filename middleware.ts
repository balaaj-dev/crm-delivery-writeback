import { NextResponse, type NextRequest } from 'next/server';

/**
 * Login/auth layer, added per Jairo's 26 Aug 2026 feedback ("needs a
 * login/auth layer once it's off Balaaj's laptop"). MVP mechanism —
 * HTTP Basic Auth against SETUP_AUTH_USER/SETUP_AUTH_PASS, gating the
 * wizard, the event log, and every API route except the incoming
 * Smartlead webhook (which has its own per-client secret check — see
 * app/api/webhooks/smartlead/route.ts; Smartlead's own dispatcher can't
 * present a Basic Auth header, so that one route stays outside this gate
 * by design, not by oversight).
 *
 * If SETUP_AUTH_USER/SETUP_AUTH_PASS aren't set, this is a no-op — local
 * dev stays open, same graceful-degradation pattern as the rest of this
 * app. Set both before this is reachable from anywhere but one laptop.
 * This is intentionally simple (a shared password, not per-user login) —
 * good enough to gate a small internal tool, not a substitute for real
 * SSO if this grows past a handful of CSMs.
 */
export function middleware(req: NextRequest): NextResponse {
  const user = process.env.SETUP_AUTH_USER;
  const pass = process.env.SETUP_AUTH_PASS;
  if (!user || !pass) return NextResponse.next();

  const header = req.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    try {
      const [presentedUser, presentedPass] = atob(header.slice(6)).split(':');
      if (presentedUser === user && presentedPass === pass) {
        return NextResponse.next();
      }
    } catch {
      // malformed header — fall through to 401
    }
  }

  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Cymate RevOps"' },
  });
}

export const config = {
  matcher: ['/((?!api/webhooks/smartlead|_next/static|_next/image|favicon.ico).*)'],
};
