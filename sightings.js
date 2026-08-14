import { sql, ensureSchema, checkRateLimit, cleanText, roundCoord, getBody, verifyOwnerAccess, ownerAuthError } from "./db.js";

export default async function handler(req, res) {
  try {
    await ensureSchema();

    if (req.method === "POST") {
      if (!(await checkRateLimit(req, "sighting", 10))) {
        return res.status(429).json({error:"連続送信を防ぐため、10秒ほど空けてください。"});
      }
      const b = getBody(req);
      const targetId = Number(b.targetId);
      const lat = roundCoord(b.lat), lng = roundCoord(b.lng);
      const when = cleanText(b.when,80);
      if (!Number.isInteger(targetId) || targetId <= 0 || lat === null || lng === null || !when) {
        return res.status(400).json({error:"目撃情報の入力内容を確認してください。"});
      }
      const target = await sql`SELECT id FROM pet_posts WHERE id=${targetId} LIMIT 1`;
      if (!target.length) return res.status(404).json({error:"対象の投稿が見つかりません。"});
      await sql`
        INSERT INTO pet_sightings (target_id,lat,lng,seen_when,note)
        VALUES (${targetId},${lat},${lng},${when},${cleanText(b.note,500)})
      `;
      return res.status(201).json({ok:true});
    }

    if (req.method === "GET") {
      const targetId = Number(req.query?.targetId);
      const token = cleanText(req.headers["x-owner-code"],200);
      if (!Number.isInteger(targetId) || targetId <= 0 || !token) {
        return res.status(400).json({error:"確認情報が不足しています。"});
      }
      const auth = await verifyOwnerAccess(req, targetId, token);
      if (!auth.ok) {
        const e = ownerAuthError(auth);
        return res.status(e.status).json({error:e.error});
      }
      const rows = await sql`
        SELECT id,target_id,lat,lng,seen_when,note,created_at
        FROM pet_sightings
        WHERE target_id=${targetId}
        ORDER BY created_at DESC
        LIMIT 100
      `;
      return res.status(200).json(rows.map(r=>({
        id:Number(r.id),targetId:Number(r.target_id),lat:Number(r.lat),lng:Number(r.lng),
        when:r.seen_when,note:r.note||"",createdAt:r.created_at
      })));
    }

    res.setHeader("Allow","GET, POST");
    return res.status(405).json({error:"Method not allowed"});
  } catch (err) {
    console.error(err);
    return res.status(500).json({error:"サーバーで処理できませんでした。"});
  }
}
