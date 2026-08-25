import { NextResponse } from 'next/server';
import { getJob } from '@/lib/jobs';

/** GET /api/delivery/jobs/:id — poll this for live progress. */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const job = await getJob(params.id);
  if (!job) {
    return NextResponse.json({ error: `No job found for id ${params.id}` }, { status: 404 });
  }
  return NextResponse.json({ job });
}
