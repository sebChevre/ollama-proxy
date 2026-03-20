FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY index.js .

ENV PROXY_PORT=11435
ENV OLLAMA_HOST=127.0.0.1
ENV OLLAMA_PORT=11434
ENV MONITOR_URL=http://localhost:3333

EXPOSE 11435

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:11435/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "index.js"]
