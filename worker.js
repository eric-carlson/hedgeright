/* HedgeRight cloud sync — Cloudflare Worker
   Two KV keys under the same namespace:
     "design" — the whole app state, one JSON blob
     "users"  — array of {name, code, role}, role is 'editor' or 'viewer'

   Auth: Authorization: Bearer <code>
     code === env.SYNC_PASSWORD   -> owner: full access, including managing "users"
     code matches a users[] entry -> that entry's role (editor or viewer)
     anything else                -> 401

   The owner's bootstrap secret is never stored in the "users" list — it isn't an
   entry that can be edited or removed, it's what makes you the owner in the first
   place. Only the owner can read or write the "users" list; editors can read/write
   the design; viewers can only read it. */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match',
  /* Without this the browser hides these response headers from the page: the nursery's Crawl-delay, and the species
     library's version. */
  'Access-Control-Expose-Headers': 'X-Crawl-Delay, X-Species-Version',
};

/* Who may change the species library and use the nursery routes: the owner and editors, never viewers. (Managing
   users stays owner-only.) */
const canEdit = (who) => who.role === 'owner' || who.role === 'editor';

/* ---- Cal Flora Nursery access ----
   Everything this Worker fetches from calfloranursery.com goes through here: it identifies itself
   honestly (a name and a page describing the tool, not a browser string), reads robots.txt before
   fetching anything and refuses a path it disallows, and reports any Crawl-delay so the app can pace
   itself. robots.txt is only the site's crawler policy, not a licence: its terms and the copyright
   notice in its footer are separate, which is why the batch route below returns names and links only,
   and the app keeps structured facts rather than the nursery's description text. */
const CFN_UA = 'HedgeRightHarvester/1.0 (+https://eric-carlson.github.io/hedgeright/)';
const CFN_HOSTS = ['www.calfloranursery.com', 'calfloranursery.com'];
const CFN_TAXONOMIES = ['exposure','water-requirement','bloom-time','flower-color','flowers-foliage','habitat-value','native','plant-type','site-condition','special-use','tolerance'];

