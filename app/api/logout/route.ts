import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/session';

/** POST /api/logout — clears the session cookie. */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, '', { httpOnly: true, maxAge: 0, path: '/' });
  return res;
}
