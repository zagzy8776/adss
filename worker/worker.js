/**
 * PayoutPool API — Cloudflare Worker + KV
 *
 *   POST /capture   store one entry          -> JSON payload from index.html
 *   GET  /feed      last 40 entries, masked  -> [{ n, p, t }]
 *   POST /hit       funnel counters          -> { e: "step_1" | "ad" | "ad_<id>" | ... }
 *   GET  /stats     aggregate counters, 14d   -> needs X-Admin-Token
 *   GET  /geo       where visitors come from  -> needs X-Admin-Token
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

/* Each ad network reports as ad_<id>, so a per-network fire can be counted
   without the worker knowing the network in advance. Lowercase, at most four
   segments (ad_adsterra_popunder) — same shape as the fixed names, so nothing
   new can be written that a dashboard cannot read. */
const AD_EVENT_RE = /^ad_[a-z0-9]+(?:_[a-z0-9]+){0,3}$/;

function eventAllowed(e) {
  if (ALLOW_EVENTS.has(e)) return true;
  return e.length <= 32 && AD_EVENT_RE.test(e);
}

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
    lang: String(body.lang || '').slice(0, 24),
    ua: String(body.ua || '').slice(0, 300),
    /* The edge's own view of where this lead came from, kept next to the
       browser's claim so a mismatch is visible on the record itself and not
       only in a daily counter. */
    country: (req.cf && req.cf.country) || '',
    region: region(req.cf),
    regionCode: (req.cf && req.cf.regionCode) || '',
    city: (req.cf && req.cf.city) || '',
    edgeTz: (req.cf && req.cf.timezone) || '',
    asn: (req.cf && req.cf.asn) || 0,
    tzMismatch: !!(tzRegion(req.cf && req.cf.timezone) && tzRegion(body.tz) &&
                   tzRegion(req.cf.timezone) !== tzRegion(body.tz)),
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

/* One counter, one key, incremented without a read-modify-write race that
   matters at this volume. KV has no atomic increment, so a lost count under
   concurrent writes is possible; the rollups are read as proportions, and one
   missing visit in a thousand does not move a percentage. */
async function bump(key, env) {
  const n = parseInt((await env.PP.get(key)) || '0', 10);
  await env.PP.put(key, String(n + 1));
  return n + 1;
}

/* ------------------------------- geo -------------------------------------
   Where the visits come from, counted at the edge.

   Cloudflare resolves every request to a country, a subdivision, a city and an
   ASN before the worker runs, so this needs no IP database, no third-party
   lookup and no cookie. The counters are written once per `view` event - the
   page sends exactly one per page load - so `geo:` totals are visits, not hits.

   Keys:  geo:c:<CC>:<day>         visits per country
          geo:r:<CC>-<SUB>:<day>   visits per subdivision (US-CA, GB-ENG, ...)
          geo:s:<signal>:<day>     anomaly counters (see SIGNALS below)

   The one signal worth having is the timezone mismatch. request.cf.timezone is
   the zone of the *connection's* location; the page reports the zone of the
   device's clock. A browser in Europe/Berlin arriving from a Lagos IP is a
   proxy, a VPN or a resold residential address - the traffic that reads as a
   real lead, gets paid for, and is clawed back at settlement. Comparing regions
   (Europe/ vs Africa/) and not cities, because every country spans several
   zones and a traveller is not fraud.
   ------------------------------------------------------------------------ */
const GEO_PREFIX = 'geo:';
const GEO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function tzRegion(tz) {
  const m = /^([A-Za-z_]+)\//.exec(String(tz || '').trim());
  return m ? m[1] : '';
}

async function countGeo(req, env, body) {
  const cf = req.cf || {};
  const day = new Date().toISOString().slice(0, 10);
  /* XX = the edge had no country (local wrangler dev, a health probe). Counted
     so the rollup can say "unknown" instead of silently dropping the visit and
     making the shares add up to more than they should. */
  const cc = String(cf.country || '').toUpperCase().slice(0, 2) || 'XX';
  const sub = String(cf.regionCode || '').toUpperCase().slice(0, 3);

  await bump(GEO_PREFIX + 'c:' + cc + ':' + day, env);
  if (cc !== 'XX' && sub) await bump(GEO_PREFIX + 'r:' + cc + '-' + sub + ':' + day, env);

  const edgeRegion = tzRegion(cf.timezone);
  const pageRegion = tzRegion(body && body.tz);
  if (edgeRegion && pageRegion && edgeRegion !== pageRegion) {
    await bump(GEO_PREFIX + 's:tz-mismatch:' + day, env);
  }
  return cc;
}

async function hitCounter(req, env) {
  let body;
  try { body = await req.json(); } catch (e) { return json({ ok: false }, 400, env); }
  const e = String((body && body.e) || '');
  if (!eventAllowed(e)) return json({ ok: false, error: 'unknown-event' }, 422, env);

  const day = new Date().toISOString().slice(0, 10);
  await bump('hits:' + e + ':' + day, env);

  /* Only the page view carries the geo rollup. Counting every ad event would
     multiply the KV writes by five and describe the same visitor five times. */
  let cc = '';
  if (e === 'view') cc = await countGeo(req, env, body);

  return json({ ok: true, cc: cc || undefined }, 200, env);
}