let _robots = { at: 0, rules: [], delay: 0 };
function parseRobots(text) {
  const groups = []; let cur = null, lastWasUA = false;
  text.split(/\r?\n/).forEach((raw) => {
    const line = raw.replace(/#.*$/, '').trim(); if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) return;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!cur || !lastWasUA) { cur = { agents: [], rules: [], delay: 0 }; groups.push(cur); } cur.agents.push(v.toLowerCase()); lastWasUA = true; return; }
    lastWasUA = false; if (!cur) return;
    if (k === 'disallow') cur.rules.push({ allow: false, path: v });
    else if (k === 'allow') cur.rules.push({ allow: true, path: v });
    else if (k === 'crawl-delay') cur.delay = Math.max(cur.delay, parseFloat(v) || 0);
  });
  /* A group naming this tool wins; otherwise every "*" group applies, merged (the file may repeat it). */
  const mine = groups.filter((g) => g.agents.some((a) => a.includes('hedgerightharvester')));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { rules: use.flatMap((g) => g.rules), delay: use.reduce((a, g) => Math.max(a, g.delay), 0) };
}
function robotsMatch(rulePath, target) {
  let p = rulePath, anchored = false;
  if (p.endsWith('$')) { anchored = true; p = p.slice(0, -1); }
  const re = new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + (anchored ? '$' : ''));
  return re.test(target);
}
/* Longest matching rule wins; on a tie, Allow wins; no match means allowed. An empty Disallow allows all. */
function robotsAllows(rules, target) {
  let best = null;
  for (const r of rules) {
    if (!r.path || !robotsMatch(r.path, target)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return !best || best.allow;
}
async function cfnRobots() {
  if (_robots.at && Date.now() - _robots.at < 3600e3) return _robots;
  let resp;
  try { resp = await fetch('https://www.calfloranursery.com/robots.txt', { headers: { 'User-Agent': CFN_UA } }); }
  catch (e) { throw new Error('Could not read robots.txt: ' + ((e && e.message) || e)); }
  if (resp.status === 404) { _robots = { at: Date.now(), rules: [], delay: 0 }; return _robots; }
  if (!resp.ok) throw new Error('robots.txt returned HTTP ' + resp.status + ', so nothing was fetched');
  _robots = Object.assign({ at: Date.now() }, parseRobots(await resp.text()));
  return _robots;
}
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/* ---- Plant-data sources (Calscape, Calflora) ----
   One generic route for sites that describe a plant on a page: /source?url=. Same rules as the nursery routes:
   an allowlist of hosts and paths (this is not a general proxy), robots.txt read first and obeyed, an honest
   User-Agent, and any Crawl-delay passed back so the app paces itself. Editors and the owner only. The page is
   returned as is; the app reads the facts it needs out of it (and keeps facts, not the sites' prose). Adding a
   site means adding it here and writing a small adapter in the app (WEB_SOURCES). */
const SRC_SITES = {
  'calscape.org': { origin: 'https://calscape.org', ok: (u) => u.pathname === '/search' ? false : /^\/(plant\/\d+\/)?[^\/]+$/.test(u.pathname) },
  'www.calflora.org': { origin: 'https://www.calflora.org', ok: (u) => (u.pathname === '/app/taxon' && /^\d+$/.test(u.searchParams.get('crn') || '')) || (u.pathname === '/cgi-bin/species_query.cgi' && /^[A-Za-z .+-]{3,80}$/.test(u.searchParams.get('where-taxon') || '')) }, /* the second form redirects to the taxon page, which is how a species with no stored Calflora number is found */
};
SRC_SITES['calflora.org'] = SRC_SITES['www.calflora.org'];
SRC_SITES['www.calscape.org'] = SRC_SITES['calscape.org'];
const _srcRobots = {};
async function srcRobots(origin) {
  const c = _srcRobots[origin]; if (c && Date.now() - c.at < 3600e3) return c;
  let resp;
  try { resp = await fetch(origin + '/robots.txt', { headers: { 'User-Agent': CFN_UA } }); }
  catch (e) { throw new Error('Could not read robots.txt: ' + ((e && e.message) || e)); }
  let r;
  if (resp.status === 404) r = { at: Date.now(), rules: [], delay: 0 };
  else if (!resp.ok) throw new Error('robots.txt returned HTTP ' + resp.status + ', so nothing was fetched');
  else r = Object.assign({ at: Date.now() }, parseRobots(await resp.text()));
  _srcRobots[origin] = r; return r;
}
/* A listing page's plants and its paging, read from the HTML. Names come from the plant links that carry
   text (the title links); image links are skipped because they wrap an <img>. If the markup ever nests the
   title in another element and no text link matches, fall back to the unique plant links with a name built
   from the address, so a layout change degrades to less-pretty names instead of nothing. */
function parseListing(html, pageUrl) {
  const plants = [], seen = new Set();
  const re = /<a\b[^>]*\bhref="(https?:\/\/(?:www\.)?calfloranursery\.com\/plants\/([a-z0-9-]+)\/)"[^>]*>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = decodeEntities(m[3]).replace(/\s+/g, ' ').trim();
    if (!name || seen.has(m[2])) continue;
    seen.add(m[2]); plants.push({ slug: m[2], url: m[1], name });
  }
  if (!plants.length) {
    const re2 = /href="(https?:\/\/(?:www\.)?calfloranursery\.com\/plants\/([a-z0-9-]+)\/)"/gi;
    while ((m = re2.exec(html))) {
      if (seen.has(m[2])) continue; seen.add(m[2]);
      plants.push({ slug: m[2], url: m[1], name: m[2].replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) });
    }
  }
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((x) => decodeEntities(x[1]));
  let kind = 'none', param = null, max = 1;
  hrefs.forEach((h) => {
    const q = h.match(/[?&](query-[a-z0-9]+-page)=(\d+)/i);
    if (q) { kind = 'query'; param = param || q[1]; max = Math.max(max, +q[2]); }
  });
  if (kind === 'none') {
    const base = pageUrl.pathname.replace(/page\/\d+\/$/, '');
    hrefs.forEach((h) => {
      try {
        const hu = new URL(h, pageUrl);
        if (hu.pathname.startsWith(base)) { const pm = hu.pathname.slice(base.length).match(/^page\/(\d+)\/$/); if (pm) { kind = 'path'; max = Math.max(max, +pm[1]); } }
      } catch (e) { /* not a usable link */ }
    });
  }
  return { plants, paging: { kind, param, max } };
}

