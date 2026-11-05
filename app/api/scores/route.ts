import { auth } from '@/lib/auth/server';
import { db } from '@/lib/db';
import { DIFFICULTY } from '@/lib/beatmap';

const RANKS = new Set(['S', 'A', 'B', 'C', 'D', 'F']);
const MODES = new Set(['solo', 'duo']); // mouse runs are practice and never ranked

/** Top 10 players (best run each) for one song on one difficulty. */
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const song = (q.get('song') ?? '').slice(0, 200), difficulty = q.get('difficulty') ?? '';
  if (!song || !(difficulty in DIFFICULTY)) return Response.json({ error: 'Pick a song and difficulty.' }, { status: 400 });
  const sql = await db();
  const rows = await sql`
    select user_id, user_name, score, accuracy, max_combo, rank, mode, created_at from (
      select distinct on (user_id) * from scores
      where song = ${song} and difficulty = ${difficulty}
      order by user_id, score desc, created_at
    ) best order by score desc, created_at limit 10`;
  return Response.json(rows);
}

export async function POST(req: Request) {
  const { data: session } = await auth.getSession();
  const user = session?.user;
  if (!user) return Response.json({ error: 'Sign in to save your score.' }, { status: 401 });

  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const total = Number(b?.total), score = Number(b?.score), accuracy = Number(b?.accuracy), maxCombo = Number(b?.maxCombo);
  // ponytail: scores are computed in the player's browser, so this only rejects impossible values, not a determined cheater.
  const valid = b && typeof b.song === 'string' && b.song.length > 0 && b.song.length <= 200
    && typeof b.difficulty === 'string' && b.difficulty in DIFFICULTY
    && typeof b.mode === 'string' && MODES.has(b.mode) && typeof b.rank === 'string' && RANKS.has(b.rank)
    && Number.isInteger(total) && total > 0 && total < 5000
    && Number.isInteger(score) && score >= 0 && score <= total * 400
    && accuracy >= 0 && accuracy <= 1 && Number.isInteger(maxCombo) && maxCombo >= 0 && maxCombo <= total;
  if (!valid) return Response.json({ error: 'That score could not be saved.' }, { status: 400 });

  const name = (user.name || user.email?.split('@')[0] || 'Player').slice(0, 40);
  const sql = await db();
  await sql`insert into scores (user_id, user_name, song, difficulty, mode, score, accuracy, max_combo, rank)
    values (${user.id}, ${name}, ${b.song as string}, ${b.difficulty as string}, ${b.mode as string}, ${score}, ${accuracy}, ${maxCombo}, ${b.rank as string})`;
  const [{ place }] = await sql`
    select count(*)::int + 1 as place from (
      select user_id, max(score) as best from scores where song = ${b.song as string} and difficulty = ${b.difficulty as string} group by user_id
    ) t where best > ${score}`;
  return Response.json({ place });
}
