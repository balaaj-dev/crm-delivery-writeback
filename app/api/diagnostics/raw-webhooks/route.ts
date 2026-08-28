import { NextResponse } from 'next/server';
import { getRawWebhookLog } from '@/lib/log';

/**
 * Read-only viewer for lib/log.ts's raw Smartlead webhook capture. Kept
 * under /api/diagnostics (not /api/webhooks/smartlead) deliberately —
 * middleware.ts's matcher excludes the whole api/webhooks/smartlead prefix
 * from the auth gate (Smartlead's own dispatcher can't present a session
 * cookie), so a viewer route living there would be reachable by anyone
 * with no login at all. This path stays behind the normal auth gate.
 */
export async function GET() {
  const captures = await getRawWebhookLog();
  return NextResponse.json({ captures });
}
