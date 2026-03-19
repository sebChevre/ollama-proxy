const express = require('express');
const http = require('http');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const PROXY_PORT = process.env.PROXY_PORT || 11435;
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = process.env.OLLAMA_PORT || 11434;
const MONITOR_URL = process.env.MONITOR_URL || 'http://localhost:3333';
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, '../data/proxy-log.json');

if (!fs.existsSync(path.dirname(LOG_FILE))) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
}

app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', proxy_port: PROXY_PORT });
});

app.get('/proxy-stats', (req, res) => {
  try {
    const logs = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
    res.json({
      totalRequests: logs.length,
      recentRequests: logs.slice(-100),
      requestsByEndpoint: {}
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

app.all('*', async (req, res) => {
  const pathAndQuery = req.originalUrl;
  const model = req.body?.model || 'unknown';

  // Pass through the original request body (keep streaming if requested)
  let bodyData = req.method !== 'GET' ? req.body : null;
  const bodyStr = bodyData ? JSON.stringify(bodyData) : null;

  const options = {
    hostname: OLLAMA_HOST,
    port: OLLAMA_PORT,
    path: pathAndQuery,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${OLLAMA_HOST}:${OLLAMA_PORT}`
    }
  };

  if (bodyStr) {
    options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
    options.headers['Content-Type'] = 'application/json';
  }

  return new Promise((resolve) => {
    const proxyReq = http.request(options, (proxyRes) => {
      let tokenData = { prompt_eval_count: 0, eval_count: 0 };
      let buffer = '';

      // Copy response headers to client
      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      proxyRes.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        // Extract tokens from JSONL stream (each line is a JSON object)
        const lines = buffer.split('\n');
        buffer = lines[lines.length - 1]; // Keep incomplete line in buffer

        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].trim()) {
            try {
              const data = JSON.parse(lines[i]);
              if (data) {
                // Capture tokens from each chunk
                if (data.prompt_eval_count) tokenData.prompt_eval_count = data.prompt_eval_count;
                if (data.eval_count) tokenData.eval_count += data.eval_count;
              }
            } catch (e) {}
          }
        }

        // Stream the chunk to client in real-time
        res.write(chunk);
      });

      proxyRes.on('end', () => {
        // Process any remaining data in buffer
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer);
            if (data) {
              if (data.prompt_eval_count) tokenData.prompt_eval_count = data.prompt_eval_count;
              if (data.eval_count) tokenData.eval_count += data.eval_count;
            }
          } catch (e) {}
        }

        res.end();

        // Record tokens after stream completes
        if (tokenData.prompt_eval_count > 0 || tokenData.eval_count > 0) {
          recordTokens(model, tokenData.prompt_eval_count, tokenData.eval_count);
        }

        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      console.error('Proxy error:', err.message);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      resolve();
    });

    if (bodyStr) {
      proxyReq.write(bodyStr);
    }

    proxyReq.end();
  });
});

function recordTokens(model, inputTokens, outputTokens) {
  axios.post(
    `${MONITOR_URL}/api/record`,
    { model, inputTokens, outputTokens },
    { timeout: 5000 }
  ).then(() => {
    console.log(`✅ [${model}] ${inputTokens}+${outputTokens} tokens`);
  }).catch(() => {});
}

app.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(60));
  console.log('🔗 OLLAMA PROXY - TOKEN TRACKING');
  console.log('='.repeat(60));
  console.log(`✅ Proxy on:    http://0.0.0.0:${PROXY_PORT}`);
  console.log(`📡 Forwards to: http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
  console.log(`📊 Monitor:     ${MONITOR_URL}`);
  console.log('='.repeat(60) + '\n');
});

process.on('SIGINT', () => {
  process.exit(0);
});
