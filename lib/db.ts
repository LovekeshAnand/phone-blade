import { neon } from '@neondatabase/serverless';

const sql = neon(process.env.DATABASE_URL!);
let ready: Promise<void> | null = null;

/**
 * The Neon client, with tables created on first use.
 * Note: inline idempotent schema instead of a migration tool. Move to migrations once the schema starts changing.
 */
export async function db() {
  ready ??= (async () => {
    // WebRTC handshake messages. Short lived, deleted after 10 minutes.
    await sql`create table if not exists signals (
      id bigserial primary key, code text not null, kind text not null, sdp text not null,
      created_at timestamptz not null default now())`;
    await sql`create index if not exists signals_lookup on signals (code, kind, id)`;
    await sql`create table if not exists scores (
      id bigserial primary key, user_id text not null, user_name text not null,
      song text not null, difficulty text not null, mode text not null,
      score integer not null, accuracy real not null, max_combo integer not null, rank text not null,
      created_at timestamptz not null default now())`;
    await sql`create index if not exists scores_board on scores (song, difficulty, score desc)`;
  })().catch((e) => { ready = null; throw e; });
  await ready;
  return sql;
}
