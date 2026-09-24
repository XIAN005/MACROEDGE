// api/analyze.js
// Relais serverless (Vercel) — 3 fonctions dans un seul fichier :
//   - action "chat"     : appel IA multi-provider (Anthropic / OpenAI / Gemini)
//   - action "quotes"   : prix de marché live via Alpha Vantage (clé gratuite)
//   - action "calendar" : calendrier économique — Finnhub si clé fournie, sinon repli
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

    return res.status(400).json({ error: 'Action invalide. Attendu : chat, quotes ou calendar.' });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur serveur relais : ' + (err?.message || String(err)) });
  }
}

/* =========================================================
   ACTION: chat  →  Anthropic / OpenAI / Gemini
   ========================================================= */
async function handleChat(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'La fonction chat nécessite la méthode POST.' });
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
      model: model || 'claude-3-5-sonnet-20241022',
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
   ACTION: quotes  →  Alpha Vantage
   GET /api/analyze?action=quotes&apiKey=...&symbols=EUR/USD,XAU/USD
   ========================================================= */
async function handleQuotes(req, res) {
  const apiKey  = req.method === 'GET' ? req.query.apiKey  : req.body?.apiKey;
  const symbols = req.method === 'GET' ? req.query.symbols : req.body?.symbols;

  if (!apiKey) {
    return res.status(400).json({ error: 'Clé Alpha Vantage manquante (paramètre apiKey).' });
  }
  if (!symbols) {
    return res.status(400).json({ error: 'Paramètre "symbols" manquant (ex: EUR/USD,XAU/USD).' });
  }

  const symbolList = String(symbols).split(',').map(s => s.trim()).filter(Boolean);

  try {
    const results = await Promise.all(symbolList.map(async (sym) => {
      let url = '';
      if (sym.includes('/')) {
        const [from, to] = sym.split('/');
        url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${encodeURIComponent(from)}&to_currency=${encodeURIComponent(to)}&apikey=${apiKey}`;
      } else {
        url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${apiKey}`;
      }

      const r = await fetch(url);
      const data = await r.json();
      return normalizeAlphaVantageQuote(sym, data);
    }));

    return res.status(200).json({ quotes: results, fetched_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur lors de la récupération des prix Alpha Vantage : ' + err.message });
  }
}

function normalizeAlphaVantageQuote(symbol, data) {
  // Traitement pour les devises & forex (CURRENCY_EXCHANGE_RATE)
  if (data['Realtime Currency Exchange Rate']) {
    const rate = data['Realtime Currency Exchange Rate'];
    const price = parseFloat(rate['5. Exchange Rate']);
    return {
      symbol,
      ok: true,
      price: price,
      change: 0,
      percent_change: 0,
      previous_close: null,
      datetime: rate['6. Last Refreshed'] || null,
    };
  }

  // Traitement pour les autres actifs (GLOBAL_QUOTE)
  if (data['Global Quote'] && data['Global Quote']['05. price']) {
    const quote = data['Global Quote'];
    const price = parseFloat(quote['05. price']);
    const change = parseFloat(quote['09. change'] || 0);
    const percentStr = quote['10. change percent'] || '0%';
    const percent = parseFloat(percentStr.replace('%', ''));

    return {
      symbol,
      ok: true,
      price: price,
      change: change,
      percent_change: percent,
      previous_close: parseFloat(quote['08. previous close'] || 0) || null,
      datetime: quote['07. latest trading day'] || null,
    };
  }

  return { 
    symbol, 
    ok: false, 
    error: data['Note'] || data['Information'] || 'Symbole indisponible ou limite de requêtes atteinte.' 
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
      // Repli automatique en cas d'erreur de la clé Finnhub
    }
  }

  try {
    // Ajout d'un User-Agent pour éviter le blocage HTTP 403 / Cloudflare par ForexFactory
    const r = await fetch('https://nfs.faireconomy.media/ff_calendar_thisweek.json', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (!r.ok) throw new Error(`Réponse statut ${r.status}`);

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
    return res.status(502).json({ error: 'Impossible de récupérer le calendrier économique : ' + e.message });
  }
}

function mapFinnhubImpact(n) {
  if (n === 3 || n === 'high') return 'high';
  if (n === 2 || n === 'medium') return 'medium';
  return 'low';
}
