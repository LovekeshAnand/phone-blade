import { db } from '@/lib/db';

// WebRTC pairing mailbox. Codes are random and only live in a game screen's QR codes, so knowing one is the access check.
// ponytail: no rate limit. Add one (e.g. Vercel Firewall rule on /api/signal) if the endpoint gets abused.
const CODE = /^[A-Za-z0-9_-]{20,64}$/;
const KINDS = new Set(['offer', 'answer']);

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { code?: unknown; kind?: unknown; sdp?: unknown } | null;
  const { code, kind, sdp } = body ?? {};
  if (typeof code !== 'string' || !CODE.test(code) || typeof kind !== 'string' || !KINDS.has(kind) || typeof sdp !== 'string' || sdp.length > 20_000)
    return Response.json({ error: 'Invalid signal' }, { status: 400 });
  const sql = await db();
  await sql`delete from signals where created_at < now() - interval '10 minutes'`;
  const [row] = await sql`insert into signals (code, kind, sdp) values (${code}, ${kind}, ${sdp}) returning id`;
  return Response.json({ id: Number(row.id) });
}

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const codes = (q.get('codes') ?? '').split(',').filter((c) => CODE.test(c)).slice(0, 4);
  const kind = q.get('kind') ?? '';
  const after = Math.max(0, Number(q.get('after')) || 0);
  if (!codes.length || !KINDS.has(kind)) return Response.json({ error: 'Invalid query' }, { status: 400 });
  const sql = await db();
  const rows = await sql`select id, code, sdp from signals where code = any(${codes}) and kind = ${kind} and id > ${after} order by id limit 20`;
  return Response.json(rows.map((r) => ({ id: Number(r.id), code: r.code as string, sdp: r.sdp as string })));
}
