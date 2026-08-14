import { sql, ensureSchema, checkRateLimit, cleanText, hashToken, getBody, verifyOwnerAccess, ownerAuthError, getOwnerLockStatus } from "./db.js";

function mapMessage(r) {
  return {
    id: Number(r.id),
    threadId: Number(r.thread_id),
    senderRole: r.sender_role,
    body: r.body || "",
    createdAt: r.created_at
  };
}

export default async function handler(req, res) {
  try {
    await ensureSchema();

    if (req.method === "GET") {
      const view = cleanText(req.query?.view, 30);
      const targetId = Number(req.query?.targetId);

      if (view === "owner-lock-status") {
        if (!Number.isInteger(targetId) || targetId <= 0) {
          return res.status(400).json({error:"投稿を確認できませんでした。"});
        }
        const status = await getOwnerLockStatus(req, targetId);
        return res.status(200).json(status);
      }

      if (view === "visitor") {
        const clientToken = cleanText(req.query?.clientToken, 200);
        if (!Number.isInteger(targetId) || targetId <= 0 || clientToken.length < 32) {
          return res.status(400).json({error:"確認情報が不足しています。"});
        }
        const threads = await sql`
          SELECT id FROM pet_message_threads
          WHERE target_id=${targetId} AND sender_token_hash=${hashToken(clientToken)}
          LIMIT 1
        `;
        if (!threads.length) return res.status(200).json({threadId:null,messages:[]});
        const threadId = Number(threads[0].id);
        const rows = await sql`
          SELECT id,thread_id,sender_role,body,created_at
          FROM pet_messages
          WHERE thread_id=${threadId}
          ORDER BY created_at ASC, id ASC
          LIMIT 300
        `;
        return res.status(200).json({threadId,messages:rows.map(mapMessage)});
      }

      const editToken = cleanText(req.headers["x-owner-code"], 200);
      const auth = await verifyOwnerAccess(req, targetId, editToken);
      if (!auth.ok) {
        const e = ownerAuthError(auth);
        return res.status(e.status).json({error:e.error,retryAfter:e.retryAfter||0});
      }

      if (view === "owner-inbox") {
        const rows = await sql`
          SELECT
            t.id,
            t.updated_at,
            COALESCE((SELECT body FROM pet_messages m WHERE m.thread_id=t.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1),'') AS latest_body,
            (SELECT COUNT(*)::int FROM pet_messages m WHERE m.thread_id=t.id) AS message_count
          FROM pet_message_threads t
          WHERE t.target_id=${targetId}
          ORDER BY t.updated_at DESC, t.id DESC
          LIMIT 100
        `;
        return res.status(200).json({threads:rows.map(r=>({
          threadId:Number(r.id),updatedAt:r.updated_at,latestBody:r.latest_body||"",messageCount:Number(r.message_count)||0
        }))});
      }

      if (view === "owner-thread") {
        const threadId = Number(req.query?.threadId);
        if (!Number.isInteger(threadId) || threadId <= 0) return res.status(400).json({error:"やり取りを確認できませんでした。"});
        const belongs = await sql`SELECT id FROM pet_message_threads WHERE id=${threadId} AND target_id=${targetId} LIMIT 1`;
        if (!belongs.length) return res.status(404).json({error:"やり取りが見つかりません。"});
        const rows = await sql`
          SELECT id,thread_id,sender_role,body,created_at
          FROM pet_messages
          WHERE thread_id=${threadId}
          ORDER BY created_at ASC, id ASC
          LIMIT 300
        `;
        return res.status(200).json({threadId,messages:rows.map(mapMessage)});
      }

      return res.status(400).json({error:"表示方法を確認してください。"});
    }

    if (req.method === "POST") {
      if (!(await checkRateLimit(req, "message", 3))) {
        return res.status(429).json({error:"連続送信を防ぐため、3秒ほど空けてください。"});
      }
      const b = getBody(req);
      const role = cleanText(b.role, 20);
      const targetId = Number(b.targetId);
      const body = cleanText(b.body, 800);
      if (!Number.isInteger(targetId) || targetId <= 0 || !body) {
        return res.status(400).json({error:"メッセージ内容を確認してください。"});
      }
      const targets = await sql`SELECT id,resolved FROM pet_posts WHERE id=${targetId} LIMIT 1`;
      if (!targets.length) return res.status(404).json({error:"対象の投稿が見つかりません。"});
      if (targets[0].resolved) return res.status(409).json({error:"この投稿は解決済みです。"});

      if (role === "visitor") {
        const clientToken = cleanText(b.clientToken, 200);
        if (clientToken.length < 32) return res.status(400).json({error:"この端末の確認情報を作成できませんでした。"});
        const threadRows = await sql`
          INSERT INTO pet_message_threads (target_id,sender_token_hash,updated_at)
          VALUES (${targetId},${hashToken(clientToken)},NOW())
          ON CONFLICT (target_id,sender_token_hash)
          DO UPDATE SET updated_at=NOW()
          RETURNING id
        `;
        const threadId = Number(threadRows[0].id);
        await sql`INSERT INTO pet_messages (thread_id,sender_role,body) VALUES (${threadId},'visitor',${body})`;
        await sql`UPDATE pet_message_threads SET updated_at=NOW() WHERE id=${threadId}`;
        return res.status(201).json({ok:true,threadId});
      }

      if (role === "owner") {
        const threadId = Number(b.threadId);
        const editToken = cleanText(b.editToken, 200);
        const auth = await verifyOwnerAccess(req, targetId, editToken);
        if (!auth.ok) {
          const e = ownerAuthError(auth);
          return res.status(e.status).json({error:e.error,retryAfter:e.retryAfter||0});
        }
        if (!Number.isInteger(threadId) || threadId <= 0) return res.status(400).json({error:"やり取りを確認できませんでした。"});
        const belongs = await sql`SELECT id FROM pet_message_threads WHERE id=${threadId} AND target_id=${targetId} LIMIT 1`;
        if (!belongs.length) return res.status(404).json({error:"やり取りが見つかりません。"});
        await sql`INSERT INTO pet_messages (thread_id,sender_role,body) VALUES (${threadId},'owner',${body})`;
        await sql`UPDATE pet_message_threads SET updated_at=NOW() WHERE id=${threadId}`;
        return res.status(201).json({ok:true,threadId});
      }

      return res.status(400).json({error:"送信方法を確認してください。"});
    }

    res.setHeader("Allow","GET, POST");
    return res.status(405).json({error:"Method not allowed"});
  } catch (err) {
    console.error(err);
    return res.status(500).json({error:"サーバーで処理できませんでした。"});
  }
}
