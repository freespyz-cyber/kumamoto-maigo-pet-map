import { sql, ensureSchema } from "./db.js";

async function ensureLifecycleSchema(){
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
  await sql`
    UPDATE pet_posts SET listing_expires_at=created_at+INTERVAL '60 days'
    WHERE status='探しています' AND resolved=FALSE AND listing_expires_at IS NULL
  `;
  await sql`
    UPDATE pet_posts SET withdrawn_at=COALESCE(moderation_updated_at,created_at,NOW())
    WHERE moderation_state='withdrawn' AND withdrawn_at IS NULL
  `;
}

export default async function handler(req,res){
  try{
    res.setHeader("Cache-Control","no-store");
    if(req.method!=="GET"){
      res.setHeader("Allow","GET");
      return res.status(405).json({error:"Method not allowed"});
    }

    const secret=String(process.env.CRON_SECRET||"");
    const auth=String(req.headers.authorization||"");
    if(!secret || auth!==`Bearer ${secret}`){
      return res.status(401).json({ok:false,error:"Unauthorized"});
    }

    await ensureSchema();
    await ensureLifecycleSchema();

    const expired=await sql`
      UPDATE pet_posts
      SET moderation_state='expired',
          moderation_note='掲載期間60日が経過',
          moderation_updated_at=NOW(),
          expired_at=COALESCE(expired_at,NOW())
      WHERE moderation_state='public'
        AND status='探しています'
        AND resolved=FALSE
        AND listing_expires_at IS NOT NULL
        AND COALESCE(place,'') NOT LIKE '%投稿サンプル%'
        AND COALESCE(note,'') NOT LIKE '%投稿サンプル%'
        AND listing_expires_at<=NOW()
      RETURNING id
    `;

    const deleted=await sql`
      DELETE FROM pet_posts
      WHERE moderation_state='withdrawn'
        AND withdrawn_at IS NOT NULL
        AND withdrawn_at<=NOW()-INTERVAL '60 days'
      RETURNING id
    `;

    if(expired.length){
      await sql`INSERT INTO pet_admin_log(action,target_id,note) VALUES('auto_expire',NULL,${`掲載期限60日経過: ${expired.length}件`})`;
    }
    if(deleted.length){
      await sql`INSERT INTO pet_admin_log(action,target_id,note) VALUES('auto_delete_withdrawn',NULL,${`取り下げ60日経過で完全削除: ${deleted.length}件`})`;
    }

    return res.status(200).json({ok:true,expired:expired.length,deleted:deleted.length});
  }catch(err){
    console.error(err);
    return res.status(500).json({ok:false,error:"定期メンテナンスを処理できませんでした。"});
  }
}
