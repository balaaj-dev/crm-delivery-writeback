import { NextResponse } from 'next/server';
import { checkCredentials, createSessionToken, SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { logger } from '@/lib/log';

/** POST /api/login — validates username/password against SETUP_AUTH_USER/PASS, sets a signed session cookie on success. See lib/session.ts for the token scheme. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
  const { username, password } = body;

  if (!username || !password || !checkCredentials(username, password)) {
    logger.warn('login: rejected invalid credentials', { username });
    return NextResponse.json({ error: 'Invalid username or password' }, { status: 401 });
  }

  const token = await createSessionToken();
  if (!token) {
    // SETUP_AUTH_USER/PASS aren't set — shouldn't normally reach here since
    // /login redirects away when the gate is off, but fail closed anyway.
    return NextResponse.json({ error: 'Login is not configured' }, { status: 500 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: '/',
  });
  return res;
}