/* ---- Reading a nursery plant page from its markup ----
   Written against the real HTML of a sample of plant pages. Every category sits in
   <div class="taxonomy-group"><h4>Label</h4><ul class="taxonomy-list"><li>term</li>...</ul></div>, so a section
   the page does not have is simply absent and nothing can run on into the next one (cutting by line count did,
   and pulled photo credits and the description into the last section). The inventory is a real table with a
   column per container (4in, 1g, 5g) and one cell per container per row, empty when there is none, so cells
   are matched to containers by column, never by guessing from the order of the text. */
function stripTags(s) { return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function parseTaxonomies(html) {
  const labels = {}; let found = false, m;
  const re = /<div class="taxonomy-group[^"]*">\s*<h4[^>]*>([^<]+)<\/h4>\s*<ul class="taxonomy-list[^"]*">([\s\S]*?)<\/ul>/g;
  while ((m = re.exec(html))) {
    found = true;
    labels[decodeEntities(m[1]).trim()] = [...m[2].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map((x) => stripTags(x[1])).filter(Boolean);
  }
  return { labels, found };
}
function parseInventoryTable(html) {
  const m = html.match(/<table[^>]*id="single-plant-table"[^>]*>([\s\S]*?)<\/table>/);
  if (!m) return null;
  const containers = [...m[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => stripTags(x[1])).slice(1);
  const body = (m[1].match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/) || [null, m[1]])[1];
  const rows = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((r) => {
    const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    const cells = tds.slice(1).map((td) => {
      const q = td.match(/inventory-qty[^>]*>([^<]*)</), pr = td.match(/inventory-price[^>]*>([^<]*)</);
      const qty = q && /(\d+)/.exec(q[1]), price = pr && /\$\s*([\d,]+(?:\.\d+)?)/.exec(pr[1]);
      return qty || price ? { qty: qty ? +qty[1] : null, price: price ? parseFloat(price[1].replace(/,/g, '')) : null } : null;
    });
    return { note: stripTags(tds[0] || ''), cells };
  }).filter((r) => r.note || r.cells.some(Boolean));
  return { containers, rows };
}
function parseInventoryDate(html) {
  const i = html.search(/was updated on/i); if (i < 0) return null;
  const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const dm = stripTags(html.slice(i, i + 400)).match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s*(\d{4})/i);
  return dm ? dm[3] + '-' + String(MONTHS.indexOf(dm[1].toLowerCase()) + 1).padStart(2, '0') + '-' + String(dm[2]).padStart(2, '0') : null;
}

async function identify(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const code = auth.replace(/^Bearer\s+/i, '');
  if (!code) return null;
  if (env.SYNC_PASSWORD && code === env.SYNC_PASSWORD) {
    return { role: 'owner', name: 'Owner', code };
  }
  const raw = await env.DESIGN_KV.get('users');
  const users = raw ? JSON.parse(raw) : [];
  const u = users.find((x) => x.code === code);
  if (u) return { role: u.role === 'viewer' ? 'viewer' : 'editor', name: u.name || 'Unnamed', code };
  return null;
}

export default {
  async fetch(request, env) {
    /* Whatever happens below, always return a response carrying CORS_HEADERS — an
       unhandled exception otherwise produces Cloudflare's own generic error page,
       which has none, and the browser reports that as a CORS failure with no hint
       of the real problem underneath it. */
    try {
      return await handle(request, env);
    } catch (e) {
      return new Response('Internal error: ' + ((e && e.message) || String(e)), {
        status: 500,
        headers: CORS_HEADERS,
      });
    }
  },
};

async function handle(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const who = await identify(request, env);
    if (!who) {
      return new Response('Unauthorized', { status: 401, headers: CORS_HEADERS });
    }

    if (url.pathname === '/whoami' && request.method === 'GET') {
      return new Response(JSON.stringify({ role: who.role, name: who.name }), {
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/design') {
      if (request.method === 'GET') {
        const raw = await env.DESIGN_KV.get('design');
        if (raw === null) {
          return new Response(JSON.stringify({ data: null, updatedAt: null, updatedBy: null }), {
            headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
          });
        }
        return new Response(raw, {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        if (who.role === 'viewer') {
          return new Response('Forbidden — view-only access', { status: 403, headers: CORS_HEADERS });
        }
        const body = await request.text();
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (e) {
          return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS });
        }
        if (parsed === null || typeof parsed !== 'object' || parsed.data === undefined) {
          return new Response('Invalid body — expected {data, expectedUpdatedAt}', { status: 400, headers: CORS_HEADERS });
        }
        /* No compare-and-swap here on purpose. KV is eventually consistent — a write
           isn't guaranteed visible to a read moments later, even from the same
           Worker — so checking "does the stored updatedAt match what the client last
           saw" right before every write produced false conflicts against the client's
           own immediately-prior save during normal autosave-paced editing. Real
           conflict prevention needs a strongly-consistent store (D1, Durable Objects);
           until/unless that happens, every write just wins, and updatedAt/updatedBy
           are informational only — used by the client's tab-focus staleness check,
           which isn't time-sensitive enough to hit the same race. */
        const wrapped = { data: parsed.data, updatedAt: Date.now(), updatedBy: who.name };
        await env.DESIGN_KV.put('design', JSON.stringify(wrapped));
        return new Response(JSON.stringify({ updatedAt: wrapped.updatedAt }), {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
    }

    if (url.pathname === '/catalog-all') {
      /* Owner and editors. The nursery's Plant Finder has a "Show All Plants" option (?_show_all=-1) that lists every
         plant on ONE page, about 1,000 cards and 2-3 MB. This route fetches that page and streams it straight
         back without reading it: parsing that much text here could exceed a free plan's CPU limit, and the
         browser can read it (with its own HTML parser) at no cost to the Worker. The address is fixed, so this
         is not a way to fetch anything else. robots.txt is checked first, like every other route. */
      if (!canEdit(who)) {
        return new Response('Forbidden — owner or editor only', { status: 403, headers: CORS_HEADERS });
      }
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      /* With no address it is the whole catalog. With a Plant Finder address (filters and all) it is every
         match for those filters, again in one request: the nursery's Show All works together with its filters. Any
         page number is dropped, since Show All has no pages; anything that is not the Plant Finder is refused. */
      let target = 'https://www.calfloranursery.com/find-the-right-plant/?_show_all=-1';
      const asked = url.searchParams.get('url');
      if (asked) {
        let a;
        try { a = new URL(asked); } catch (e) { return new Response('Invalid url', { status: 400, headers: CORS_HEADERS }); }
        if (a.protocol !== 'https:' || !CFN_HOSTS.includes(a.hostname) || a.pathname !== '/find-the-right-plant/') {
          return new Response('Only a Plant Finder address on calfloranursery.com is supported', { status: 400, headers: CORS_HEADERS });
        }
        const q = new URLSearchParams(); q.set('_show_all', '-1');
        a.searchParams.forEach((v, k) => { if (k !== '_show_all' && !/^query-.*-page$/.test(k)) q.append(k, v); });
        target = 'https://www.calfloranursery.com/find-the-right-plant/?' + q.toString();
      }
      let rob;
      try { rob = await cfnRobots(); } catch (e) { return new Response((e && e.message) || String(e), { status: 502, headers: CORS_HEADERS }); }
      if (!robotsAllows(rob.rules, new URL(target).pathname + new URL(target).search)) {
        return new Response('robots.txt disallows fetching that page', { status: 403, headers: CORS_HEADERS });
      }
      let pageResp;
      try { pageResp = await fetch(target, { headers: { 'User-Agent': CFN_UA } }); }
      catch (e) { return new Response('Could not reach that page: ' + ((e && e.message) || String(e)), { status: 502, headers: CORS_HEADERS }); }
      if (!pageResp.ok) return new Response('That page returned HTTP ' + pageResp.status, { status: 502, headers: CORS_HEADERS });
      return new Response(pageResp.body, { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Crawl-Delay': String(rob.delay || 0), 'Access-Control-Expose-Headers': 'X-Crawl-Delay' } });
    }

    if (url.pathname === '/catalog-page') {
      /* Owner and editors. Returns the plants on ONE listing page (a Plant Finder page, filters and all, or a
         category page such as /site-condition/under-oaks/) plus how many pages there are. The app calls
         it once per page with a pause between calls, so pacing, progress and cancelling all live there
         and no single request runs long or makes many subrequests. Names and links only. */
      if (!canEdit(who)) {
        return new Response('Forbidden — owner or editor only', { status: 403, headers: CORS_HEADERS });
      }
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      let target;
      try { target = new URL(url.searchParams.get('url') || ''); } catch (e) { return new Response('Invalid url', { status: 400, headers: CORS_HEADERS }); }
      const okPath = target.pathname === '/find-the-right-plant/'
        || new RegExp('^/(' + CFN_TAXONOMIES.join('|') + ')/[a-z0-9-]+/(page/\\d+/)?$').test(target.pathname);
      if (target.protocol !== 'https:' || !CFN_HOSTS.includes(target.hostname) || !okPath) {
        return new Response('Only a Plant Finder page or a category page on calfloranursery.com is supported', { status: 400, headers: CORS_HEADERS });
      }
      let rob;
      try { rob = await cfnRobots(); } catch (e) { return new Response((e && e.message) || String(e), { status: 502, headers: CORS_HEADERS }); }
      if (!robotsAllows(rob.rules, target.pathname + target.search)) {
        return new Response('robots.txt disallows fetching that page', { status: 403, headers: CORS_HEADERS });
      }
      let pageResp;
      try { pageResp = await fetch(target.toString(), { headers: { 'User-Agent': CFN_UA } }); }
      catch (e) { return new Response('Could not reach that page: ' + ((e && e.message) || String(e)), { status: 502, headers: CORS_HEADERS }); }
      if (!pageResp.ok) return new Response('That page returned HTTP ' + pageResp.status, { status: 502, headers: CORS_HEADERS });
      const listing = parseListing(await pageResp.text(), target);
      return new Response(JSON.stringify({ plants: listing.plants, paging: listing.paging, crawlDelay: rob.delay, url: target.toString() }),
        { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/source') {
      if (!canEdit(who)) return new Response('Forbidden — owner or editor only', { status: 403, headers: CORS_HEADERS });
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      let t;
      try { t = new URL(url.searchParams.get('url') || ''); } catch (e) { return new Response('Invalid url', { status: 400, headers: CORS_HEADERS }); }
      const site = SRC_SITES[t.hostname];
      if (t.protocol !== 'https:' || !site || !site.ok(t)) return new Response('That address is not one this tool reads (Calscape plant pages and Calflora taxon pages only)', { status: 400, headers: CORS_HEADERS });
      let rob;
      try { rob = await srcRobots(site.origin); } catch (e) { return new Response((e && e.message) || String(e), { status: 502, headers: CORS_HEADERS }); }
      if (!robotsAllows(rob.rules, t.pathname + t.search)) return new Response('robots.txt disallows fetching that page', { status: 403, headers: CORS_HEADERS });
      let pageResp;
      try { pageResp = await fetch(t.toString(), { headers: { 'User-Agent': CFN_UA }, redirect: 'follow' }); }
      catch (e) { return new Response('Could not reach that page: ' + ((e && e.message) || String(e)), { status: 502, headers: CORS_HEADERS }); }
      let fin; try { fin = new URL(pageResp.url); } catch (e) { fin = t; }
      if (!SRC_SITES[fin.hostname]) return new Response('That page redirected somewhere this tool does not read', { status: 502, headers: CORS_HEADERS });
      if (pageResp.status === 404) return new Response('Not found', { status: 404, headers: { ...CORS_HEADERS, 'X-Crawl-Delay': String(rob.delay || 0), 'Access-Control-Expose-Headers': 'X-Crawl-Delay, X-Final-Url' } });
      if (!pageResp.ok) return new Response('That page returned HTTP ' + pageResp.status, { status: 502, headers: CORS_HEADERS });
      const body = (await pageResp.text()).slice(0, 900000);
      return new Response(body, { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Crawl-Delay': String(rob.delay || 0), 'X-Final-Url': fin.toString(), 'Access-Control-Expose-Headers': 'X-Crawl-Delay, X-Final-Url' } });
    }
    if (url.pathname === '/harvest') {
      /* Owner-only. Fetches one Cal Flora Nursery species page server-side (the
         browser can't — calfloranursery.com sets no CORS headers for cross-origin
         fetches) and pulls out plain-text field values for the client to map onto
         the species schema. Restricted to this one trusted domain deliberately —
         this is not a general-purpose proxy. Best-effort text-pattern extraction,
         not a guaranteed-correct parse of their markup. */
      if (!canEdit(who)) {
        return new Response('Forbidden — owner or editor only', { status: 403, headers: CORS_HEADERS });
      }
      if (request.method !== 'GET') {
        return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS });
      }
      const target = url.searchParams.get('url');
      if (!target) {
        return new Response('Missing url parameter', { status: 400, headers: CORS_HEADERS });
      }
      let targetUrl;
      try {
        targetUrl = new URL(target);
      } catch (e) {
        return new Response('Invalid url', { status: 400, headers: CORS_HEADERS });
      }
      if (targetUrl.hostname !== 'www.calfloranursery.com' && targetUrl.hostname !== 'calfloranursery.com') {
        return new Response('Only calfloranursery.com URLs are supported right now', { status: 400, headers: CORS_HEADERS });
      }
      try {
        const rob = await cfnRobots();
        if (!robotsAllows(rob.rules, targetUrl.pathname + targetUrl.search)) {
          return new Response('robots.txt disallows fetching that page', { status: 403, headers: CORS_HEADERS });
        }
      } catch (e) {
        return new Response((e && e.message) || String(e), { status: 502, headers: CORS_HEADERS });
      }
      let pageResp;
      try {
        pageResp = await fetch(targetUrl.toString(), {
          headers: { 'User-Agent': CFN_UA },
        });
      } catch (e) {
        return new Response('Could not reach that page: ' + ((e && e.message) || String(e)), {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
      if (!pageResp.ok) {
        return new Response('That page returned HTTP ' + pageResp.status, { status: 502, headers: CORS_HEADERS });
      }
      const chunks = [];
      let buf = '';
      const rewriter = new HTMLRewriter()
        .on('script', { element(el) { el.remove(); } })
        .on('style', { element(el) { el.remove(); } })
        .on('nav', { element(el) { el.remove(); } })
        .on('footer', { element(el) { el.remove(); } })
        .on('body *', {
          text(t) {
            buf += t.text;
            if (t.lastInTextNode) {
              const s = buf.trim();
              if (s) chunks.push(s);
              buf = '';
            }
          },
        });
      const raw = await pageResp.text();
      await rewriter.transform(new Response(raw)).text();
      const lines = chunks;
      const plain = lines.join('\n');
      /* Cal Flora Nursery's pages use two different layouts, confirmed against a
         real fetch: "Average Height: 4 - 8 ft" (label and value on one line), and
         section headers like "Exposures" / "Water Requirements" / "Bloom Times" on
         their own line, with the value(s) on the line(s) after — plural, not
         singular, and with no colon. There's also no literal "Botanical Name:" or
         "Common Name:" label anywhere; the scientific and common names are just two
         bare lines, found here via a stable instructional line that follows them on
         every plant page. */
      const SECTION_LABELS = ['Native','Plant Types','Size','Exposures','Water Requirements','Bloom Times','Flower Colors','Habitat Values','Site Conditions','Tolerances','Special Uses','Flowers and Foliage'];
      /* 'Flowers and Foliage' is the last labelled section on the page. Without it as a terminator,
         'Special Uses' ran on into it and then into the image captions below. */
      const secIdx = [];
      lines.forEach((l, i) => { if (SECTION_LABELS.includes(l)) secIdx.push({ label: l, i }); });
      const sections = {};
      secIdx.forEach((s, k) => {
        const end = k + 1 < secIdx.length ? secIdx[k + 1].i : Math.min(lines.length, s.i + 10);
        sections[s.label] = lines.slice(s.i + 1, end);
      });
      /* The structural reading replaces the line-based one whenever the page has the taxonomy blocks. The
         line-based sections above stay only as a fallback for a page laid out differently. */
      const tax = parseTaxonomies(raw);
      if (tax.found) SECTION_LABELS.forEach((k) => { sections[k] = tax.labels[k] || []; });
      const landmark = lines.findIndex((l) => l.startsWith('Click on a characteristic from the list below'));
      const commonName = landmark >= 1 ? lines[landmark - 1] : null;
      const botanicalName = landmark >= 2 ? lines[landmark - 2] : null;
      const sizeLines = sections['Size'] || [];
      const heightLine = sizeLines.find((l) => /^Average Height/i.test(l));
      const widthLine = sizeLines.find((l) => /^Average Width/i.test(l));
      const joinLabeled = (l) => (l ? l.split(':').slice(1).join(':').trim() : null);
      /* The nursery's monthly inventory table: { containers: ['4in','1g'], rows: [{ note, cells: [{qty, price} | null, ...] }] },
         one cell per container in column order, null where the nursery has none. A page without one (a plant
         not in stock this month) returns an empty table, never an error. */
      const inventory = parseInventoryTable(raw) || { containers: [], rows: [] };
      const inventoryAsOf = parseInventoryDate(raw);
      const data = {
        botanicalName,
        commonName,
        height: joinLabeled(heightLine),
        width: joinLabeled(widthLine),
        exposure: (sections['Exposures'] || []).join(', ') || null,
        water: (sections['Water Requirements'] || []).join(', ') || null,
        bloomTime: (sections['Bloom Times'] || []).join(', ') || null,
        tolerances: (sections['Tolerances'] || []).join(', ') || null,
        habitatValues: (sections['Habitat Values'] || []).join(', ') || null,
        specialUses: (sections['Special Uses'] || []).join(', ') || null,
        siteConditions: (sections['Site Conditions'] || []).join(', ') || null,
        /* '' = the page has its category blocks but no Native one (the nursery lists no native status);
           null = the page could not be read that way at all. */
        native: tax.found ? (sections['Native'] || []).join(', ') : ((sections['Native'] || []).join(', ') || null),
        plantType: (sections['Plant Types'] || []).join(', ') || null,
        inventory,
        inventoryAsOf,
        flowerColor: (sections['Flower Colors'] || []).join(', ') || null,
        rawText: plain.slice(0, 6000),
      };
      return new Response(JSON.stringify(data), { headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
    }

    if (url.pathname === '/view') {
      /* Per-person, not part of the shared design at all — a separate KV key, keyed
         by the caller's own identity, that the compare-and-swap logic on /design
         never looks at. Storing or reading it can never make /design's updatedAt
         change, so it can never trigger anyone's staleness warning. Any role can
         read and write their own — remembering where you last looked has nothing to
         do with edit permissions. The value is opaque to the Worker: whatever JSON
         the client sends is what it gets back, no shape enforced here. */
      const uid = who.role === 'owner' ? 'owner' : who.code;
      if (request.method === 'GET') {
        const raw = await env.DESIGN_KV.get('view:' + uid);
        return new Response(raw === null ? 'null' : raw, {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        try {
          JSON.parse(body);
        } catch (e) {
          return new Response('Invalid JSON', { status: 400, headers: CORS_HEADERS });
        }
        await env.DESIGN_KV.put('view:' + uid, body);
        return new Response('OK', { headers: CORS_HEADERS });
      }
    }

    if (url.pathname === '/species') {
      /* The species library, shared across every ranch/design under this deployment: a separate KV key, not part of any
         one design's saved blob. Any authenticated role can read it; the owner and editors can write it (viewers cannot).
         Every save replaces the whole library, so two people saving from different copies could silently erase each
         other's work. To prevent that the library carries a VERSION, a counter in 'species:meta': GET sends it in
         X-Species-Version, and a PUT that says which version it started from (If-Match) is refused with 409, carrying
         the current library and version, if anyone has saved since. The app then merges species by species and tries
         again. A PUT with no If-Match (an older copy of the app) is accepted as before, with no protection. */
      const meta = async () => {
        const raw = await env.DESIGN_KV.get('species:meta');
        try { return raw ? JSON.parse(raw) : { v: 0 }; } catch (e) { return { v: 0 }; }
      };
      const withVersion = (v) => ({ ...CORS_HEADERS, 'X-Species-Version': String(v) });
      if (request.method === 'GET') {
        const raw = await env.DESIGN_KV.get('species');
        const m = await meta();
        return new Response(raw === null ? 'null' : raw, {
          headers: { ...withVersion(m.v), 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        if (!canEdit(who)) {
          return new Response('Forbidden — owner or editor only', { status: 403, headers: CORS_HEADERS });
        }
        const body = await request.text();
        let list;
        try {
          list = JSON.parse(body);
          if (!Array.isArray(list)) throw new Error('not an array');
        } catch (e) {
          return new Response('Invalid JSON — expected an array', { status: 400, headers: CORS_HEADERS });
        }
        const m = await meta();
        const ifMatch = request.headers.get('If-Match');
        if (ifMatch !== null && ifMatch !== String(m.v)) {
          const current = await env.DESIGN_KV.get('species');
          return new Response(current === null ? 'null' : current, {
            status: 409,
            headers: { ...withVersion(m.v), 'Content-Type': 'application/json' },
          });
        }
        const v = (m.v || 0) + 1;
        await env.DESIGN_KV.put('species', JSON.stringify(list));
        await env.DESIGN_KV.put('species:meta', JSON.stringify({ v, by: who.name, at: new Date().toISOString() }));
        return new Response('OK', { headers: withVersion(v) });
      }
    }

    if (url.pathname === '/users') {
      if (who.role !== 'owner') {
        return new Response('Forbidden — owner only', { status: 403, headers: CORS_HEADERS });
      }
      if (request.method === 'GET') {
        const data = await env.DESIGN_KV.get('users');
        return new Response(data === null ? '[]' : data, {
          headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
        });
      }
      if (request.method === 'PUT') {
        const body = await request.text();
        let list;
        try {
          list = JSON.parse(body);
          if (!Array.isArray(list)) throw new Error('not an array');
        } catch (e) {
          return new Response('Invalid JSON — expected an array', { status: 400, headers: CORS_HEADERS });
        }
        for (const u of list) {
          if (!u || typeof u.name !== 'string' || typeof u.code !== 'string' || !['editor', 'viewer'].includes(u.role)) {
            return new Response('Invalid entry — each needs name, code, and role (editor/viewer)', {
              status: 400,
              headers: CORS_HEADERS,
            });
          }
        }
        await env.DESIGN_KV.put('users', JSON.stringify(list));
        return new Response('OK', { headers: CORS_HEADERS });
      }
    }

    return new Response('Not found', { status: 404, headers: CORS_HEADERS });
}
