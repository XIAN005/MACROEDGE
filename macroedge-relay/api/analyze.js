// MacroEdge Desk — relais Vercel (ESM, Node 22). Une route, paramètre ?action=chat|history|quotes|calendar|news|test
const sleep = ms => new Promise(r => setTimeout(r, ms));
const E = (m, status, source, quota) => Object.assign(new Error(m), { status, source, quota });
const J = (res, code, obj, cache) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(obj));
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

// ---------- réseau : timeout 8 s, 1 retry (timeout/429/5xx) après 1 s, jamais sur 4xx ----------
async function hfetch(url, opt = {}) {
  for (let i = 0; i < 2; i++) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 8000);
    try {
      const r = await fetch(url, { ...opt, signal: ac.signal });
      clearTimeout(t);
      if ((r.status === 429 || r.status >= 500) && i === 0) { await sleep(1000); continue; }
      return r;
    } catch (e) {
      clearTimeout(t);
      if (i === 0) { await sleep(1000); continue; }
      throw E(e.name === 'AbortError' ? 'timeout (8 s)' : 'réseau : ' + e.message, 504);
    }
  }
}
async function jget(url, opt, src) {
  const r = await hfetch(url, opt), tx = await r.text();
  let j; try { j = JSON.parse(tx); } catch { throw E(`réponse non-JSON (HTTP ${r.status})`, r.status, src); }
  if (!r.ok) throw E(`HTTP ${r.status}`, r.status, src, false);
  return j;
}
async function tget(url, opt, src) {
  const r = await hfetch(url, opt);
  if (!r.ok) throw E(`HTTP ${r.status}`, r.status, src, false);
  return r.text();
}
const fail = (q, n) => (q.debug_fail || '').split(',').includes(n);

// ---------- validation des bougies ----------
function validate(c, src) {
  if (!Array.isArray(c) || c.length < 100) throw E(`moins de 100 bougies (${c ? c.length : 0})`, 422, src);
  for (let i = 0; i < c.length; i++) {
    const b = c[i];
    if (![b.open, b.high, b.low, b.close].every(v => Number.isFinite(v) && v > 0)) throw E('prix nul ou invalide', 422, src);
    if (i && !(c[i].date > c[i - 1].date)) throw E('dates non croissantes', 422, src);
    if (i && Math.abs(b.close / c[i - 1].close - 1) > 0.08) throw E('variation journalière aberrante (>8 %)', 422, src);
  }
  return c;
}
const num = v => parseFloat(v);

