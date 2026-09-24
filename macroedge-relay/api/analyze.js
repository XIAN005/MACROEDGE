// api/analyze.js
// Relais serverless (Vercel) — 3 fonctions dans un seul fichier :
//  - action "chat"     : appel IA multi-provider (Anthropic / OpenAI / Gemini)
//  - action "quotes"   : prix de marché live via Twelve Data (clé gratuite, 800 req/jour)
//  - action "calendar" : calendrier économique — Finnhub si clé fournie, sinon repli
//                         automatique et gratuit sur le flux JSON public ForexFactory

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = (req.method === 'GET' ? req.query.action : req.body?.action) || 'chat';

    if (action === 'chat')     return await handleChat(req, res);
    if (action === 'quotes')   return await handleQuotes(req, res);
    if (action === 'calendar') return await handleCalendar(req, res);

    return res.status(400).json({ error: 'action invalide. Attendu : chat, quotes ou calendar.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur relais : ' + (err?.message || String(err)) });
  }
}

/* =========================================================
   ACTION: chat  →  Anthropic / OpenAI / Gemini
   ========================================================= */
async function handleChat(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'chat nécessite POST.' });
  }
  const { provider, apiKey, system, messages, model } = req.body || {};

  if (!provider || !['anthropic', 'openai', 'gemini'].includes(provider)) {
    return res.status(400).json({ error: 'Paramètre "provider" invalide. Attendu : anthropic, openai ou gemini.' });
  }
  if (!apiKey || typeof apiKey !== 'string') {
    return res.status(400).json({ error: 'Clé API manquante.' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Paramètre "messages" manquant ou vide.' });
  }

  if (provider === 'anthropic') return await callAnthropic({ apiKey, system, messages, model, res });
  if (provider === 'openai')    return await callOpenAI({ apiKey, system, messages, model, res });
  if (provider === 'gemini')    return await callGemini({ apiKey, system, messages, model, res });
}

async function callAnthropic({ apiKey, system, messages, model, res }) {
  if (!apiKey.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Clé Anthropic invalide (doit commencer par sk-ant-).' });
  }
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || 'claude-sonnet-4-5-20250929',
      max_tokens: 1200,
      system: system || undefined,
      messages,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({ error: data?.error?.message || 'Erreur Anthropic.', type: data?.error?.type });
  }
  const textBlock = (data.content || []).find(b => b.type === 'text');
  return res.status(200).json({ text: textBlock ? textBlock.text : '', usage: data.usage || null });
}

async function callOpenAI({ apiKey, system, messages, model, res }) {
  const oaMessages = [];
  if (system) oaMessages.push({ role: 'system', content: system });
  for (const m of messages) oaMessages.push({ role: m.role, content: m.content });

  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: model || 'gpt-4o',
      max_tokens: 1200,
      messages: oaMessages,
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({ error: data?.error?.message || 'Erreur OpenAI.', type: data?.error?.type });
  }
  const text = data?.choices?.[0]?.message?.content || '';
  return res.status(200).json({ text, usage: data.usage || null });
}

async function callGemini({ apiKey, system, messages, model, res }) {
  const mdl = model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`;
  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
  const body = { contents };
  if (system) body.system_instruction = { parts: [{ text: system }] };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) {
    return res.status(r.status).json({ error: data?.error?.message || 'Erreur Gemini.', type: data?.error?.status });
  }
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  return res.status(200).json({ text, usage: data.usageMetadata || null });
}

/* =========================================================
   ACTION: quotes  →  Twelve Data (clé gratuite, 800 req/jour)
   ========================================================= */
async function handleQuotes(req, res) {
  const apiKey  = req.method === 'GET' ? req.query.apiKey  : req.body?.apiKey;
  const symbols = req.method === 'GET' ? req.query.symbols : req.body?.symbols;

  if (!apiKey) {
    return res.status(400).json({ error: 'Clé Twelve Data manquante (paramètre apiKey).' });
  }
  if (!symbols) {
    return res.status(400).json({ error: 'Paramètre "symbols" manquant (ex: EUR/USD,XAU/USD,WTI/USD).' });
  }

  const symbolList = String(symbols).split(',').map(s => s.trim()).filter(Boolean);
  const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbolList.join(','))}&apikey=${apiKey}`;

  try {
    const r = await fetch(url);
    const data = await r.json();

    // Même en cas d'erreur globale d'API, on ne bloque pas si c'est une clé invalide
    if (data?.code === 401 || data?.code === 429) {
      return res.status(400).json({ error: data?.message || 'Clé Twelve Data invalide ou quota dépassé.' });
    }

    let normalized = [];
    if (symbolList.length === 1) {
      normalized = [normalizeQuote(symbolList[0], data)];
    } else {
      normalized = symbolList.map(sym => normalizeQuote(sym, data[sym] || {}));
    }

    return res.status(200).json({ quotes: normalized, fetched_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur lors de la récupération des prix Twelve Data.' });
  }
}

function normalizeQuote(symbol, q) {
  // Gestion tolérante : si le symbole échoue ou nécessite un plan payant (ex: DXY), on renvoie ok: false
  if (!q || q.status === 'error' || !q.close) {
    return { 
      symbol, 
      ok: false, 
      error: q?.message || 'Symbole indisponible sur ce plan Twelve Data.' 
    };
  }
  const close = parseFloat(q.close);
  const prevClose = parseFloat(q.previous_close);
  const change = q.change != null ? parseFloat(q.change) : (close - prevClose);
  const percent = q.percent_change != null ? parseFloat(q.percent_change) : (prevClose ? (change / prevClose) * 100 : 0);
  return {
    symbol,
    ok: true,
    price: close,
    change,
    percent_change: percent,
    previous_close: prevClose || null,
    datetime: q.datetime || null,
  };
}

/* =========================================================
   ACTION: calendar  →  Finnhub (si clé) sinon ForexFactory
   ========================================================= */
async function handleCalendar(req, res) {
  const apiKey = req.method === 'GET' ? req.query.apiKey : req.body?.apiKey;

  if (apiKey) {
    try {
      const from = new Date().toISOString().slice(0, 10);
      const toDate = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
      const url = `https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${toDate}&token=${apiKey}`;
      const r = await fetch(url);
      const data = await r.json();

      if (r.ok && Array.isArray(data?.economicCalendar)) {
        const events = data.economicCalendar.map(e => ({
          datetime: e.time || null,
          country: e.country || '',
          event: e.event || '',
          impact: mapFinnhubImpact(e.impact),
          actual: e.actual ?? null,
          forecast: e.estimate ?? null,
          previous: e.prev ?? null,
        }));
        return res.status(200).json({ source: 'finnhub', events, fetched_at: new Date().toISOString() });
      }
    } catch (e) {
      // fallback ci-dessous
    }
  }

  try {
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json');
    const data = await r.json();
    const events = (Array.isArray(data) ? data : []).map(e => ({
      datetime: e.date || null,
      country: e.country || '',
      event: e.title || '',
      impact: (e.impact || '').toLowerCase(),
      actual: e.actual || null,
      forecast: e.forecast || null,
      previous: e.previous || null,
    }));
    return res.status(200).json({ source: 'forexfactory_fallback', events, fetched_at: new Date().toISOString() });
  } catch (e) {
    return res.status(502).json({ error: 'Impossible de récupérer le calendrier.' });
  }
}

function mapFinnhubImpact(n) {
  if (n === 3 || n === 'high') return 'high';
  if (n === 2 || n === 'medium') return 'medium';
  return 'low';
}
