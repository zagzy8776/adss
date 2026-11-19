/**
 * PayoutPool API — Cloudflare Worker + KV
 *
 *   POST /capture   store one entry          -> JSON payload from index.html
 *   GET  /feed      last 40 entries, masked  -> [{ n, p, t }]
 *   POST /hit       funnel counters          -> { e: "step_1" | "ad" | ... }
 *   GET  /winners   published draw results   -> [{ round, drawDate, rows:[...] }]
 *   POST /winners   publish one round        -> needs X-Admin-Token
 *   DELETE /winners?round=...  unpublish one -> needs X-Admin-Token
 *   GET  /health    liveness + binding check
 *
 * Deploy:  cd worker && npx wrangler kv namespace create PP
 *          paste the id into wrangler.toml, then  npx wrangler deploy
 *          npx wrangler secret put ADMIN_TOKEN   (enables /winners writes)
 * Then paste the printed URL into CONFIG.CAPTURE_ENDPOINT / FEED_URL / HIT_URL
 * and into WINNERS_URL at the bottom of winners.html.
 *
 * Nothing is returned to the client that identifies another person: the feed
 * exposes a masked display name, a coarse region, and a timestamp only. The
 * winners list is public by design and is typed in by the operator after a
 * draw — first name + last initial only.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;
/* Any country: 7–15 digits (E.164 maximum). No North-American assumption, so
   a +44, +234 or +55 number validates the same as a +1 one. */
const PHONE_RE = /^\+?\d{7,15}$/;

const ALLOW_EVENTS = new Set([
  'view', 'step_1', 'step_2', 'step_3', 'interstitial', 'ad',
  'ad_pop', 'ad_direct', 'ad_inter', 'ad_second', 'ad_stick_x',
  'capture_view', 'done', 'offer_click', 'ref_land', 'rehold',
  'exit_intent', 'hidden'
]);

function cors(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Token',
    'Access-Control-Max-Age': '86400'
  };
}

function json(body, status, env, extra) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({
      'Content-Type': 'application/json;charset=utf-8',
      'X-Content-Type-Options': 'nosniff'
    }, cors(env), extra || {})
  });
}

/* Display name: first letter of the local part, plus a masked tail.
   "marcus.t@gmail.com" -> "M•••" — enough to look like a person, not enough
   to identify one. */
function maskName(email) {
  const local = String(email).split('@')[0].replace(/[^a-z]/gi, '');
  if (!local) return 'A visitor';
  return local.charAt(0).toUpperCase() + '\u2022\u2022\u2022';
}

function region(cf) {
  const city = (cf && cf.city) || '';
  const rc = (cf && cf.regionCode) || '';
  const country = (cf && cf.country) || '';
  if (city && rc) return city + ', ' + rc;
  if (rc) return rc;
  /* Any country gets its own label — no US/Canada assumption. */
  return country || 'Online';
}

async function capture(req, env, ctx) {
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400, env); }

  /* Honeypot first: a filled "company" field means a bot. Answer as if it
     worked, store nothing. */
  if (body && body.company) return json({ ok: true }, 200, env);

  const email = String(body.email || '').trim().toLowerCase();
  /* Keep the leading + for international numbers; only strip the redundant
     North-American 1 that some phone keyboards add. */
  const rawPhone = String(body.phone || '').trim();
  const phone = (rawPhone.charAt(0) === '+' ? '+' : '') +
                rawPhone.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

  if (!EMAIL_RE.test(email) || email.length > 254) return json({ ok: false, error: 'email' }, 422, env);
  if (!PHONE_RE.test(phone) || !/[1-9]/.test(phone)) return json({ ok: false, error: 'phone' }, 422, env);
  if (body.consent !== true) return json({ ok: false, error: 'consent' }, 422, env);

  /* 5 submissions per IP per hour. */
  const ip = req.headers.get('CF-Connecting-IP') || '0.0.0.0';
  const hour = new Date().toISOString().slice(0, 13);
  const rlKey = 'rl:' + ip + ':' + hour;
  const hits = parseInt((await env.PP.get(rlKey)) || '0', 10);
  if (hits >= 5) return json({ ok: false, error: 'rate-limited' }, 429, env);
  await env.PP.put(rlKey, String(hits + 1), { expirationTtl: 3600 });

  const at = new Date().toISOString();
  const id = 'lead:' + at + ':' + Math.random().toString(36).slice(2, 8);

  const record = {
    id,
    email,
    phone,
    consent: true,
    consentAt: at,
    queue: Number(body.queue) || 0,
    ref: String(body.ref || '').slice(0, 16),
    code: String(body.code || '').slice(0, 16),
    page: String(body.page || '').slice(0, 300),
    tz: String(body.tz || '').slice(0, 64),
    ua: String(body.ua || '').slice(0, 300),
    country: (req.cf && req.cf.country) || '',
    region: region(req.cf),
    ip,
    at
  };

  await env.PP.put(id, JSON.stringify(record));

  /* Append to the public feed, trimmed at 40 rows. */
  const raw = await env.PP.get('feed');
  let feed = [];
  try { feed = JSON.parse(raw || '[]'); } catch (e) { feed = []; }
  feed.unshift({ n: maskName(email), p: record.region, t: at });
  await env.PP.put('feed', JSON.stringify(feed.slice(0, 40)));

  /* Daily counter. */
  const dayKey = 'hits:capture:' + at.slice(0, 10);
  const day = parseInt((await env.PP.get(dayKey)) || '0', 10);
  await env.PP.put(dayKey, String(day + 1));

  return json({ ok: true, ref: record.ref || null }, 200, env);
}

