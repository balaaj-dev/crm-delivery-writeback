import { NextResponse } from 'next/server';
import { listClientConfigs } from '@/lib/config';
import { logger } from '@/lib/log';

export async function GET() {
  try {
    const clients = await listClientConfigs();
    return NextResponse.json({ clients });
  } catch (err) {
    logger.error('GET /api/clients failed', { error: err instanceof Error ? err.message : err });
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
