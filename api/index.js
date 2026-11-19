'use strict';
const {Pool}=require('pg');
const {createHash,timingSafeEqual}=require('crypto');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:5});
const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));};
const fail=(status,message)=>Object.assign(new Error(message),{status});
const admin=req=>{const expected=process.env.ADMIN_API_TOKEN;const actual=req.headers['x-admin-token'];if(!expected||!actual||typeof actual!=='string'||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(actual))))throw fail(403,'Admin access denied')};
const tx=async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const out=await fn(db);await db.query('COMMIT');return out}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}};
module.exports=async(req,res)=>{
try{
 if(!process.env.DATABASE_URL)throw fail(503,'Database not configured');
 const url=new URL(req.url,'https://localhost');const path=url.pathname.replace(/^\/api/,'')||'/';
 if(req.method==='GET'&&path==='/health'){await pool.query('SELECT 1');return json(res,200,{ok:true,database:'connected'})}
 if(req.method==='GET'&&path==='/campaigns'){const r=await pool.query(`SELECT id,title,description,starts_at,ends_at FROM pp_campaigns WHERE status='active' AND funding_verified_at IS NOT NULL AND rules_url IS NOT NULL AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`);return json(res,200,{campaigns:r.rows})}
 if(path.startsWith('/admin/')){
 admin(req);
 if(req.method==='POST'&&path==='/admin/campaigns'){
 const b=await body(req);if(!String(b.title||'').trim()||!String(b.rules_url||'').startsWith('https://'))throw fail(400,'Title and HTTPS rules URL required');
 const r=await pool.query("INSERT INTO pp_campaigns(title,description,rules_url,status) VALUES($1,$2,$3,'draft') RETURNING id,title,status",[String(b.title).slice(0,120),String(b.description||'').slice(0,2000),String(b.rules_url).slice(0,1000)]);
 await pool.query("INSERT INTO pp_admin_audit(action,target_type,target_id) VALUES('create_campaign','campaign',$1)",[r.rows[0].id]);return json(res,201,{campaign:r.rows[0]})
 }
 if(req.method==='POST'&&path==='/admin/prizes'){
 const b=await body(req);if(!uuid(b.campaign_id)||!['cash','phone','gift_card','other'].includes(b.kind)||!String(b.title||'').trim()||!Number.isInteger(b.inventory)||b.inventory<0||!Number.isInteger(b.weight)||b.weight<1||b.weight>100000)throw fail(400,'Invalid prize details');
 if(b.kind==='cash'&&(!/^[A-Z]{3}$/.test(b.currency||'')||!Number.isSafeInteger(b.amount_minor)||b.amount_minor<=0))throw fail(400,'Cash prizes require currency and positive amount_minor');
 const r=await pool.query('INSERT INTO pp_prizes(campaign_id,title,kind,currency,amount_minor,inventory,weight) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,title,inventory',[b.campaign_id,String(b.title).slice(0,120),b.kind,b.kind==='cash'?b.currency:null,b.kind==='cash'?b.amount_minor:null,b.inventory,b.weight]);
 await pool.query("INSERT INTO pp_admin_audit(action,target_type,target_id) VALUES('create_prize','prize',$1)",[r.rows[0].id]);return json(res,201,{prize:r.rows[0]})
 }
 if(req.method==='POST'&&path==='/admin/campaign-status'){
 const b=await body(req);if(!uuid(b.id)||!['draft','paused','closed','active'].includes(b.status))throw fail(400,'Invalid campaign status');
 if(b.status==='active')throw fail(409,'Campaign activation requires independently verified funding; manual API activation is disabled');
 const r=await pool.query('UPDATE pp_campaigns SET status=$2 WHERE id=$1 RETURNING id,status',[b.id,b.status]);if(!r.rowCount)throw fail(404,'Campaign not found');
 await pool.query("INSERT INTO pp_admin_audit(action,target_type,target_id,metadata) VALUES('campaign_status','campaign',$1,$2)",[b.id,JSON.stringify({status:b.status})]);return json(res,200,{campaign:r.rows[0]})
 }
 if(req.method==='GET'&&path==='/admin/overview'){const [users,spins,claims,payouts,campaigns]=await Promise.all(['pp_users','pp_spins','pp_prize_claims','pp_payouts','pp_campaigns'].map(t=>pool.query('SELECT count(*)::int AS count FROM '+t)));return json(res,200,{users:users.rows[0].count,spins:spins.rows[0].count,claims:claims.rows[0].count,payouts:payouts.rows[0].count,campaigns:campaigns.rows[0].count})}
 if(req.method==='GET'&&['/admin/claims','/admin/payouts','/admin/campaigns'].includes(path)){const table={'/admin/claims':'pp_prize_claims','/admin/payouts':'pp_payouts','/admin/campaigns':'pp_campaigns'}[path];const r=await pool.query('SELECT * FROM '+table+' ORDER BY created_at DESC LIMIT 100');return json(res,200,{items:r.rows})}
 if(req.method==='POST'&&path==='/admin/review-claim'){const b=await body(req);if(!uuid(b.id)||!['verified','approved','fulfilled','rejected'].includes(b.status))throw fail(400,'Invalid claim review');const result=await tx(async db=>{const r=await db.query('SELECT * FROM pp_prize_claims WHERE id=$1 FOR UPDATE',[b.id]);if(!r.rowCount)throw fail(404,'Claim not found');if(!['pending','verified','approved'].includes(r.rows[0].status))throw fail(409,'Claim already finalized');await db.query('UPDATE pp_prize_claims SET status=$2,reviewed_at=now(),updated_at=now(),fulfilled_at=CASE WHEN $2=\'fulfilled\' THEN now() ELSE fulfilled_at END WHERE id=$1',[b.id,b.status]);if(b.status==='verified'||b.status==='approved'){await db.query(`UPDATE pp_reward_ledger SET status='verified' WHERE spin_id=$1 AND status='pending'`,[r.rows[0].spin_id])}if(b.status==='rejected')await db.query(`UPDATE pp_reward_ledger SET status='reversed' WHERE spin_id=$1 AND status='pending'`,[r.rows[0].spin_id]);await db.query(`INSERT INTO pp_admin_audit(action,target_type,target_id,metadata) VALUES('review_claim','claim',$1,$2)`,[b.id,JSON.stringify({status:b.status})]);return {id:b.id,status:b.status}});return json(res,200,result)}
 if(req.method==='POST'&&path==='/admin/review-payout'){const b=await body(req);if(!uuid(b.id)||!['approved','paid','rejected'].includes(b.status))throw fail(400,'Invalid payout review');const result=await tx(async db=>{const r=await db.query('SELECT * FROM pp_payouts WHERE id=$1 FOR UPDATE',[b.id]);if(!r.rowCount)throw fail(404,'Payout not found');const prev=r.rows[0].status;if(!((prev==='requested'&&['approved','rejected'].includes(b.status))||(prev==='approved'&&b.status==='paid')))throw fail(409,'Invalid payout status transition');if(b.status==='paid'&&!String(b.provider_reference||'').trim())throw fail(400,'Payment reference required to mark paid');await db.query(`UPDATE pp_payouts SET status=$2,provider_reference=CASE WHEN $2='paid' THEN $3 ELSE provider_reference END,approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END,paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END,updated_at=now() WHERE id=$1`,[b.id,b.status,b.provider_reference||null]);await db.query(`INSERT INTO pp_admin_audit(action,target_type,target_id,metadata) VALUES('review_payout','payout',$1,$2)`,[b.id,JSON.stringify({from:prev,to:b.status})]);return {id:b.id,status:b.status}});return json(res,200,result)}
 }
 return json(res,404,{error:'Not found'});
}catch(e){if(e.code==='23505')return json(res,409,{error:'Duplicate request'});if(e.code==='42P01'||e.code==='42703')return json(res,503,{error:'Database migrations required'});return json(res,e.status||500,{error:e.status?e.message:'Internal server error'})}
};