async function feed(req, env) {
  const raw = await env.PP.get('feed');
  let rows = [];
  try { rows = JSON.parse(raw || '[]'); } catch (e) { rows = []; }
  return json(rows, 200, env, { 'Cache-Control': 'public, max-age=60' });
}

async function hitCounter(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false }, 400, env); }
  const e = String((body && body.e) || '');
  if (!ALLOW_EVENTS.has(e)) return json({ ok: false, error: 'unknown-event' }, 422, env);

  const day = new Date().toISOString().slice(0, 10);
  const key = 'hits:' + e + ':' + day;
  const n = parseInt((await env.PP.get(key)) || '0', 10);
  await env.PP.put(key, String(n + 1));
  return json({ ok: true }, 200, env);
}

/* ---------------------------- published winners --------------------------
   KV key "winners" holds an array, newest round first:
     [{ round, drawDate, publishedAt, rows: [{ name, region, amount }] }]
   Reading is public (that is the point of the page). Writing needs the
   ADMIN_TOKEN secret, so an anonymous visitor can never invent a winner.
   ------------------------------------------------------------------------ */
const WINNERS_KEY = 'winners';
const WINNERS_MAX_ROUNDS = 24;
const WINNERS_MAX_ROWS = 20;

function clean(v, n) {
  return String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, n || 40);
}

/* Length-safe compare; avoids leaking the token through response timing. */
function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a.length || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function readWinners(env) {
  const raw = await env.PP.get(WINNERS_KEY);
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) { return []; }
}

function authorised(req, env) {
  if (!env.ADMIN_TOKEN) return false;
  return safeEqual(req.headers.get('X-Admin-Token'), env.ADMIN_TOKEN);
}

async function winners(req, env) {
  if (req.method === 'GET') {
    return json(await readWinners(env), 200, env, { 'Cache-Control': 'public, max-age=300' });
  }

  /* Writes stay off until a secret exists, so a public deploy cannot be
     written to by anyone who guesses the route. */
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'publishing-disabled' }, 503, env);
  if (!authorised(req, env)) return json({ ok: false, error: 'unauthorized' }, 401, env);

  if (req.method === 'DELETE') {
    const round = clean(new URL(req.url).searchParams.get('round'), 40);
    if (!round) return json({ ok: false, error: 'round-required' }, 422, env);
    const kept = (await readWinners(env)).filter(function (r) { return r && r.round !== round; });
    await env.PP.put(WINNERS_KEY, JSON.stringify(kept));
    return json({ ok: true, removed: round }, 200, env);
  }

  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false, error: 'bad-json' }, 400, env); }

  const round = clean(body && body.round, 40);
  const drawDate = clean(body && body.drawDate, 24);
  const rows = Array.isArray(body && body.rows) ? body.rows : [];
  if (!round || !rows.length) return json({ ok: false, error: 'round-and-rows-required' }, 422, env);

  const out = rows.slice(0, WINNERS_MAX_ROWS).map(function (r) {
    return {
      name: clean(r && r.name, 40),
      region: clean(r && r.region, 40) || 'Online',
      amount: clean(r && r.amount, 20) || '\u2014'
    };
  }).filter(function (r) { return r.name.length > 0; });

  if (!out.length) return json({ ok: false, error: 'no-valid-rows' }, 422, env);

  const list = await readWinners(env);
  const entry = { round, drawDate: drawDate || '', publishedAt: new Date().toISOString(), rows: out };
  /* Re-publishing the same round replaces it instead of duplicating it. */
  const next = [entry].concat(list.filter(function (r) { return r && r.round !== round; }))
    .slice(0, WINNERS_MAX_ROUNDS);

  await env.PP.put(WINNERS_KEY, JSON.stringify(next));
  return json({ ok: true, round, rows: out.length, rounds: next.length }, 200, env);
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(env) });

    if (path === '/health') {
      const probe = await env.PP.get('feed');
      return json({ ok: true, kv: probe === null ? 'empty' : 'ok' }, 200, env);
    }
    if (path === '/feed' && req.method === 'GET') return feed(req, env);
    if (path === '/capture' && req.method === 'POST') return capture(req, env, ctx);
    if (path === '/hit' && req.method === 'POST') return hitCounter(req, env);
    if (path === '/winners') return winners(req, env);

    return json({ ok: false, error: 'not-found' }, 404, env);
  }
};