// ---------- historique : fournisseurs ----------
const H = {
  async twelvedata(sym, k, q) {
    if (!k) throw E('clé manquante', 401, 'twelvedata');
    if (fail(q, 'twelvedata')) throw E('panne simulée', 503, 'twelvedata');
    const j = await jget(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(sym)}&interval=1day&outputsize=120&apikey=${k}`, {}, 'twelvedata');
    if (j.status === 'error') throw E(j.message || 'erreur Twelve Data', j.code || 400, 'twelvedata', j.code === 429 && /day/i.test(j.message || ''));
    return j.values.map(v => ({ date: v.datetime.slice(0, 10), open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close) })).reverse();
  },
  async alphavantage(sym, k, q) {
    if (!k) throw E('clé manquante', 401, 'alphavantage');
    if (fail(q, 'alphavantage')) throw E('panne simulée', 503, 'alphavantage');
    const [f, t] = sym.split('/');
    const j = await jget(`https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${f}&to_symbol=${t}&outputsize=compact&apikey=${k}`, {}, 'alphavantage');
    if (j.Note || j.Information) throw E('limite Alpha Vantage atteinte', 429, 'alphavantage', true);
    const ts = j['Time Series FX (Daily)'];
    if (!ts) throw E(j['Error Message'] || 'structure inattendue', 422, 'alphavantage');
    return Object.keys(ts).sort().map(d => ({ date: d, open: num(ts[d]['1. open']), high: num(ts[d]['2. high']), low: num(ts[d]['3. low']), close: num(ts[d]['4. close']) }));
  },
  async frankfurter(sym, k, q) {
    if (fail(q, 'frankfurter')) throw E('panne simulée', 503, 'frankfurter');
    const [f, t] = sym.split('/');
    if (f === 'XAU' || t === 'XAU') throw E("pas d'or chez Frankfurter", 422, 'frankfurter');
    const start = new Date(Date.now() - 190 * 864e5).toISOString().slice(0, 10);
    const j = await jget(`https://api.frankfurter.dev/v1/${start}..?base=${f}&symbols=${t}`, {}, 'frankfurter');
    if (!j.rates) throw E('structure inattendue', 422, 'frankfurter');
    return Object.keys(j.rates).sort().map(d => { const p = num(j.rates[d][t]); return { date: d, open: p, high: p, low: p, close: p }; });
  },
  async stooq(sym, k, q) {
    if (fail(q, 'stooq')) throw E('panne simulée', 503, 'stooq');
    const s = sym.replace('/', '').toLowerCase();
    const tx = await tget(`https://stooq.com/q/d/l/?s=${s}&i=d`, { headers: { 'User-Agent': UA } }, 'stooq');
    if (!/^Date,Open/i.test(tx)) throw E('format CSV inattendu', 422, 'stooq');
    const rows = tx.trim().split('\n').slice(1).map(l => l.split(','));
    return rows.map(r => ({ date: r[0], open: num(r[1]), high: num(r[2]), low: num(r[3]), close: num(r[4]) })).slice(-120);
  }
};
const NEEDS_KEY = { twelvedata: 'twelvedata', alphavantage: 'alphavantage' };

