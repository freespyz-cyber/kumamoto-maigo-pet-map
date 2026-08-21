import { sql, ensureSchema, hashToken, checkRateLimit, cleanText, roundCoord, mapPost, getBody, verifyOwnerAccess, ownerAuthError } from "./db.js";

const allowedStatus = new Set(["探しています","見かけました","保護しています"]);
const allowedAnimal = new Set(["犬","猫","その他"]);

async function ensureModerationSchema(){
  const ddl=async(fn)=>{try{await fn()}catch(err){if(["42701","42P07","42710"].includes(err?.code))return;throw err}};
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS moderation_state TEXT NOT NULL DEFAULT 'public'`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS moderation_note TEXT NOT NULL DEFAULT ''`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS moderation_updated_at TIMESTAMPTZ`);
}

async function ensureLifecycleSchema(){
  const ddl=async(fn)=>{try{await fn()}catch(err){if(["42701","42P07","42710"].includes(err?.code))return;throw err}};
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS listing_expires_at TIMESTAMPTZ`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMPTZ`);
  await ddl(()=>sql`ALTER TABLE pet_posts ADD COLUMN IF NOT EXISTS expired_at TIMESTAMPTZ`);

  // 既存の「探しています」投稿にも、投稿日時から60日の掲載期限を設定する。
  await sql`
    UPDATE pet_posts
    SET listing_expires_at = created_at + INTERVAL '60 days'
    WHERE status='探しています' AND resolved=FALSE AND listing_expires_at IS NULL
  `;
  // 管理機能導入済みの取り下げ投稿に削除基準日が無い場合は、取り下げ更新日時を引き継ぐ。
  await sql`
    UPDATE pet_posts
    SET withdrawn_at = COALESCE(moderation_updated_at, created_at, NOW())
    WHERE moderation_state='withdrawn' AND withdrawn_at IS NULL
  `;
}

async function expireDueSearchingPosts(){
  await sql`
    UPDATE pet_posts
    SET moderation_state='expired',
        moderation_note='掲載期間60日が経過',
        moderation_updated_at=NOW(),
        expired_at=COALESCE(expired_at,NOW())
    WHERE moderation_state='public'
      AND status='探しています'
      AND resolved=FALSE
      AND listing_expires_at IS NOT NULL
      AND listing_expires_at <= NOW()
  `;
}

function publicPost(r){
  return {
    ...mapPost(r),
    listingExpiresAt:r.listing_expires_at||null
  };
}

export default async function handler(req, res) {
  try {
    await ensureSchema();
    await ensureModerationSchema();
    await ensureLifecycleSchema();
    await expireDueSearchingPosts();

    if (req.method === "GET") {
      const requestedId = Number(req.query?.id);
      const rows = Number.isInteger(requestedId) && requestedId > 0
        ? await sql`
            SELECT id,status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,created_at,listing_expires_at
            FROM pet_posts
            WHERE id=${requestedId} AND moderation_state='public'
            LIMIT 1
          `
        : await sql`
            SELECT id,status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,created_at,listing_expires_at
            FROM pet_posts
            WHERE moderation_state='public'
            ORDER BY created_at DESC
            LIMIT 300
          `;
      return res.status(200).json(rows.map(publicPost));
    }

    if (req.method === "POST") {
      if (!(await checkRateLimit(req, "post", 20))) {
        return res.status(429).json({error:"連続投稿を防ぐため、20秒ほど空けてください。"});
      }
      const b = getBody(req);
      const status = cleanText(b.status, 20);
      const animal = cleanText(b.animal, 20);
      if (!allowedStatus.has(status) || !allowedAnimal.has(animal)) {
        return res.status(400).json({error:"状況または動物の選択が正しくありません。"});
      }
      const lat = roundCoord(b.lat), lng = roundCoord(b.lng);
      if (lat === null || lng === null || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({error:"地図の場所を確認してください。"});
      }
      const token = cleanText(b.editToken, 200).toUpperCase();
      if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/.test(token)) {
        return res.status(400).json({error:"4文字の管理コードを作成できませんでした。"});
      }

      const colors = Array.isArray(b.colors) ? b.colors.slice(0,8).map(v=>cleanText(v,30)).filter(Boolean) : [];
      const img = String(b.img || "");
      if (img && !/^data:image\/(?:jpeg|jpg|png|webp);base64,/i.test(img)) {
        return res.status(400).json({error:"写真の形式を確認してください。"});
      }
      if (img.length > 1_500_000) {
        return res.status(413).json({error:"写真の容量が大きすぎます。別の写真を選んでください。"});
      }

      const rows = await sql`
        INSERT INTO pet_posts
          (status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,edit_token_hash,moderation_state,listing_expires_at)
        VALUES
          (
            ${status},
            ${animal},
            ${cleanText(b.breed,80)},
            ${JSON.stringify(colors)}::jsonb,
            ${cleanText(b.size,30)},
            ${cleanText(b.hair,30)},
            ${cleanText(b.collar,30)},
            ${cleanText(b.place,120)},
            ${cleanText(b.note,600)},
            ${lat},
            ${lng},
            ${img},
            FALSE,
            ${hashToken(token)},
            'public',
            ${status === "探しています" ? new Date(Date.now()+60*24*60*60*1000).toISOString() : null}
          )
        RETURNING id,status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,created_at,listing_expires_at
      `;
      return res.status(201).json(publicPost(rows[0]));
    }

    if (req.method === "PATCH") {
      const b = getBody(req);
      const id = Number(b.id);
      const token = cleanText(b.editToken, 200).toUpperCase();
      if (!Number.isInteger(id) || id <= 0 || !token) {
        return res.status(400).json({error:"投稿を確認できませんでした。"});
      }
      const auth = await verifyOwnerAccess(req, id, token);
      if (!auth.ok) {
        const e = ownerAuthError(auth);
        return res.status(e.status).json({error:e.error,retryAfter:e.retryAfter||0});
      }

      if (b.action === "renew") {
        const rows = await sql`
          UPDATE pet_posts
          SET moderation_state='public',
              moderation_note='',
              moderation_updated_at=NOW(),
              listing_expires_at=NOW()+INTERVAL '60 days',
              expired_at=NULL
          WHERE id=${id}
            AND status='探しています'
            AND resolved=FALSE
            AND moderation_state IN ('public','expired')
          RETURNING id,listing_expires_at
        `;
        if(!rows.length) return res.status(409).json({error:"この投稿は「まだ探しています」の延長対象ではありません。"});
        return res.status(200).json({ok:true,renewed:true,listingExpiresAt:rows[0].listing_expires_at});
      }

      if (b.action === "withdraw") {
        const rows = await sql`
          UPDATE pet_posts
          SET moderation_state='withdrawn',
              moderation_note='投稿者による取り下げ',
              moderation_updated_at=NOW(),
              withdrawn_at=NOW()
          WHERE id=${id} AND moderation_state IN ('public','expired')
          RETURNING id
        `;
        if(!rows.length) return res.status(404).json({error:"投稿が見つからないか、すでに取り下げられています。"});
        return res.status(200).json({ok:true,withdrawn:true});
      }

      const rows = await sql`
        UPDATE pet_posts
        SET resolved=${Boolean(b.resolved)},
            listing_expires_at=CASE WHEN ${Boolean(b.resolved)} THEN NULL ELSE listing_expires_at END,
            expired_at=CASE WHEN ${Boolean(b.resolved)} THEN NULL ELSE expired_at END
        WHERE id=${id} AND moderation_state='public'
        RETURNING id
      `;
      if(!rows.length) return res.status(404).json({error:"投稿が見つかりませんでした。"});
      return res.status(200).json({ok:true});
    }

    res.setHeader("Allow","GET, POST, PATCH");
    return res.status(405).json({error:"Method not allowed"});
  } catch (err) {
    console.error(err);
    return res.status(500).json({error:"サーバーで処理できませんでした。"});
  }
}
