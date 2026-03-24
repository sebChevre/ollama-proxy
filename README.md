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

**Build simple:**
```bash
docker build -t sebchevre/ollama-proxy:1.2.0 .
docker run -p 11435:11435 \
  -e PROXY_PORT=11435 \
  -e OLLAMA_HOST=host.docker.internal \
  -e OLLAMA_PORT=11434 \
  -e MONITOR_URL=http://ollama-monitoring:3333 \
  -e LOG_FILE=/data/proxy-log.json \
  sebchevre/ollama-proxy:1.2.0
```

**Build multiplateforme et push sur Docker Hub:**
```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t sebchevre/ollama-proxy:1.2.0 \
  -t sebchevre/ollama-proxy:latest \
  --push .
```

**Configuration requise pour buildx:**
```bash
# Créer un builder multiplateforme (une seule fois)
docker buildx create --name mybuilder --use
docker buildx ls
```

## 📋 Variables d'Environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PROXY_PORT` | 11435 | Port d'écoute du proxy |
| `OLLAMA_HOST` | 127.0.0.1 | Host du vrai Ollama |
| `OLLAMA_PORT` | 11434 | Port du vrai Ollama |
| `MONITOR_URL` | http://localhost:3333 | URL du monitoring backend |
| `LOG_FILE` | ./data/proxy-log.json | Fichier log des requêtes |

## 🚀 Déploiement avec Docker Compose

Voir le fichier `docker-compose.yml` dans le projet `openwebui-monitoring` pour un exemple complet avec tous les services:

```bash
cd /Users/seb/OLLAMA/openwebui-monitoring
docker compose -f docker-compose.yml up -d
```

## 🛠️ Commandes Utiles

### Build et Push

```bash
# Build simple (local)
docker build -t sebchevre/ollama-proxy:1.2.0 .

# Build multiplateforme et push
docker buildx build --platform linux/amd64,linux/arm64 \
  -t sebchevre/ollama-proxy:1.2.0 \
  -t sebchevre/ollama-proxy:latest \
  --push .

# Tagger une version
docker tag sebchevre/ollama-proxy:1.2.0 sebchevre/ollama-proxy:latest
docker push sebchevre/ollama-proxy:latest
```

### Test Local

```bash
# Build et lancer
docker build -t sebchevre/ollama-proxy:test .
docker run -p 11435:11435 \
  -e PROXY_PORT=11435 \
  -e OLLAMA_HOST=localhost \
  -e OLLAMA_PORT=11434 \
  sebchevre/ollama-proxy:test

# Test du proxy
curl http://localhost:11435/health

# Logs
docker logs -f <container-id>

# Vérifier les requêtes
curl -X POST http://localhost:11435/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3:latest","messages":[{"role":"user","content":"hello"}]}'
```

## 📚 Ressources

- [Documentation Node.js](https://nodejs.org/)
- [Documentation Docker](https://docs.docker.com/)
- [Documentation Express](https://expressjs.com/)

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
