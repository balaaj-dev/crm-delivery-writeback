/**
 * Signed, stateless session tokens for the custom login page — replaces
 * HTTP Basic Auth's native browser dialog (which can't be restyled; it's a
 * browser chrome feature, not a page) with a real Cymate-branded /login
 * page, per Balaaj's 27 Aug 2026 request.
 *
 * Deliberately stateless (no session store, no DB, no dependency on
 * lib/kv.ts being connected) — a token is `${expiry}.${hmac}` where hmac =
 * HMAC-SHA256(SETUP_AUTH_PASS, `${SETUP_AUTH_USER}:${expiry}`). Verifying
 * just recomputes the HMAC and checks it matches plus hasn't expired — no
 * lookup needed, works identically in local dev and on Vercel. This is
 * still the same "one shared password, not real per-user SSO" gate as
 * before (see middleware.ts's own header comment) — just with a page you
 * can style instead of the browser's native prompt.
 *
 * Uses the Web Crypto API (global `crypto.subtle`), not node:crypto —
 * middleware.ts imports this file and Next.js middleware runs on the Edge
 * runtime, which doesn't have node:crypto. crypto.subtle is available in
 * both Edge and Node, so this works unmodified in both places.
 */
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Returns null if SETUP_AUTH_USER/PASS aren't configured — same graceful "no gate" fallback as middleware.ts always had. */
export async function createSessionToken(): Promise<string | null> {
  const user = process.env.SETUP_AUTH_USER;
  const pass = process.env.SETUP_AUTH_PASS;
  if (!user || !pass) return null;

  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const key = await hmacKey(pass);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${user}:${expiry}`));
  return `${expiry}.${toHex(sig)}`;
}

export async function verifySessionToken(token: string | undefined): Promise<boolean> {
  const user = process.env.SETUP_AUTH_USER;
  const pass = process.env.SETUP_AUTH_PASS;
  if (!user || !pass || !token) return false;

  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return false;
  const expiry = Number(token.slice(0, dotIndex));
  if (!Number.isFinite(expiry) || Date.now() > expiry) return false;

  const providedSig = fromHex(token.slice(dotIndex + 1));
  if (!providedSig) return false;

  const key = await hmacKey(pass);
  return crypto.subtle.verify('HMAC', key, providedSig, encoder.encode(`${user}:${expiry}`));
}

export function checkCredentials(username: string, password: string): boolean {
  const user = process.env.SETUP_AUTH_USER;
  const pass = process.env.SETUP_AUTH_PASS;
  if (!user || !pass) return false;
  return username === user && password === pass;
}

export const SESSION_COOKIE_NAME = 'cymate_session';
export const SESSION_MAX_AGE_SECONDS = SESSION_MAX_AGE_MS / 1000;
