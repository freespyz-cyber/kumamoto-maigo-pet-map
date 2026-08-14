import { neon } from "@neondatabase/serverless";
import crypto from "node:crypto";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not configured");
}

export const sql = neon(process.env.DATABASE_URL);

export async function ensureSchema() {
  // Serverless functions can start at the same time. PostgreSQL may briefly race while
  // creating SERIAL sequences even with IF NOT EXISTS, so harmless duplicate DDL errors
  // are ignored and the next statement continues.
  const ddl = async (fn) => {
    try { await fn(); }
    catch (err) {
      if (err?.code === "23505" || err?.code === "42P07" || err?.code === "42710") return;
      throw err;
    }
  };
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_posts (
      id BIGSERIAL PRIMARY KEY,
      status TEXT NOT NULL,
      animal TEXT NOT NULL,
      breed TEXT NOT NULL DEFAULT '',
      colors JSONB NOT NULL DEFAULT '[]'::jsonb,
      size TEXT NOT NULL DEFAULT '',
      hair TEXT NOT NULL DEFAULT '',
      collar TEXT NOT NULL DEFAULT '',
      place TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      img TEXT NOT NULL DEFAULT '',
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      edit_token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_sightings (
      id BIGSERIAL PRIMARY KEY,
      target_id BIGINT NOT NULL REFERENCES pet_posts(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      seen_when TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_rate_limits (
      fingerprint TEXT NOT NULL,
      action TEXT NOT NULL,
      last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fingerprint, action)
    )
  `);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_owner_attempts (
      fingerprint TEXT NOT NULL,
      target_id BIGINT NOT NULL REFERENCES pet_posts(id) ON DELETE CASCADE,
      failures INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (fingerprint, target_id)
    )
  `);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_message_threads (
      id BIGSERIAL PRIMARY KEY,
      target_id BIGINT NOT NULL REFERENCES pet_posts(id) ON DELETE CASCADE,
      sender_token_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(target_id, sender_token_hash)
    )
  `);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_messages (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES pet_message_threads(id) ON DELETE CASCADE,
      sender_role TEXT NOT NULL CHECK (sender_role IN ('visitor','owner')),
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ddl(()=>sql`CREATE INDEX IF NOT EXISTS pet_posts_created_at_idx ON pet_posts(created_at DESC)`);
  await ddl(()=>sql`CREATE INDEX IF NOT EXISTS pet_sightings_target_idx ON pet_sightings(target_id, created_at DESC)`);
  await ddl(()=>sql`CREATE INDEX IF NOT EXISTS pet_owner_attempts_lock_idx ON pet_owner_attempts(target_id, locked_until)`);
  await ddl(()=>sql`CREATE INDEX IF NOT EXISTS pet_message_threads_target_idx ON pet_message_threads(target_id, updated_at DESC)`);
  await ddl(()=>sql`CREATE INDEX IF NOT EXISTS pet_messages_thread_idx ON pet_messages(thread_id, created_at ASC)`);
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

export function clientFingerprint(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  const ip = forwarded || String(req.socket?.remoteAddress || "unknown");
  return crypto.createHash("sha256").update("kumamoto-pet-v27|" + ip).digest("hex");
}

export async function checkRateLimit(req, action, seconds = 20) {
  const fp = clientFingerprint(req);
  const rows = await sql`
    SELECT EXTRACT(EPOCH FROM (NOW() - last_at)) AS elapsed
    FROM pet_rate_limits
    WHERE fingerprint=${fp} AND action=${action}
  `;
  if (rows.length && Number(rows[0].elapsed) < seconds) return false;
  await sql`
    INSERT INTO pet_rate_limits (fingerprint, action, last_at)
    VALUES (${fp}, ${action}, NOW())
    ON CONFLICT (fingerprint, action)
    DO UPDATE SET last_at=EXCLUDED.last_at
  `;
  return true;
}

export function cleanText(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

export function roundCoord(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

export function mapPost(row) {
  return {
    id: Number(row.id),
    status: row.status,
    animal: row.animal,
    breed: row.breed || "",
    colors: Array.isArray(row.colors) ? row.colors : [],
    size: row.size || "",
    hair: row.hair || "",
    collar: row.collar || "",
    place: row.place || "",
    note: row.note || "",
    lat: Number(row.lat),
    lng: Number(row.lng),
    img: row.img || "",
    resolved: Boolean(row.resolved),
    createdAt: row.created_at
  };
}

export function getBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch {}
  }
  return {};
}

export async function getOwnerLockStatus(req, targetId) {
  const id = Number(targetId);
  if (!Number.isInteger(id) || id <= 0) return { locked: false, retryAfter: 0 };
  const fp = clientFingerprint(req);
  const rows = await sql`
    SELECT GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::int AS retry_after
    FROM pet_owner_attempts
    WHERE fingerprint=${fp} AND target_id=${id}
    LIMIT 1
  `;
  const retryAfter = Number(rows[0]?.retry_after || 0);
  return { locked: retryAfter > 0, retryAfter };
}

export async function verifyOwnerAccess(req, targetId, token) {
  const id = Number(targetId);
  const code = cleanText(token, 200).toUpperCase();
  if (!Number.isInteger(id) || id <= 0 || !(code.length === 4 || code.length >= 12)) {
    return { ok: false, invalid: true, remaining: 5 };
  }

  const fp = clientFingerprint(req);
  const lockRows = await sql`
    SELECT failures, locked_until,
           GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::int AS retry_after
    FROM pet_owner_attempts
    WHERE fingerprint=${fp} AND target_id=${id}
    LIMIT 1
  `;
  if (lockRows.length && lockRows[0].locked_until && Number(lockRows[0].retry_after) > 0) {
    return { ok: false, locked: true, retryAfter: Number(lockRows[0].retry_after) };
  }

  const owner = await sql`
    SELECT id FROM pet_posts
    WHERE id=${id} AND edit_token_hash=${hashToken(code)}
    LIMIT 1
  `;
  if (owner.length) {
    await sql`DELETE FROM pet_owner_attempts WHERE fingerprint=${fp} AND target_id=${id}`;
    return { ok: true };
  }

  const rows = await sql`
    INSERT INTO pet_owner_attempts (fingerprint,target_id,failures,locked_until,updated_at)
    VALUES (${fp},${id},1,NULL,NOW())
    ON CONFLICT (fingerprint,target_id) DO UPDATE SET
      failures = CASE
        WHEN pet_owner_attempts.locked_until IS NOT NULL AND pet_owner_attempts.locked_until <= NOW() THEN 1
        ELSE pet_owner_attempts.failures + 1
      END,
      locked_until = CASE
        WHEN pet_owner_attempts.locked_until IS NOT NULL AND pet_owner_attempts.locked_until > NOW()
          THEN pet_owner_attempts.locked_until
        WHEN (CASE
          WHEN pet_owner_attempts.locked_until IS NOT NULL AND pet_owner_attempts.locked_until <= NOW() THEN 1
          ELSE pet_owner_attempts.failures + 1
        END) >= 5
          THEN NOW() + INTERVAL '15 minutes'
        ELSE NULL
      END,
      updated_at = NOW()
    RETURNING failures, locked_until,
      GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until - NOW()))))::int AS retry_after
  `;
  const failures = Number(rows[0]?.failures || 1);
  const retryAfter = Number(rows[0]?.retry_after || 0);
  if (retryAfter > 0 || failures >= 5) {
    return { ok: false, locked: true, retryAfter: retryAfter || 900 };
  }
  return { ok: false, remaining: Math.max(0, 5 - failures) };
}

export function ownerAuthError(auth) {
  if (auth?.locked) {
    const mins = Math.max(1, Math.ceil(Number(auth.retryAfter || 900) / 60));
    return { status: 429, retryAfter: Number(auth.retryAfter || 900), error: `管理コードを5回間違えたため、この端末からの確認を約${mins}分間ロックしました。時間を置いてからもう一度お試しください。` };
  }
  if (Number.isFinite(auth?.remaining)) {
    return { status: 403, error: `管理コードが一致しません。あと${auth.remaining}回間違えると15分間ロックされます。` };
  }
  return { status: 403, error: "管理コードが一致しません。" };
}
