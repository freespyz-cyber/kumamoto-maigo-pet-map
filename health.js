import { sql, ensureSchema } from "./db.js";
export default async function handler(req,res){
  try{
    await ensureSchema();
    const rows=await sql`SELECT NOW() AS now`;
    return res.status(200).json({ok:true,now:rows[0].now});
  }catch(err){
    console.error(err);
    return res.status(500).json({ok:false,error:"database unavailable"});
  }
}
