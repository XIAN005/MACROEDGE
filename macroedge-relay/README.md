# MacroEdge AI — déploiement

Structure attendue (important : `analyze.js` DOIT être dans `api/`) :

```
macroedge-relay/
├── index.html        ← l'application (servie à la racine)
├── api/analyze.js    ← relais serverless
├── package.json
└── vercel.json
```

## Déploiement Vercel
1. Envoie ce dossier sur GitHub puis **Add New → Project → Import**, ou lance `npx vercel` dans le dossier.
2. Ouvre l'URL `https://xxx.vercel.app` : l'app se charge et utilise automatiquement `/api/analyze` comme relais.
3. Onglet **Réglages** : choisis le fournisseur IA, colle ta clé, clique **Tester la connexion**.

Si tu ouvres `index.html` en local (file://), colle l'URL complète du relais dans Réglages.

## Modèles par défaut (champ Modèle vide)
- Anthropic : `claude-sonnet-5-5` · OpenAI : `gpt-4o` · Gemini : `gemini-2.5-flash`

## Données de marché
- **Prix** : Alpha Vantage (clé gratuite, 25 requêtes/jour, 5/min). Chaque actualisation = 3 requêtes ; un cache de 10 min évite de gaspiller le quota au rechargement. Le plan gratuit ne donne pas la variation journalière : l'app affiche l'heure de mise à jour.
- **Calendrier** : Finnhub si clé (plan compatible), sinon repli automatique sur ForexFactory (sans clé).
- Variables d'environnement optionnelles côté Vercel : `ALPHAVANTAGE_API_KEY`, `FINNHUB_API_KEY`.

## Tests
```bash
curl "https://TON-URL/api/analyze?action=calendar"
curl "https://TON-URL/api/analyze?action=quotes&apiKey=CLE_ALPHA&symbols=EUR/USD"
curl -X POST https://TON-URL/api/analyze -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","apiKey":"sk-ant-...","messages":[{"role":"user","content":"OK ?"}]}'
```

## Sécurité
Le relais ne stocke rien. Il est public (CORS `*`) : pour le verrouiller, remplace `*` par ton domaine dans `api/analyze.js`. Si tu définis `ALPHAVANTAGE_API_KEY`, n'importe qui connaissant l'URL peut consommer ton quota.