async function getDaily(sym, keys, q) {
  const order = (q.order || 'twelvedata,alphavantage,frankfurter,stooq').split(',').filter(n => H[n] && !(q.disabled || '').split(',').includes(n));
  const attempts = []; let n = 0;
  for (const name of order) {
    if (n >= 3) break; // budget Vercel : 3 tentatives max
    if (NEEDS_KEY[name] && !keys[name]) { attempts.push({ source: name, error: 'clé absente' }); continue; }
    n++;
    try {
      const candles = validate(await H[name](sym, keys[name], q), name);
      return { symbol: sym, candles, source: name + (name === 'stooq' ? ' (non officiel)' : ''), fetched_at: new Date().toISOString(), attempts };
    } catch (e) { attempts.push({ source: name, error: e.message, quota: !!e.quota, status: e.status }); }
  }
  const err = E('aucune source ne fournit ' + sym, 502, 'history'); err.attempts = attempts; throw err;
}
async function getQuote(sym, keys, q) {
  const [f, t] = sym.split('/'), attempts = [];
  if (keys.twelvedata && !fail(q, 'twelvedata')) {
    try {
      const j = await jget(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(sym)}&apikey=${keys.twelvedata}`, {}, 'twelvedata');
      const p = num(j.price);
      if (j.status !== 'error' && p > 0) return { symbol: sym, price: p, datetime: new Date().toISOString(), source: 'twelvedata' };
      attempts.push({ source: 'twelvedata', error: j.message || 'prix invalide' });
    } catch (e) { attempts.push({ source: 'twelvedata', error: e.message }); }
  }
  if (keys.alphavantage && !fail(q, 'alphavantage')) {
    try {
      const j = await jget(`https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${f}&to_currency=${t}&apikey=${keys.alphavantage}`, {}, 'alphavantage');
      const d = j['Realtime Currency Exchange Rate'], p = d && num(d['5. Exchange Rate']);
      if (p > 0) return { symbol: sym, price: p, datetime: new Date(d['6. Last Refreshed'].replace(' ', 'T') + 'Z').toISOString(), source: 'alphavantage' };
      attempts.push({ source: 'alphavantage', error: j.Note || j.Information || 'structure inattendue' });
    } catch (e) { attempts.push({ source: 'alphavantage', error: e.message }); }
  }
  const err = E('prix instantané indisponible (le front utilisera la dernière clôture)', 502, 'quotes'); err.attempts = attempts; throw err;
}

// ---------- calendrier ----------
const IMP = s => { s = String(s || '').toLowerCase(); return /high|3/.test(s) ? 'fort' : /med|2/.test(s) ? 'moyen' : 'faible'; };
const CAL = {
  async finnhub(keys, q) {
    if (!keys.finnhub) throw E('clé manquante', 401, 'finnhub');
    if (fail(q, 'finnhub')) throw E('panne simulée', 503, 'finnhub');
    const a = new Date().toISOString().slice(0, 10), b = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    const j = await jget(`https://finnhub.io/api/v1/calendar/economic?from=${a}&to=${b}`, { headers: { 'X-Finnhub-Token': keys.finnhub } }, 'finnhub');
    if (!j.economicCalendar) throw E('structure inattendue ou accès refusé', 403, 'finnhub');
    return j.economicCalendar.map((e, i) => ({ id: 'fh' + i, title: e.event, currency: e.country, impact: IMP(e.impact), time: new Date(String(e.time).replace(' ', 'T') + 'Z').toISOString(), forecast: e.estimate ?? null, previous: e.prev ?? null, actual: e.actual ?? null }));
  },
  async ff(week) {
    const j = await jget(`https://nfs.faireconomy.media/ff_calendar_${week}.json`, { headers: { 'User-Agent': UA } }, 'forexfactory');
    if (!Array.isArray(j)) throw E('structure inattendue', 422, 'forexfactory');
    return j.map((e, i) => ({ id: 'ff' + week[0] + i, title: e.title, currency: e.country, impact: IMP(e.impact), time: new Date(e.date).toISOString(), forecast: e.forecast || null, previous: e.previous || null, actual: null }));
  }
};
async function getCalendar(keys, q) {
  const chain = [['finnhub', () => CAL.finnhub(keys, q)], ['forexfactory_thisweek', () => { if (fail(q, 'forexfactory')) throw E('panne simulée', 503); return CAL.ff('thisweek'); }], ['forexfactory_nextweek', () => CAL.ff('nextweek')]];
  const attempts = []; let n = 0;
  for (const [name, fn] of chain) {
    if (n++ >= 3) break;
    try { const events = await fn(); if (events.length) return { events, source: name, fetched_at: new Date().toISOString(), attempts }; attempts.push({ source: name, error: 'vide' }); }
    catch (e) { attempts.push({ source: name, error: e.message }); }
  }
  const err = E('calendrier indisponible', 502, 'calendar'); err.attempts = attempts; throw err;
}

// ---------- news ----------
const FEEDS = [
  ['Fed', 'https://www.federalreserve.gov/feeds/press_all.xml', true, 'USD'],
  ['BCE', 'https://www.ecb.europa.eu/rss/press.html', true, 'EUR'],
  ['BoE', 'https://www.bankofengland.co.uk/rss/news', true, 'GBP'],
  ['BoJ', 'https://www.boj.or.jp/en/rss/whatsnew.xml', true, 'JPY'],
  ['FXStreet', 'https://www.fxstreet.com/rss/news', false]
];
const KW = [[/\b(fed|dollar|powell|fomc)\b/i, 'USD'], [/\b(ecb|bce|lagarde|euro)\b/i, 'EUR'], [/\b(boe|bank of england|bailey|sterling|pound)\b/i, 'GBP'], [/\b(boj|ueda|yen)\b/i, 'JPY'], [/\b(snb|swiss franc)\b/i, 'CHF'], [/\b(rba|aussie)\b/i, 'AUD'], [/\b(boc|loonie)\b/i, 'CAD'], [/\b(rbnz|kiwi)\b/i, 'NZD'], [/\b(gold|xau)\b/i, 'XAU'], [/\b(oil|crude|opec|wti)\b/i, 'WTI']];
const tagCur = t => [...new Set(KW.filter(([r]) => r.test(t)).map(([, c]) => c))];
const norm = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const unesc = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').trim();
function parseRss(xml, source, official, cur) {
  const items = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) || [];
  return items.map(it => {
    const g = tag => { const m = it.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')); return m ? unesc(m[1]) : ''; };
    const link = g('link') || (it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || '';
    const d = new Date(g('pubDate') || g('published') || g('updated') || g('dc:date'));
    return { title: g('title'), url: link, source, published_at: isNaN(d) ? null : d.toISOString(), impact_hint: official ? 'banque centrale' : null, cur: cur || null };
  }).filter(x => x.title && x.published_at);
}
async function getNews(keys, q) {
  const tasks = FEEDS.map(([n, u, o, c]) => (async () => {
    if (fail(q, 'rss_' + n.toLowerCase())) throw E('panne simulée', 503);
    return parseRss(await tget(u, { headers: { 'User-Agent': UA, Accept: 'application/rss+xml,application/xml,text/xml' } }, n), n, o, c);
  })());
  if (keys.finnhub) tasks.push((async () => {
    const j = await jget('https://finnhub.io/api/v1/news?category=forex', { headers: { 'X-Finnhub-Token': keys.finnhub } }, 'finnhub');
    return j.map(x => ({ title: x.headline, url: x.url, source: 'Finnhub/' + (x.source || ''), published_at: new Date(x.datetime * 1000).toISOString(), impact_hint: null }));
  })());
  const names = [...FEEDS.map(f => f[0]), ...(keys.finnhub ? ['Finnhub'] : [])];
  if (q.av_news === '1' && keys.alphavantage) { names.push('AlphaVantage'); tasks.push((async () => {
    const j = await jget(`https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=economy_monetary,financial_markets&limit=50&apikey=${keys.alphavantage}`, {}, 'alphavantage');
    if (j.Note || j.Information || !j.feed) throw E('limite atteinte ou structure inattendue', 429);
    return j.feed.map(x => { const t = x.time_published; return { title: x.title, url: x.url, source: 'AlphaVantage/' + (x.source || ''), published_at: new Date(`${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(9, 11)}:${t.slice(11, 13)}:${t.slice(13, 15)}Z`).toISOString(), impact_hint: null }; });
  })()); }
  const res = await Promise.allSettled(tasks), sources_status = {}, all = [];
  res.forEach((r, i) => { if (r.status === 'fulfilled') { sources_status[names[i]] = { ok: true, count: r.value.length }; all.push(...r.value); } else sources_status[names[i]] = { ok: false, error: r.reason.message }; });
  const seenT = new Set(), seenU = new Set(), cutoff = Date.now() - 72 * 36e5;
  const news = all.filter(n => Date.parse(n.published_at) >= cutoff && /^https:\/\//.test(n.url || '') || (Date.parse(n.published_at) >= cutoff && !n.url))
    .sort((a, b) => b.published_at.localeCompare(a.published_at))
    .filter(n => { const k = norm(n.title); if (seenT.has(k) || (n.url && seenU.has(n.url))) return false; seenT.add(k); if (n.url) seenU.add(n.url); return true; })
    .slice(0, 60).map((n, i) => ({ id: 'n' + i + '_' + norm(n.title).slice(0, 12).replace(/ /g, ''), title: n.title, url: n.url, source: n.source, published_at: n.published_at, currencies: [...new Set([...tagCur(n.title), ...(n.cur ? [n.cur] : [])])], impact_hint: n.impact_hint }));
  return { news, sources_status, fetched_at: new Date().toISOString() };
}

// ---------- Gemini ----------
function parseJsonLoose(t) {
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch {} }
  return null;
}
async function gemini(model, key, system, prompt, extra = '') {
  const r = await hfetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system + extra }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 4096, ...(/^gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: 'low' } } : { temperature: 0.3, thinkingConfig: { thinkingBudget: 1024 } }) }
    })
  });
  const tx = await r.text(); let j; try { j = JSON.parse(tx); } catch { throw E(`réponse Gemini non-JSON (HTTP ${r.status})`, r.status, 'gemini'); }
  if (r.status === 400) throw E('clé Gemini invalide ou requête refusée : ' + (j.error?.message || ''), 400, 'gemini');
  if (r.status === 429) throw E('quota Gemini atteint, réessaie dans une minute', 429, 'gemini', true);
  if (r.status === 503) { await sleep(2000); throw E('Gemini surchargé (503)', 503, 'gemini'); }
  if (!r.ok) throw E(j.error?.message || 'HTTP ' + r.status, r.status, 'gemini');
  const c = j.candidates?.[0];
  if (!c) throw E('Gemini : aucune réponse' + (j.promptFeedback?.blockReason ? ' (bloqué : ' + j.promptFeedback.blockReason + ')' : ''), 422, 'gemini');
  const text = (c.content?.parts || []).map(p => p.text || '').join('');
  if (c.finishReason === 'MAX_TOKENS') throw Object.assign(E('réponse tronquée (MAX_TOKENS)', 422, 'gemini'), { code: 'MAX_TOKENS' });
  if (c.finishReason === 'SAFETY') throw Object.assign(E('réponse bloquée (SAFETY)', 422, 'gemini'), { code: 'SAFETY' });
  return text;
}
async function chat(body, keys) {
  const { system = '', prompt = '', model = 'gemini-3.8-flash', fallbackModels = ['gemini-3.7-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'], shortPrompt } = body;
  const ks = [keys.gemini, body.keys?.gemini2].filter(Boolean);
  if (!ks.length) throw E('clé Gemini absente (Réglages ou GEMINI_API_KEY)', 401, 'gemini');
  const tried = [];
  for (const k of ks) for (const m of [model, ...fallbackModels]) {
    let extra = '', p = prompt;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await gemini(m, k, system, p, extra);
        const parsed = parseJsonLoose(text);
        if (parsed) return { text, parsed, model: m, tried };
        extra = '\nIMPORTANT : réponds UNIQUEMENT par un objet JSON valide, sans texte autour.';
      } catch (e) {
        tried.push({ model: m, error: e.message });
        if (e.code === 'MAX_TOKENS') { extra = '\nSois beaucoup plus concis.'; continue; }
        if (e.code === 'SAFETY' && shortPrompt) { p = shortPrompt; continue; }
        if (e.status === 400 && /clé|API key/i.test(e.message)) throw e;
        break; // 429/503/autre → modèle suivant
      }
    }
  }
  const err = E('tous les modèles Gemini ont échoué (le front peut générer une analyse par règles)', 502, 'gemini'); err.tried = tried; throw err;
}

