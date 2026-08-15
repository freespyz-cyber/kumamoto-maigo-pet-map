import crypto from "node:crypto";
import { sql, ensureSchema, cleanText, getBody } from "./db.js";

async function ensureAdminSchema(){
  const ddl=async(fn)=>{try{await fn()}catch(err){if(["42701","42P07","42710"].includes(err?.code))return;throw err}};
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS moderation_state TEXT NOT NULL DEFAULT 'public'`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS moderation_note TEXT NOT NULL DEFAULT ''`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS moderation_updated_at TIMESTAMPTZ`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS listing_expires_at TIMESTAMPTZ`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ`);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_admin_log (
      id BIGSERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      target_id BIGINT,
      note TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await ddl(()=>sql`
    CREATE TABLE IF NOT EXISTS pet_admin_attempts (
      fingerprint TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      locked_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await sql`
    UPDATE pet_posts SET listing_expires_at=created_at+INTERVAL '60 days'
    WHERE status='探しています' AND resolved=FALSE AND listing_expires_at IS NULL
  `;
  await sql`
    UPDATE pet_posts SET withdrawn_at=COALESCE(moderation_updated_at,created_at,NOW())
    WHERE moderation_state='withdrawn' AND withdrawn_at IS NULL
  `;
}

async function expireDueSearchingPosts(){
  await sql`
    UPDATE pet_posts
    SET moderation_state='expired',moderation_note='掲載期間60日が経過',moderation_updated_at=NOW(),expired_at=COALESCE(expired_at,NOW())
    WHERE moderation_state='public' AND status='探しています' AND resolved=FALSE
      AND listing_expires_at IS NOT NULL AND listing_expires_at<=NOW()
  `;
}

function safeEqual(a,b){
  const ah=crypto.createHash("sha256").update(String(a||"")).digest();
  const bh=crypto.createHash("sha256").update(String(b||"")).digest();
  return crypto.timingSafeEqual(ah,bh);
}

function adminFingerprint(req){
  const forwarded=String(req?.headers?.["x-forwarded-for"]||"").split(",")[0].trim();
  const ip=forwarded || String(req?.socket?.remoteAddress||"unknown");
  const ua=String(req?.headers?.["user-agent"]||"").slice(0,180);
  return crypto.createHash("sha256").update(`kumamoto-admin-v1|${ip}|${ua}`).digest("hex");
}

async function adminLockStatus(req){
  const fp=adminFingerprint(req);
  const rows=await sql`
    SELECT failures,
      CASE WHEN locked_until IS NOT NULL AND locked_until > NOW()
        THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until-NOW()))))::int
        ELSE 0 END AS retry_after
    FROM pet_admin_attempts WHERE fingerprint=${fp} LIMIT 1
  `;
  const retryAfter=Number(rows[0]?.retry_after||0);
  return {fp,locked:retryAfter>0,retryAfter,failures:Number(rows[0]?.failures||0)};
}

async function registerAdminFailure(fp){
  const rows=await sql`
    INSERT INTO pet_admin_attempts(fingerprint,failures,locked_until,updated_at)
    VALUES(${fp},1,NULL,NOW())
    ON CONFLICT(fingerprint) DO UPDATE SET
      failures=CASE
        WHEN pet_admin_attempts.locked_until IS NOT NULL AND pet_admin_attempts.locked_until <= NOW() THEN 1
        ELSE pet_admin_attempts.failures+1
      END,
      locked_until=CASE
        WHEN pet_admin_attempts.locked_until IS NOT NULL AND pet_admin_attempts.locked_until > NOW() THEN pet_admin_attempts.locked_until
        WHEN (CASE
          WHEN pet_admin_attempts.locked_until IS NOT NULL AND pet_admin_attempts.locked_until <= NOW() THEN 1
          ELSE pet_admin_attempts.failures+1
        END) >= 5 THEN NOW()+INTERVAL '15 minutes'
        ELSE NULL
      END,
      updated_at=NOW()
    RETURNING failures,
      GREATEST(0, CEIL(EXTRACT(EPOCH FROM (locked_until-NOW()))))::int AS retry_after
  `;
  const failures=Number(rows[0]?.failures||1);
  const retryAfter=Number(rows[0]?.retry_after||0);
  return {failures,retryAfter,locked:retryAfter>0 || failures>=5};
}

async function clearAdminFailures(fp){
  await sql`DELETE FROM pet_admin_attempts WHERE fingerprint=${fp}`;
}

async function requireAdmin(req,res,body){
  const configured=String(process.env.ADMIN_PASSWORD||"");
  if(!configured){res.status(503).json({error:"管理者パスワードがまだ設定されていません。"});return false}

  const lock=await adminLockStatus(req);
  if(lock.locked){
    res.status(429).json({error:"管理者パスワードの確認を一時ロックしています。時間をおいて再度お試しください。",retryAfter:lock.retryAfter||900});
    return false;
  }

  const supplied=String(body.password||"");
  if(!safeEqual(configured,supplied)){
    const fail=await registerAdminFailure(lock.fp);
    if(fail.locked){
      res.status(429).json({error:"管理者パスワードを5回間違えたため、15分間ロックしました。",retryAfter:fail.retryAfter||900});
      return false;
    }
    const remaining=Math.max(0,5-fail.failures);
    res.status(401).json({error:`管理者パスワードが違います。あと${remaining}回間違えると15分間ロックされます。`,remaining});
    return false;
  }

  await clearAdminFailures(lock.fp);
  return true;
}

export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");
    await ensureSchema();
    await ensureAdminSchema();
    await expireDueSearchingPosts();
    if(req.method!=="POST"){
      res.setHeader("Allow","POST");
      return res.status(405).json({error:"Method not allowed"});
    }
    const b=getBody(req);
    if(!(await requireAdmin(req,res,b)))return;
    const action=cleanText(b.action,30);

    if(action==="list"){
      const posts=await sql`
        SELECT id,status,animal,breed,place,note,resolved,moderation_state,moderation_note,created_at,
               listing_expires_at,withdrawn_at,expired_at
        FROM pet_posts
        ORDER BY created_at DESC
        LIMIT 300
      `;
      const counts=await sql`
        SELECT moderation_state, COUNT(*)::int AS count
        FROM pet_posts
        GROUP BY moderation_state
      `;
      const stats={public:0,hidden:0,withdrawn:0,expired:0};
      for(const r of counts){if(Object.prototype.hasOwnProperty.call(stats,r.moderation_state))stats[r.moderation_state]=Number(r.count)||0}
      return res.status(200).json({ok:true,stats,posts:posts.map(p=>({
        id:Number(p.id),status:p.status,animal:p.animal,breed:p.breed||"",place:p.place||"",note:p.note||"",resolved:!!p.resolved,
        moderationState:p.moderation_state||"public",moderationNote:p.moderation_note||"",createdAt:p.created_at,
        listingExpiresAt:p.listing_expires_at||null,withdrawnAt:p.withdrawn_at||null,expiredAt:p.expired_at||null
      }))});
    }

    const id=Number(b.id);
    if(!Number.isInteger(id)||id<=0)return res.status(400).json({error:"投稿IDを確認できませんでした。"});

    if(action==="hide"){
      const rows=await sql`
        UPDATE pet_posts SET moderation_state='hidden',moderation_note='管理者により非公開',moderation_updated_at=NOW()
        WHERE id=${id} AND moderation_state='public' RETURNING id
      `;
      if(!rows.length)return res.status(404).json({error:"公開中の投稿が見つかりませんでした。"});
      await sql`INSERT INTO pet_admin_log(action,target_id,note) VALUES('hide',${id},'管理者により非公開')`;
      return res.status(200).json({ok:true});
    }

    if(action==="restore"){
      const rows=await sql`
        UPDATE pet_posts SET
          moderation_state='public',
          moderation_note='',
          moderation_updated_at=NOW(),
          withdrawn_at=NULL,
          expired_at=NULL,
          listing_expires_at=CASE
            WHEN status='探しています' AND resolved=FALSE
              AND (listing_expires_at IS NULL OR listing_expires_at<=NOW())
            THEN NOW()+INTERVAL '60 days'
            ELSE listing_expires_at
          END
        WHERE id=${id} AND moderation_state IN ('hidden','withdrawn','expired') RETURNING id,listing_expires_at
      `;
      if(!rows.length)return res.status(404).json({error:"復元できる投稿が見つかりませんでした。"});
      await sql`INSERT INTO pet_admin_log(action,target_id,note) VALUES('restore',${id},'管理者により復元')`;
      return res.status(200).json({ok:true,listingExpiresAt:rows[0].listing_expires_at||null});
    }

    if(action==="delete"){
      const state=await sql`SELECT moderation_state FROM pet_posts WHERE id=${id} LIMIT 1`;
      if(!state.length)return res.status(404).json({error:"投稿が見つかりませんでした。"});
      if(state[0].moderation_state==="public")return res.status(409).json({error:"誤削除防止のため、公開中の投稿は先に非公開にしてください。"});
      await sql`INSERT INTO pet_admin_log(action,target_id,note) VALUES('delete',${id},'管理者による完全削除')`;
      await sql`DELETE FROM pet_posts WHERE id=${id}`;
      return res.status(200).json({ok:true});
    }

    return res.status(400).json({error:"管理者操作を確認できませんでした。"});
  }catch(err){
    console.error(err);
    return res.status(500).json({error:"管理者機能を処理できませんでした。"});
  }
}
