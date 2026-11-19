'use strict';
const {Pool}=require('pg');
const {randomBytes,createHash,timingSafeEqual,randomInt}=require('crypto');
const pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:true},max:5});
const COOKIE='pp_visitor';
const hash=v=>createHash('sha256').update(String(v)).digest('hex');
const json=(res,status,data)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(data))};
const fail=(status,message)=>Object.assign(new Error(message),{status});
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const body=async req=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>16000)throw fail(413,'Request too large')}try{return JSON.parse(raw||'{}')}catch{throw fail(400,'Invalid JSON')}};
const admin=req=>{const expected=process.env.ADMIN_API_TOKEN,actual=req.headers['x-admin-token'];if(!expected||typeof actual!=='string'||!timingSafeEqual(Buffer.from(hash(expected)),Buffer.from(hash(actual))))throw fail(403,'Admin access denied')};
const tx=async fn=>{const db=await pool.connect();try{await db.query('BEGIN');const value=await fn(db);await db.query('COMMIT');return value}catch(e){await db.query('ROLLBACK');throw e}finally{db.release()}};
const cookie=req=>(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);
const getVisitor=async(req,db)=>{const token=cookie(req);if(!token||!/^[a-f0-9]{64}$/.test(token))return null;const r=await db.query('SELECT id FROM pp_anonymous_visitors WHERE token_hash=$1 AND revoked_at IS NULL',[hash(token)]);return r.rows[0]||null};
const ensureVisitor=async(req,res)=>{const existing=await getVisitor(req,pool);if(existing)return existing;const token=randomBytes(32).toString('hex');const r=await pool.query('INSERT INTO pp_anonymous_visitors(token_hash) VALUES($1) RETURNING id',[hash(token)]);res.setHeader('Set-Cookie',COOKIE+'='+token+'; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000');return r.rows[0]};
const networkKey=req=>hash((process.env.ABUSE_HASH_SECRET||process.env.ADMIN_API_TOKEN||'')+'|'+String(req.headers['x-forwarded-for']||'').split(',')[0].trim());
const rate=async(db,req,kind,limit)=>{const key=networkKey(req);await db.query('SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))',[key,kind]);const count=await db.query("SELECT count(*)::int AS n FROM pp_anonymous_rate_events WHERE network_hash=$1 AND event_type=$2 AND created_at>now()-interval '1 hour'",[key,kind]);if(count.rows[0].n>=limit)throw fail(429,'Too many requests from this network. Try again later.');await db.query('INSERT INTO pp_anonymous_rate_events(network_hash,event_type) VALUES($1,$2)',[key,kind])};
const active="status='active' AND funding_verified_at IS NOT NULL AND rules_url IS NOT NULL AND (starts_at IS NULL OR starts_at<=now()) AND (ends_at IS NULL OR ends_at>now())";
module.exports=async(req,res)=>{try{
 if(!process.env.DATABASE_URL)throw fail(503,'Database not configured');
 const url=new URL(req.url,'https://localhost'),path=url.pathname.replace(/^\/api/,'')||'/';
 if(req.method==='GET'&&path==='/health'){await pool.query('SELECT 1');return json(res,200,{ok:true,database:'connected'})}
 if(req.method==='GET'&&path==='/visitor'){const v=await ensureVisitor(req,res);return json(res,200,{anonymous:true,visitor_id:v.id,registration_required:false})}
 if(req.method==='GET'&&path==='/campaigns'){const r=await pool.query('SELECT id,title,description,rules_url FROM pp_campaigns WHERE '+active);return json(res,200,{campaigns:r.rows})}
 if(req.method==='GET'&&path==='/activity'){const v=await ensureVisitor(req,res);const r=await pool.query("SELECT s.id,s.status,s.created_at,p.title AS prize_title,p.kind FROM pp_spins s LEFT JOIN pp_prizes p ON p.id=s.prize_id WHERE s.anonymous_visitor_id=$1 ORDER BY s.created_at DESC LIMIT 50",[v.id]);const d=await pool.query("SELECT used FROM pp_anonymous_global_daily_spins WHERE visitor_id=$1 AND spin_date=(now() AT TIME ZONE 'UTC')::date",[v.id]);const w=await pool.query("SELECT currency,COALESCE(sum(amount_minor) FILTER (WHERE status='pending'),0)::text AS pending_minor,COALESCE(sum(amount_minor) FILTER (WHERE status='verified'),0)::text AS verified_minor FROM pp_reward_ledger WHERE anonymous_visitor_id=$1 GROUP BY currency",[v.id]);return json(res,200,{spins:r.rows,usage:d.rows,wallet:w.rows})}
 if(req.method==='POST'&&path==='/spin'){
 const b=await body(req);if(!uuid(b.campaign_id)||!uuid(b.request_id))throw fail(400,'Valid campaign and request ID required');
 const v=await ensureVisitor(req,res);
 const result=await tx(async db=>{
  await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[v.id]);
  const old=await db.query('SELECT s.id,s.status,s.prize_id,p.title AS prize_title FROM pp_spins s LEFT JOIN pp_prizes p ON p.id=s.prize_id WHERE s.anonymous_visitor_id=$1 AND s.request_id=$2',[v.id,b.request_id]);if(old.rowCount)return {...old.rows[0],replayed:true};
  await rate(db,req,'spin',30);
  const campaign=await db.query('SELECT id FROM pp_campaigns WHERE id=$1 AND '+active,[b.campaign_id]);if(!campaign.rowCount)throw fail(409,'No active funded campaign');
  const usage=await db.query("INSERT INTO pp_anonymous_global_daily_spins(visitor_id,spin_date,used) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1) ON CONFLICT(visitor_id,spin_date) DO UPDATE SET used=pp_anonymous_global_daily_spins.used+1,updated_at=now() WHERE pp_anonymous_global_daily_spins.used<2 RETURNING used",[v.id]);if(!usage.rowCount)throw fail(429,'Two daily spins already used');
  const prizes=await db.query('SELECT id,title,kind,currency,amount_minor,weight FROM pp_prizes WHERE campaign_id=$1 AND inventory>0 ORDER BY id FOR UPDATE',[b.campaign_id]);
  const total=prizes.rows.reduce((n,p)=>n+p.weight,0);if(!Number.isSafeInteger(total)||total<0)throw fail(503,'Invalid prize weights');let selected=null;if(total){let n=randomInt(total);for(const p of prizes.rows){n-=p.weight;if(n<0){selected=p;break}}}
  if(selected)await db.query('UPDATE pp_prizes SET inventory=inventory-1 WHERE id=$1',[selected.id]);
  const s=await db.query("INSERT INTO pp_spins(anonymous_visitor_id,campaign_id,prize_id,status,spin_date,request_id,resolved_at,reward_snapshot_minor,reward_currency) VALUES($1,$2,$3,$4,(now() AT TIME ZONE 'UTC')::date,$5,now(),$6,$7) RETURNING id,status",[v.id,b.campaign_id,selected?.id||null,selected?'awarded':'no_prize',b.request_id,selected?.kind==='cash'?selected.amount_minor:null,selected?.kind==='cash'?selected.currency:null]);
  if(selected){await db.query("INSERT INTO pp_prize_claims(anonymous_visitor_id,spin_id,prize_id) VALUES($1,$2,$3)",[v.id,s.rows[0].id,selected.id]);if(selected.kind==='cash')await db.query("INSERT INTO pp_reward_ledger(anonymous_visitor_id,spin_id,source_type,currency,amount_minor,status) VALUES($1,$2,'prize_award',$3,$4,'pending')",[v.id,s.rows[0].id,selected.currency,selected.amount_minor])}
  return {...s.rows[0],prize_title:selected?.title||null,prize_kind:selected?.kind||null,used:usage.rows[0].used,replayed:false}
 });return json(res,200,result)
 }
 if(req.method==='GET'&&path==='/claims'){const v=await ensureVisitor(req,res);const r=await pool.query("SELECT c.id,c.status,c.created_at,p.title,p.kind FROM pp_prize_claims c JOIN pp_prizes p ON p.id=c.prize_id WHERE c.anonymous_visitor_id=$1 ORDER BY c.created_at DESC LIMIT 100",[v.id]);return json(res,200,{claims:r.rows})}
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