// ---------- handler ----------
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-gemini-key,x-twelvedata-key,x-alphavantage-key,x-finnhub-key');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  const q = req.query || {}, h = req.headers, body = (req.body && typeof req.body === 'object') ? req.body : {};
  const pick = (n, env) => h['x-' + n + '-key'] || body.keys?.[n] || process.env[env] || '';
  const keys = { gemini: pick('gemini', 'GEMINI_API_KEY'), twelvedata: pick('twelvedata', 'TWELVEDATA_API_KEY'), alphavantage: pick('alphavantage', 'ALPHAVANTAGE_API_KEY'), finnhub: pick('finnhub', 'FINNHUB_API_KEY') };
  try {
    switch (q.action) {
      case 'history': {
        if (!q.symbol) throw E('paramètre symbol manquant (ex. EUR/USD)', 400, 'history');
        return J(res, 200, await getDaily(q.symbol, keys, q), 's-maxage=3600');
      }
      case 'quotes': {
        const out = [];
        for (const s of String(q.symbols || '').split(',').filter(Boolean).slice(0, 3)) {
          try { out.push(await getQuote(s, keys, q)); } catch (e) { out.push({ symbol: s, error: e.message, attempts: e.attempts }); }
        }
        return J(res, 200, { quotes: out }, 's-maxage=60');
      }
      case 'rates': { // taux US (manuel prioritaire côté front) : FEDERAL_FUNDS_RATE + TREASURY_YIELD 2 ans
        if (!keys.alphavantage) throw E('clé Alpha Vantage requise', 401, 'alphavantage');
        const base = 'https://www.alphavantage.co/query?apikey=' + keys.alphavantage;
        const a = await jget(base + '&function=FEDERAL_FUNDS_RATE&interval=monthly', {}, 'alphavantage');
        const y = await jget(base + '&function=TREASURY_YIELD&interval=daily&maturity=2year', {}, 'alphavantage');
        if (a.Note || a.Information || y.Note || y.Information) throw E('limite Alpha Vantage atteinte', 429, 'alphavantage', true);
        const v = j => (j.data || []).filter(x => x.value && x.value !== '.'), A = v(a), Y = v(y);
        if (!A.length || !Y.length) throw E('structure inattendue', 422, 'alphavantage');
        return J(res, 200, { USD: { policy: num(A[0].value), policyPrev: A[1] ? num(A[1].value) : null, y2: num(Y[0].value), y2Prev: Y[20] ? num(Y[20].value) : null, date: Y[0].date }, source: 'alphavantage', fetched_at: new Date().toISOString() }, 's-maxage=3600');
      }
      case 'calendar': return J(res, 200, await getCalendar(keys, q), 's-maxage=300');
      case 'news': return J(res, 200, await getNews(keys, q), 's-maxage=600');
      case 'chat': {
        if (req.method !== 'POST') throw E('POST requis', 405, 'chat');
        return J(res, 200, await chat(body, keys));
      }
      case 'test': {
        const what = q.what || 'all', out = {};
        const run = async (n, fn) => { const t = Date.now(); try { out[n] = { ok: true, detail: await fn(), ms: Date.now() - t }; } catch (e) { out[n] = { ok: false, error: e.message + (e.tried?.length ? ' — ' + e.tried.map(x => x.model + ' : ' + x.error).join(' | ') : ''), ms: Date.now() - t }; } };
        if (what === 'all' || what === 'gemini') await run('gemini', async () => (await chat({ system: 'Réponds en JSON.', prompt: '{"ping":"ok"} : renvoie {"pong":true}', fallbackModels: [] }, keys)).model);
        if (what === 'all' || what === 'twelvedata') await run('twelvedata', async () => (await getQuote('EUR/USD', { twelvedata: keys.twelvedata }, q)).price);
        if (what === 'all' || what === 'alphavantage') await run('alphavantage', async () => (await getQuote('EUR/USD', { alphavantage: keys.alphavantage }, q)).price);
        if (what === 'all' || what === 'finnhub') await run('finnhub', async () => (await CAL.finnhub(keys, q)).length + ' événements');
        if (what === 'all' || what === 'frankfurter') await run('frankfurter', async () => (await H.frankfurter('EUR/USD', '', q)).length + ' bougies');
        if (what === 'all' || what === 'stooq') await run('stooq', async () => (await H.stooq('EUR/USD', '', q)).length + ' bougies');
        if (what === 'all' || what === 'forexfactory') await run('forexfactory', async () => (await CAL.ff('thisweek')).length + ' événements');
        return J(res, 200, { results: out });
      }
      default: throw E('action inconnue : chat, history, quotes, calendar, news, test', 400, 'relay');
    }
  } catch (e) {
    return J(res, e.status && e.status >= 400 && e.status < 600 ? e.status : 500, { error: e.message || 'erreur interne', source: e.source || 'relay', attempts: e.attempts, tried: e.tried });
  }
}
