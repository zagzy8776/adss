'use strict';
const {Pool}=require('pg');
const {randomBytes,createHash,scryptSync,timingSafeEqual,randomInt}=require('crypto');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:5});
const COOKIE='pp_session';
const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data));};
const fail=(status,message)=>Object.assign(new Error(message),{status});
const hash=v=>createHash('sha256').update(v).digest('hex');
const passHash=p=>{const salt=randomBytes(16).toString('hex');return salt+':'+scryptSync(p,salt,64).toString('hex');};
const passCheck=(p,h)=>{const [salt,digest]=String(h).split(':');if(!salt||!digest||digest.length!==128)return false;return timingSafeEqual(scryptSync(p,salt,64),Buffer.from(digest,'hex'));};
const cookies=req=>Object.fromEntries((req.headers.cookie||'').split(';').map(s=>s.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));
const sessionCookie=(token,age)=>`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const body=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16000)throw fail(413,'Request too large');}try{return JSON.parse(raw||'{}')}catch{throw fail(400,'Invalid JSON')}};
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const user=async(req,db=pool)=>{const token=cookies(req)[COOKIE];if(!token)return null;const r=await db.query(`SELECT u.id,u.email,u.display_name FROM pp_user_sessions s JOIN pp_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.expires_at>now() AND u.disabled_at IS NULL`,[hash(token)]);return r.rows[0]||null};
const requireUser=async(req,db)=>{const u=await user(req,db);if(!u)throw fail(401,'Sign in required');return u};
const admin=req=>{const expected=process.env.ADMIN_API_TOKEN;const actual=req.headers['x-admin-token'];if(!expected||!actual||typeof actual!=='string'||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(actual))))throw fail(403,'Admin access denied')};
const tx=async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const out=await fn(db);await db.query('COMMIT');return out}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}};
const issue=async(res,db,userId)=>{const token=randomBytes(32).toString('base64url');await db.query(`INSERT INTO pp_user_sessions(user_id,token_hash,expires_at) VALUES($1,$2,now()+interval '30 days')`,[userId,hash(token)]);res.setHeader('Set-Cookie',sessionCookie(token,2592000))};
const money=async(db,userId)=>{const r=await db.query(`SELECT currency,COALESCE(sum(CASE WHEN status='verified' THEN amount_minor ELSE 0 END),0)::text AS verified_minor,COALESCE(sum(CASE WHEN status='pending' THEN amount_minor ELSE 0 END),0)::text AS pending_minor FROM pp_reward_ledger WHERE user_id=$1 GROUP BY currency`,[userId]);const p=await db.query(`SELECT currency,COALESCE(sum(amount_minor),0)::text AS reserved_minor FROM pp_payouts WHERE user_id=$1 AND status IN ('requested','approved','paid') GROUP BY currency`,[userId]);return r.rows.map(x=>({...x,reserved_minor:p.rows.find(y=>y.currency===x.currency)?.reserved_minor||'0',available_minor:String(Math.max(0,Number(x.verified_minor)-Number(p.rows.find(y=>y.currency===x.currency)?.reserved_minor||0)))}))};
module.exports=async(req,res)=>{
try{
 if(!process.env.DATABASE_URL)throw fail(503,'Database not configured');
 const url=new URL(req.url,'https://localhost');const path=url.pathname.replace(/^\/api/,'')||'/';
 if(req.method==='GET'&&path==='/health'){await pool.query('SELECT 1');return json(res,200,{ok:true,database:'connected'})}
 if(req.method==='POST'&&path==='/auth/register'){
 const b=await body(req);const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||password.length<12||password.length>128)throw fail(400,'Valid email and password of at least 12 characters required');
 const data=await tx(async db=>{const r=await db.query('INSERT INTO pp_users(email,display_name) VALUES($1,$2) ON CONFLICT(email) DO NOTHING RETURNING id,email',[email,String(b.display_name||'').slice(0,80)||null]);if(!r.rowCount)throw fail(409,'Account already exists');await db.query('INSERT INTO pp_auth_credentials(user_id,password_hash) VALUES($1,$2)',[r.rows[0].id,passHash(password)]);await issue(res,db,r.rows[0].id);return r.rows[0]});return json(res,201,{user:data});
 }
 if(req.method==='POST'&&path==='/auth/login'){
 const b=await body(req);const email=String(b.email||'').trim().toLowerCase(),password=String(b.password||'');
 const r=await pool.query('SELECT u.id,u.email,c.password_hash FROM pp_users u JOIN pp_auth_credentials c ON c.user_id=u.id WHERE u.email=$1 AND u.disabled_at IS NULL',[email]);if(!r.rowCount||!passCheck(password,r.rows[0].password_hash))throw fail(401,'Invalid credentials');
 await issue(res,pool,r.rows[0].id);return json(res,200,{user:{id:r.rows[0].id,email:r.rows[0].email}});
 }
 if(req.method==='POST'&&path==='/auth/logout'){const token=cookies(req)[COOKIE];if(token)await pool.query('UPDATE pp_user_sessions SET revoked_at=now() WHERE token_hash=$1',[hash(token)]);res.setHeader('Set-Cookie',sessionCookie('',0));return json(res,200,{ok:true})}
 if(req.method==='GET'&&path==='/me'){const u=await requireUser(req);return json(res,200,{user:u,wallet:await money(pool,u.id)})}
 if(req.method==='GET'&&path==='/campaigns'){const r=await pool.query(`SELECT id,title,description,starts_at,ends_at FROM pp_campaigns WHERE status='active' AND funding_verified_at IS NOT NULL AND rules_url IS NOT NULL AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`);return json(res,200,{campaigns:r.rows})}
 if(req.method==='POST'&&path==='/spin'){
 const b=await body(req);if(!uuid(b.campaign_id)||!uuid(b.request_id))throw fail(400,'Valid campaign_id and request_id required');
 const result=await tx(async db=>{
 const u=await requireUser(req,db);
 const c=await db.query(`SELECT id FROM pp_campaigns WHERE id=$1 AND status='active' AND funding_verified_at IS NOT NULL AND rules_url IS NOT NULL AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())`,[b.campaign_id]);if(!c.rowCount)throw fail(409,'No active funded campaign');
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[u.id,b.campaign_id]);
 const old=await db.query('SELECT id,prize_id,status,reward_snapshot_minor,reward_currency FROM pp_spins WHERE user_id=$1 AND request_id=$2',[u.id,b.request_id]);if(old.rowCount)return {...old.rows[0],replayed:true};
 const day=(await db.query("SELECT (now() AT TIME ZONE 'UTC')::date AS d")).rows[0].d;
 const usage=await db.query(`INSERT INTO pp_daily_spin_usage(user_id,campaign_id,spin_date,used) VALUES($1,$2,$3,1) ON CONFLICT(user_id,campaign_id,spin_date) DO UPDATE SET used=pp_daily_spin_usage.used+1,updated_at=now() WHERE pp_daily_spin_usage.used<2 RETURNING used`,[u.id,b.campaign_id,day]);
 if(!usage.rowCount)throw fail(429,'Daily spin limit reached');
 const prizes=await db.query('SELECT id,kind,currency,amount_minor,weight,inventory FROM pp_prizes WHERE campaign_id=$1 AND inventory>0 ORDER BY id FOR UPDATE',[b.campaign_id]);
 const total=prizes.rows.reduce((a,p)=>a+p.weight,0);let chosen=null;
 if(total>0){let n=randomInt(total);for(const p of prizes.rows){n-=p.weight;if(n<0){chosen=p;break}}}
 if(chosen)await db.query('UPDATE pp_prizes SET inventory=inventory-1 WHERE id=$1 AND inventory>0',[chosen.id]);
 const spin=await db.query(`INSERT INTO pp_spins(campaign_id,user_id,prize_id,status,spin_date,request_id,reward_snapshot_minor,reward_currency,resolved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING id,prize_id,status,reward_snapshot_minor,reward_currency`,[b.campaign_id,u.id,chosen?.id||null,chosen?'awarded':'no_prize',day,b.request_id,chosen?.kind==='cash'?chosen.amount_minor:null,chosen?.kind==='cash'?chosen.currency:null]);
 if(chosen){await db.query(`INSERT INTO pp_prize_claims(user_id,spin_id,prize_id) VALUES($1,$2,$3)`,[u.id,spin.rows[0].id,chosen.id]);if(chosen.kind==='cash')await db.query(`INSERT INTO pp_reward_ledger(user_id,spin_id,source_type,currency,amount_minor,status) VALUES($1,$2,'prize_award',$3,$4,'pending')`,[u.id,spin.rows[0].id,chosen.currency,chosen.amount_minor])}
 await db.query(`INSERT INTO pp_streaks(user_id,campaign_id,last_played_date,consecutive_days,loyalty_points) VALUES($1,$2,$3,1,10) ON CONFLICT(user_id,campaign_id) DO UPDATE SET consecutive_days=CASE WHEN pp_streaks.last_played_date=$3 THEN pp_streaks.consecutive_days WHEN pp_streaks.last_played_date=$3::date-1 THEN pp_streaks.consecutive_days+1 ELSE 1 END,last_played_date=$3,loyalty_points=pp_streaks.loyalty_points+CASE WHEN pp_streaks.last_played_date=$3 THEN 0 ELSE 10 END,updated_at=now()`,[u.id,b.campaign_id,day]);
 return {...spin.rows[0],used:usage.rows[0].used,replayed:false}
 });return json(res,200,result)
 }
 if(req.method==='GET'&&path==='/wallet'){const u=await requireUser(req);const r=await pool.query('SELECT id,source_type,currency,amount_minor,status,created_at FROM pp_reward_ledger WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id]);return json(res,200,{balances:await money(pool,u.id),transactions:r.rows})}
 if(req.method==='GET'&&path==='/claims'){const u=await requireUser(req);const r=await pool.query('SELECT c.id,c.status,c.created_at,p.title,p.kind FROM pp_prize_claims c JOIN pp_prizes p ON p.id=c.prize_id WHERE c.user_id=$1 ORDER BY c.created_at DESC LIMIT 100',[u.id]);return json(res,200,{claims:r.rows})}
 if(req.method==='POST'&&path==='/payouts'){
 const b=await body(req);if(!uuid(b.request_id)||!Number.isSafeInteger(b.amount_minor)||b.amount_minor<=0||!(/^[A-Z]{3}$/.test(b.currency||'')))throw fail(400,'Valid request_id, currency and positive amount_minor required');
 const result=await tx(async db=>{const u=await requireUser(req,db);await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[u.id]);const old=await db.query('SELECT id,status FROM pp_payouts WHERE user_id=$1 AND idempotency_key=$2',[u.id,b.request_id]);if(old.rowCount)return old.rows[0];const balances=await money(db,u.id);const available=balances.find(x=>x.currency===b.currency);if(!available||Number(available.available_minor)<b.amount_minor)throw fail(409,'Insufficient verified available balance');const r=await db.query(`INSERT INTO pp_payouts(user_id,currency,amount_minor,idempotency_key) VALUES($1,$2,$3,$4) RETURNING id,status`,[u.id,b.currency,b.amount_minor,b.request_id]);return r.rows[0]});return json(res,201,{payout:result,notice:'Requested only. No money transferred.'})
 }
 if(req.method==='GET'&&path==='/payouts'){const u=await requireUser(req);const r=await pool.query('SELECT id,currency,amount_minor,status,created_at,paid_at FROM pp_payouts WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[u.id]);return json(res,200,{payouts:r.rows})}
 if(path.startsWith('/admin/')){
 admin(req);
 if(req.method==='GET'&&path==='/admin/overview'){const [users,spins,claims,payouts,campaigns]=await Promise.all(['pp_users','pp_spins','pp_prize_claims','pp_payouts','pp_campaigns'].map(t=>pool.query('SELECT count(*)::int AS count FROM '+t)));return json(res,200,{users:users.rows[0].count,spins:spins.rows[0].count,claims:claims.rows[0].count,payouts:payouts.rows[0].count,campaigns:campaigns.rows[0].count})}
 if(req.method==='GET'&&['/admin/claims','/admin/payouts','/admin/campaigns'].includes(path)){const table={'/admin/claims':'pp_prize_claims','/admin/payouts':'pp_payouts','/admin/campaigns':'pp_campaigns'}[path];const r=await pool.query('SELECT * FROM '+table+' ORDER BY created_at DESC LIMIT 100');return json(res,200,{items:r.rows})}
 if(req.method==='POST'&&path==='/admin/review-claim'){const b=await body(req);if(!uuid(b.id)||!['verified','approved','fulfilled','rejected'].includes(b.status))throw fail(400,'Invalid claim review');const result=await tx(async db=>{const r=await db.query('SELECT * FROM pp_prize_claims WHERE id=$1 FOR UPDATE',[b.id]);if(!r.rowCount)throw fail(404,'Claim not found');if(!['pending','verified','approved'].includes(r.rows[0].status))throw fail(409,'Claim already finalized');await db.query('UPDATE pp_prize_claims SET status=$2,reviewed_at=now(),updated_at=now(),fulfilled_at=CASE WHEN $2=\'fulfilled\' THEN now() ELSE fulfilled_at END WHERE id=$1',[b.id,b.status]);if(b.status==='verified'||b.status==='approved'){await db.query(`UPDATE pp_reward_ledger SET status='verified' WHERE spin_id=$1 AND status='pending'`,[r.rows[0].spin_id])}if(b.status==='rejected')await db.query(`UPDATE pp_reward_ledger SET status='reversed' WHERE spin_id=$1 AND status='pending'`,[r.rows[0].spin_id]);await db.query(`INSERT INTO pp_admin_audit(action,target_type,target_id,metadata) VALUES('review_claim','claim',$1,$2)`,[b.id,JSON.stringify({status:b.status})]);return {id:b.id,status:b.status}});return json(res,200,result)}
 if(req.method==='POST'&&path==='/admin/review-payout'){const b=await body(req);if(!uuid(b.id)||!['approved','paid','rejected'].includes(b.status))throw fail(400,'Invalid payout review');const result=await tx(async db=>{const r=await db.query('SELECT * FROM pp_payouts WHERE id=$1 FOR UPDATE',[b.id]);if(!r.rowCount)throw fail(404,'Payout not found');const prev=r.rows[0].status;if(!((prev==='requested'&&['approved','rejected'].includes(b.status))||(prev==='approved'&&b.status==='paid')))throw fail(409,'Invalid payout status transition');if(b.status==='paid'&&!String(b.provider_reference||'').trim())throw fail(400,'Payment reference required to mark paid');await db.query(`UPDATE pp_payouts SET status=$2,provider_reference=CASE WHEN $2='paid' THEN $3 ELSE provider_reference END,approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END,paid_at=CASE WHEN $2='paid' THEN now() ELSE paid_at END,updated_at=now() WHERE id=$1`,[b.id,b.status,b.provider_reference||null]);await db.query(`INSERT INTO pp_admin_audit(action,target_type,target_id,metadata) VALUES('review_payout','payout',$1,$2)`,[b.id,JSON.stringify({from:prev,to:b.status})]);return {id:b.id,status:b.status}});return json(res,200,result)}
 }
 return json(res,404,{error:'Not found'});
}catch(e){if(e.code==='23505')return json(res,409,{error:'Duplicate request'});if(e.code==='42P01'||e.code==='42703')return json(res,503,{error:'Database migrations required'});return json(res,e.status||500,{error:e.status?e.message:'Internal server error'})}
};
