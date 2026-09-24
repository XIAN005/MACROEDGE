// api/analyze.js
// Relais serverless (Vercel) — 3 fonctions dans un seul fichier :
//   - action "chat"     : appel IA multi-provider (Anthropic / OpenAI / Gemini)
//   - action "quotes"   : prix de marché live via Finnhub (Forex & Or)
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
   ACTION: quotes  →  Alpha Vantage (CURRENCY_EXCHANGE_RATE)
   GET /api/analyze?action=quotes&apiKey=...&symbols=USD/JPY,EUR/USD,XAU/USD
   Note : le plan gratuit Alpha Vantage est limité à 25 requêtes/jour et
   5/minute. Chaque symbole demandé consomme 1 requête.
   ========================================================= */
async function handleQuotes(req, res) {
  const apiKey  = (req.method === 'GET' ? req.query.apiKey : req.body?.apiKey) || process.env.ALPHAVANTAGE_API_KEY;
  const symbols = req.method === 'GET' ? req.query.symbols : req.body?.symbols;

  if (!apiKey) {
    return res.status(400).json({ error: 'Clé Alpha Vantage manquante (paramètre apiKey ou variable d\'environnement ALPHAVANTAGE_API_KEY).' });
  }

  // Tickers de fallback si non spécifiés
  const rawSymbols = symbols || 'USD/JPY,EUR/USD,XAU/USD';
  const symbolList = String(rawSymbols).split(',').map(s => s.trim()).filter(Boolean);

  try {
    const results = [];
    // Séquentiel plutôt que Promise.all : Alpha Vantage free tier limite à 5 req/min,
    // des appels en parallèle risquent de déclencher la limite de fréquence.
    for (const displaySymbol of symbolList) {
      const [fromCcy, toCcy] = displaySymbol.replace('/', '').match(/.{1,3}/g) || [];
      if (!fromCcy || !toCcy) {
        results.push({ symbol: displaySymbol, ok: false, error: 'Format de symbole invalide (attendu ex: EUR/USD).' });
        continue;
      }

      const url = `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${encodeURIComponent(fromCcy)}&to_currency=${encodeURIComponent(toCcy)}&apikey=${apiKey}`;
      const r = await fetch(url);

      if (!r.ok) {
        results.push({ symbol: displaySymbol, ok: false, error: `Erreur HTTP ${r.status}` });
        continue;
      }

      const data = await r.json();

      if (data.Note || data.Information) {
        results.push({ symbol: displaySymbol, ok: false, error: "Limite d'appels Alpha Vantage atteinte (25/jour ou 5/min max)." });
        continue;
      }

      const rate = data?.['Realtime Currency Exchange Rate'];
      const price = rate?.['5. Exchange Rate'] ? parseFloat(rate['5. Exchange Rate']) : null;

      if (price) {
        results.push({
          symbol: displaySymbol,
          ok: true,
          price,
          // Alpha Vantage CURRENCY_EXCHANGE_RATE ne fournit pas de variation
          // journalière : on renvoie 0 plutôt que d'inventer un chiffre.
          change: 0,
          percent_change: 0,
          change_percent: 0,
          previous_close: null,
          datetime: rate?.['6. Last Refreshed'] || new Date().toISOString()
        });
      } else {
        results.push({ symbol: displaySymbol, ok: false, error: 'Symbole non trouvé ou réponse inattendue.' });
      }
    }

    return res.status(200).json({ quotes: results, fetched_at: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: 'Erreur lors de la récupération des prix Alpha Vantage : ' + err.message });
  }
}

/* =========================================================
   ACTION: calendar  →  Finnhub (si clé) sinon ForexFactory
   ========================================================= */
async function handleCalendar(req, res) {
  const apiKey = (req.method === 'GET' ? req.query.apiKey : req.body?.apiKey) || process.env.FINNHUB_API_KEY;

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
