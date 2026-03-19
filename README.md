# 🔗 Ollama Proxy

Proxy HTTP transparent qui intercepte toutes les requêtes Ollama et extrait les tokens automatiquement.

## ⚙️ Fonctionnement

```
Your App → Proxy (11435) → Real Ollama (11434)
             ↓
          Token Extraction
             ↓
        Monitor Backend
```

## 🚀 Démarrage

### Node.js

```bash
npm install
npm start
```

Écoute sur: `http://127.0.0.1:11435`

### Docker

```bash
docker build -t ollama-proxy .
docker run -p 11435:11435 \
  -e OLLAMA_HOST=127.0.0.1 \
  -e MONITOR_URL=http://localhost:3333 \
  ollama-proxy
```

## 📋 Variables d'Environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PROXY_PORT` | 11435 | Port d'écoute du proxy |
| `OLLAMA_HOST` | 127.0.0.1 | Host du vrai Ollama |
| `OLLAMA_PORT` | 11434 | Port du vrai Ollama |
| `MONITOR_URL` | http://localhost:3333 | URL du monitoring backend |
| `LOG_FILE` | ./data/proxy-log.json | Fichier log des requêtes |

## 🔌 Endpoints

- `GET /health` - Health check
- `GET /proxy-stats` - Statistiques du proxy

Tous les autres endpoints sont proxifiés vers Ollama.

## 📊 Caractéristiques

✅ **Transparent:** Fonctionne comme Ollama, pas de changement d'API
✅ **Automatic Token Tracking:** Capture les tokens de toutes les réponses
✅ **Stream Support:** Gère le streaming et non-streaming
✅ **Persistent Logging:** Enregistre toutes les requêtes
✅ **Lightweight:** Overhead minimal (<100ms)

## 🔧 Utilisation

### Configurer votre client

```bash
export OLLAMA_HOST="127.0.0.1:11435"
```

### Test simple

```bash
curl -X POST http://127.0.0.1:11435/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-oss",
    "prompt": "Hello",
    "stream": false
  }'
```

Vérifiez le dashboard: http://localhost:3333

## 📝 Notes Techniques

- Le proxy force `stream: false` pour les requêtes internes (capture plus facile)
- Les tokens sont extraits de chaque réponse JSON
- Les requêtes sont loggées dans `/data/proxy-log.json`
- Le proxy envoie les tokens au monitoring backend via POST `/api/record`

## 🐛 Troubleshooting

### Erreur "Ollama unreachable"
- Vérifiez que Ollama tourne: `curl http://127.0.0.1:11434/api/tags`
- Vérifiez `OLLAMA_HOST` et `OLLAMA_PORT`

### Tokens non enregistrés
- Vérifiez que `MONITOR_URL` est correct
- Vérifiez que le monitoring backend tourne

### Port déjà utilisé
```bash
lsof -i :11435
kill -9 <PID>
```

---

*Pour plus d'infos: Voir le README principal*
