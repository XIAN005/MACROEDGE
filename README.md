# MacroEdge AI — Relais API multi-fournisseur (déploiement)

Ce dossier contient UNE seule fonction serverless (`api/analyze.js`) qui relaie
les appels vers **Anthropic (Claude), OpenAI (GPT) ou Google (Gemini)** — au
choix, sélectionné dans l'onglet Réglages de l'application — sans jamais
stocker ni logguer ta clé API.

Formats de clé attendus :
- Anthropic : commence par `sk-ant-`
- OpenAI : commence par `sk-`
- Gemini : clé Google AI Studio (format `AIza...`)

Modèles par défaut si le champ "Modèle" est laissé vide :
- Anthropic : `claude-sonnet-4-5-20250929`
- OpenAI : `gpt-4o`
- Gemini : `gemini-2.0-flash`

Tu peux changer de fournisseur à tout moment dans Réglages sans redéployer
le relais — un seul relais gère les trois.

## Déploiement sur Vercel (gratuit, ~5 minutes)

### Option A — via l'interface web (le plus simple, sans terminal)

1. Va sur https://vercel.com et crée un compte gratuit (avec GitHub, Google, ou email).
2. Clique **Add New → Project**.
3. Choisis **"Deploy without Git"** / glisse-dépose ce dossier `macroedge-relay`
   (Vercel accepte l'upload direct d'un dossier zip sur certains plans ;
   si cette option n'apparaît pas, utilise l'Option B ci-dessous).
4. Laisse les réglages par défaut, clique **Deploy**.
5. Une fois déployé, Vercel te donne une URL du type :
   `https://macroedge-relay-xxxx.vercel.app`
6. Ton endpoint de relais est : `https://macroedge-relay-xxxx.vercel.app/api/analyze`
7. Colle cette URL dans les Réglages de l'application MacroEdge (fichier HTML).

### Option B — via GitHub (recommandé si tu es à l'aise)

1. Crée un nouveau repo GitHub (public ou privé), pousse ce dossier dedans :
   ```
   cd macroedge-relay
   git init
   git add .
   git commit -m "MacroEdge relay"
   git branch -M main
   git remote add origin https://github.com/TON-COMPTE/macroedge-relay.git
   git push -u origin main
   ```
2. Sur vercel.com : **Add New → Project → Import Git Repository**, choisis ce repo.
3. Laisse les réglages par défaut, clique **Deploy**.
4. Récupère l'URL fournie (`https://....vercel.app`), ton endpoint est
   `.../api/analyze`.

### Option C — via la CLI Vercel (si tu as Node.js installé)

```bash
npm install -g vercel
cd macroedge-relay
vercel
```
Suis les instructions ; à la fin, l'URL de production est affichée.

## Sécurité

- Ta clé API Anthropic est envoyée **depuis ton navigateur vers TON propre
  serveur relais**, jamais vers un tiers.
- Le relais ne stocke rien : il transmet la requête à Anthropic et renvoie
  la réponse. Aucun log de la clé n'est écrit dans le code.
- Le relais est public (n'importe qui connaissant son URL peut l'appeler) —
  mais sans TA clé API dans le corps de la requête, il refuse (erreur 400).
  Donc le risque réel est limité, mais si tu veux fermer complètement l'accès
  à d'autres personnes, restreins `Access-Control-Allow-Origin` dans
  `api/analyze.js` à ton propre nom de domaine plutôt que `*`.
- Ne partage jamais l'URL de ton relais + ta clé API ensemble publiquement.

## Données de marché live (Dashboard)

Le même relais gère aussi deux nouvelles actions, en plus du chat IA :

### Prix en direct — Twelve Data (gratuit, clé requise)

1. Crée un compte gratuit sur https://twelvedata.com (aucune carte bancaire requise).
2. Récupère ta clé API dans le tableau de bord.
3. Dans l'app, onglet **Réglages → Données de marché live**, colle :
   - l'URL de ton relais (la même que pour l'IA)
   - ta clé Twelve Data
4. Plan gratuit : 800 requêtes/jour, largement suffisant pour un usage normal
   (chaque clic sur "Actualiser" consomme quelques requêtes selon le nombre
   de symboles suivis).

Limite connue : le plan gratuit de Twelve Data ne couvre pas toujours les
indices composites comme le DXY ou les rendements obligataires (US10Y/US2Y)
— ces symboles nécessitent un plan payant chez la plupart des fournisseurs.
Les paires forex (EUR/USD, USD/JPY), l'or (XAU/USD) et le pétrole (WTI/USD)
fonctionnent en revanche sur le plan gratuit.

### Calendrier économique — Finnhub (optionnel) ou ForexFactory (gratuit, automatique)

- Si tu renseignes une clé Finnhub dans Réglages, le relais l'utilise en
  priorité (nécessite un plan Finnhub qui débloque l'endpoint calendrier
  économique — le plan gratuit de base ne l'inclut pas toujours).
- Si aucune clé n'est renseignée, ou si l'appel Finnhub échoue, le relais
  bascule **automatiquement et gratuitement** sur le flux JSON public de
  ForexFactory (aucune clé nécessaire, mise à jour hebdomadaire).

Tu peux donc utiliser le calendrier tout de suite, sans aucune clé
supplémentaire, grâce au repli automatique.

## Test rapide après déploiement

```bash
curl -X POST https://TON-URL.vercel.app/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "anthropic",
    "apiKey": "sk-ant-VOTRE_CLE",
    "messages": [{"role":"user","content":"Dis juste OK si tu me reçois."}]
  }'
```
Remplace `"provider"` par `"openai"` ou `"gemini"` selon le fournisseur testé
(et la clé correspondante). Tu dois recevoir `{"text":"OK", "usage": {...}}`.

Test des prix en direct :
```bash
curl "https://TON-URL.vercel.app/api/analyze?action=quotes&apiKey=TA_CLE_TWELVEDATA&symbols=EUR/USD,XAU/USD"
```

Test du calendrier (sans clé, fallback ForexFactory) :
```bash
curl "https://TON-URL.vercel.app/api/analyze?action=calendar"
```
