import { sql, ensureSchema, hashToken, checkRateLimit, cleanText, roundCoord, mapPost, getBody, verifyOwnerAccess, ownerAuthError } from "./db.js";

const allowedStatus = new Set(["探しています","見かけました","保護しています"]);
const allowedAnimal = new Set(["犬","猫","その他"]);

export default async function handler(req, res) {
  try {
    await ensureSchema();

    if (req.method === "GET") {
      const rows = await sql`
        SELECT id,status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,created_at
        FROM pet_posts
        ORDER BY created_at DESC
        LIMIT 300
      `;
      return res.status(200).json(rows.map(mapPost));
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
          (status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,edit_token_hash)
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
            ${hashToken(token)}
          )
        RETURNING id,status,animal,breed,colors,size,hair,collar,place,note,lat,lng,img,resolved,created_at
      `;
      return res.status(201).json(mapPost(rows[0]));
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
      const rows = await sql`
        UPDATE pet_posts
        SET resolved=${Boolean(b.resolved)}
        WHERE id=${id}
        RETURNING id
      `;
      return res.status(200).json({ok:true});
    }

    res.setHeader("Allow","GET, POST, PATCH");
    return res.status(405).json({error:"Method not allowed"});
  } catch (err) {
    console.error(err);
    return res.status(500).json({error:"サーバーで処理できませんでした。"});
  }
}
