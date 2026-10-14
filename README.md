# MacroEdge Desk

Tableau de bord macro Forex / Or : scoring déterministe + analyse rédigée par Gemini. Sans build.

## Structure exacte des dossiers
```
macroedge-desk/
├── index.html          # front (HTML + CSS + JS vanilla)
├── package.json        # "type":"module", "engines":{"node":"22.x"}
├── vercel.json         # maxDuration 30 pour api/analyze.js
└── api/
    └── analyze.js      # relais serverless (une route, ?action=)
```
(`index.part1-4.html` ne sont que les morceaux de livraison : ne les déploie pas.)

## Déploiement
1. Crée un dépôt GitHub, pousse les 4 fichiers ci-dessus.
2. vercel.com → *Add New Project* → importe le dépôt → *Deploy* (aucun réglage de build).
3. Ouvre `https://TON-PROJET.vercel.app` : l'URL du relais est préremplie. Sur GitHub Pages, colle `https://TON-PROJET.vercel.app` dans Réglages → Relais (`/api/analyze` est ajouté automatiquement).
4. Facultatif : variables d'environnement Vercel `GEMINI_API_KEY`, `TWELVEDATA_API_KEY`, `ALPHAVANTAGE_API_KEY`, `FINNHUB_API_KEY` (utilisées si le client n'envoie pas de clé).

## Clés gratuites
- Gemini : https://aistudio.google.com/apikey
- Twelve Data : https://twelvedata.com (800 req/jour, 8/min)
- Alpha Vantage : https://www.alphavantage.co/support/#api-key (25 req/jour, 5/min)
- Finnhub : https://finnhub.io (le calendrier économique peut exiger un plan payant : ForexFactory prend alors le relais)
Saisis-les dans Réglages (stockées dans le navigateur, champs password).

## Tests curl (remplace `$R` par ton URL de relais)
```bash
R=https://TON-PROJET.vercel.app/api/analyze
curl "$R?action=test&what=frankfurter"
curl "$R?action=test&what=stooq"
curl "$R?action=test&what=forexfactory"
curl -H "x-twelvedata-key: CLE" "$R?action=test&what=twelvedata"
curl -H "x-alphavantage-key: CLE" "$R?action=test&what=alphavantage"
curl -H "x-finnhub-key: CLE" "$R?action=test&what=finnhub"
curl -H "x-gemini-key: CLE" "$R?action=test&what=gemini"
curl "$R?action=history&symbol=EUR/USD&order=frankfurter,stooq"
curl -H "x-twelvedata-key: CLE" "$R?action=quotes&symbols=EUR/USD"
curl "$R?action=calendar"
curl "$R?action=news"
curl -H "x-alphavantage-key: CLE" "$R?action=rates"
curl -X POST -H "Content-Type: application/json" -H "x-gemini-key: CLE" \
  -d '{"system":"JSON seulement","prompt":"{\"ping\":1} -> {\"pong\":true}"}' "$R?action=chat"
# simuler une panne :
curl "$R?action=history&symbol=EUR/USD&debug_fail=twelvedata,alphavantage"
```
Console du navigateur : `runSelfTests()` (indicateurs et moteur de score).

> Aide à l'analyse, pas un conseil en investissement. Les scores sont un modèle heuristique.