/* GET /geo?days=14   X-Admin-Token required
   Same window/shape rules as /stats: the operator's numbers, not the public's. */
async function geoReport(req, env) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'geo-disabled' }, 503, env);
  if (!authorised(req, env)) return json({ ok: false, error: 'unauthorized' }, 401, env);

  const want = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get('days'), 10) || 14, 1), 90);
  const since = new Date(Date.now() - (want - 1) * 864e5).toISOString().slice(0, 10);

  const listed = await env.PP.list({ prefix: GEO_PREFIX, limit: 1000 });
  const countries = {};
  const regions = {};
  const signals = {};
  let visits = 0;

  for (const k of listed.keys) {
    /* geo:<kind>:<id>:<day> - id may contain a hyphen (US-CA) but never a
       colon, so the last colon is always the day separator. */
    const rest = k.name.slice(GEO_PREFIX.length);
    const cut = rest.lastIndexOf(':');
    if (cut < 1) continue;
    const head = rest.slice(0, cut);
    const day = rest.slice(cut + 1);
    if (!GEO_DAY_RE.test(day) || day < since) continue;

    const sep = head.indexOf(':');
    if (sep < 1) continue;
    const kind = head.slice(0, sep);
    const id = head.slice(sep + 1);
    if (!id) continue;

    const n = parseInt((await env.PP.get(k.name)) || '0', 10);
    if (!n) continue;

    if (kind === 'c') { countries[id] = (countries[id] || 0) + n; visits += n; }
    else if (kind === 'r') { regions[id] = (regions[id] || 0) + n; }
    else if (kind === 's') { signals[id] = (signals[id] || 0) + n; }
  }

  const share = function (n) { return visits ? Math.round(10000 * n / visits) / 10000 : 0; };
  const countryRows = Object.keys(countries).map(function (cc) {
    return { cc: cc, visits: countries[cc], share: share(countries[cc]) };
  }).sort(function (a, b) { return b.visits - a.visits || (a.cc < b.cc ? -1 : 1); });

  const regionRows = Object.keys(regions).map(function (id) {
    return { region: id, visits: regions[id] };
  }).sort(function (a, b) { return b.visits - a.visits; }).slice(0, 25);

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    window: { days: want, since: since },
    visits: visits,
    countries: countryRows,
    regions: regionRows,
    signals: signals,
    scan: listed.list_complete === false ? 'truncated' : 'complete'
  }, 200, env, { 'Cache-Control': 'no-store' });
}

/* ------------------------------ stats ------------------------------------
   GET /stats?days=14   X-Admin-Token required
   Aggregates the hits:<event>:<day> counters into one payload so a dashboard
   does not have to scrape KV. Raw traffic numbers are not public, and the
   token compare is the same length-safe one /winners uses.
   ------------------------------------------------------------------------ */
async function stats(req, env) {
  if (!env.ADMIN_TOKEN) return json({ ok: false, error: 'stats-disabled' }, 503, env);
  if (!authorised(req, env)) return json({ ok: false, error: 'unauthorized' }, 401, env);

  const want = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get('days'), 10) || 14, 1), 90);
  const since = new Date(Date.now() - (want - 1) * 864e5).toISOString().slice(0, 10);

  /* 1000 keys covers ~70 events x 14 days, or 18 events x 55 days. */
  const listed = await env.PP.list({ prefix: 'hits:', limit: 1000 });
  const series = {};
  const totals = {};
  const days = [];

  for (const k of listed.keys) {
    /* hits:<event>:<day> — event names cannot contain ':', so the split is
       unambiguous. */
    const rest = k.name.slice('hits:'.length);
    const cut = rest.lastIndexOf(':');
    if (cut < 1) continue;
    const ev = rest.slice(0, cut);
    const day = rest.slice(cut + 1);
    if (day < since) continue;

    const n = parseInt((await env.PP.get(k.name)) || '0', 10);
    if (!n) continue;

    if (!series[ev]) series[ev] = {};
    series[ev][day] = n;
    totals[ev] = (totals[ev] || 0) + n;
    if (days.indexOf(day) < 0) days.push(day);
  }

  return json({
    ok: true,
    generatedAt: new Date().toISOString(),
    window: { days: want, since: since },
    days: days.sort(),
    series: series,
    totals: totals,
    scan: listed.list_complete === false ? 'truncated' : 'complete'
  }, 200, env, { 'Cache-Control': 'no-store' });
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
    if (path === '/stats' && req.method === 'GET') return stats(req, env);
    if (path === '/geo' && req.method === 'GET') return geoReport(req, env);
    if (path === '/winners') return winners(req, env);

    return json({ ok: false, error: 'not-found' }, 404, env);
  }
};

