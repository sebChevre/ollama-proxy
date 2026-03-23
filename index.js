const express = require('express');
const http = require('http');
const https = require('https');
const axios = require('axios');
const url = require('url');

const app = express();
const PROXY_PORT = process.env.PROXY_PORT || 11435;
const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = process.env.OLLAMA_PORT || 11434;
const MONITOR_URL = process.env.MONITOR_URL || 'http://localhost:3333';

app.use(express.json({ limit: '50mb' }));

// ⏱️ Augmenter les timeouts globaux pour les requêtes longues
app.use((req, res, next) => {
  req.setTimeout(310000); // 5 min + buffer
  res.setTimeout(310000);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', proxy_port: PROXY_PORT });
});

// 🔍 Détect le format de la requête (OLLAMA ou OpenAI)
function detectFormat(body, originalUrl, headers) {
  // ⚡ OpenAI indicators - CHECK FIRST (higher priority)
  if (headers['x-api-key'] || headers['x-forward-to']) return 'openai'; // Explicit OpenAI headers
  if (originalUrl.includes('/chat/completions') || originalUrl.includes('/v1/')) return 'openai';
  if (originalUrl.match(/^\/models(\/|$)/)) return 'openai'; // /models or /models/:id
  
  // OLLAMA indicators
  if (originalUrl.startsWith('/api/')) return 'ollama'; // /api/tags, /api/ps, /api/chat, etc.
  if (body?.model && body?.prompt) return 'ollama'; // /api/generate
  if (body?.model && body?.messages && !body?.prompt) return 'ollama'; // /api/chat (without prompt)
  
  // Fallback: messages array alone suggests OpenAI format
  if (body?.messages && Array.isArray(body.messages)) return 'openai'; // /v1/chat/completions
  
  return 'unknown';
}

// 📞 Fonction pour forwarder et parser les réponses OpenAI
async function handleOpenAI(req, res, originalUrl, bodyData, client = 'unknown') {
  const startTime = Date.now();
  
  // Extraire l'URL d'origin depuis les headers ou le body
  const forwardUrl = req.headers['x-forward-to'] || bodyData?.baseUrl || 'https://api.infomaniak.com/2/ai/101165/openai/v1';
  const apiKey = req.headers['x-api-key'] || bodyData?.apiKey;
  
  // Normaliser l'URL: éviter /v1/v1 double
  let path = originalUrl;
  if (forwardUrl.endsWith('/v1') && originalUrl.startsWith('/v1')) {
    path = originalUrl.substring(3); // Remove /v1 from originalUrl
  }
  
  const targetUrl = forwardUrl + path;
  
  const model = bodyData?.model || 'unknown';
  const inputContent = bodyData?.messages?.[0]?.content || JSON.stringify(bodyData).substring(0, 500) || null;
  
  console.log(req.headers)

  //console.log(`📨 OpenAI Request: ${model} → ${targetUrl.replace(apiKey || '', '***')}`);
  //console.log(`📨 Input (${inputContent ? inputContent.length : 0} chars): ${inputContent ? inputContent.substring(0, 80) : 'null'}${inputContent && inputContent.length > 80 ? '...' : ''}`);
  //console.log(`bodyData:`, JSON.stringify(bodyData));
  
  try {
    // 🔧 Filtrer les headers - on ne copie que ce qui est utile pour Infomaniak
    const forwardHeaders = {
      'Content-Type': 'application/json',
      'Authorization': apiKey ? `Bearer ${apiKey}` : req.headers['authorization'],
      'User-Agent': 'ollama-proxy/1.0'
    };
    
    // Ajouter optionnellement les headers personnalisés si présents
    if (req.headers['x-custom-header']) {
      forwardHeaders['x-custom-header'] = req.headers['x-custom-header'];
    }
    
    console.log(`📤 Forward headers:`, forwardHeaders);
    console.log(`⏱️  Sending request to Infomaniak...`);
    
    try {
      const axiosConfig = {
        headers: forwardHeaders,
        timeout: 300000, // 5 minutes pour OpenAI (Infomaniak peut être lent)
        validateStatus: () => true,
        responseType: 'stream', // 🔄 Important: recevoir en streaming
        httpsAgent: new https.Agent({ 
          rejectUnauthorized: false,
          keepAlive: true,
          timeout: 300000
        }) // ⚠️ Allow self-signed / mismatch certs (dev only)
      };
      
      let response;
      if (req.method === 'GET') {
        console.log(`📮 GET to Infomaniak (no body)`);
        response = await axios.get(targetUrl, axiosConfig);
      } else {
        const bodyToSend = bodyData || {};
        console.log(`📮 ${req.method} to Infomaniak: stream=${bodyToSend.stream}, model=${bodyToSend.model}`);
        response = await axios.post(targetUrl, bodyToSend, axiosConfig);
      }
      
      console.log(`✅ Infomaniak responded (${response.status}) after ${Date.now() - startTime}ms`);
      
      // � Nettoyer les headers avant de les forwarder
      const responseHeaders = {};
      const headersToKeep = ['content-type', 'cache-control', 'etag', 'x-ratelimit-', 'openai-', 'transfer-encoding'];
      
      for (const [key, value] of Object.entries(response.headers)) {
        if (headersToKeep.some(h => key.toLowerCase().includes(h))) {
          responseHeaders[key] = value;
        }
      }
      
      console.log(`📤 Response headers cleaned for forwarding...`);
      
      // �📊 Forwarder les headers au client IMMÉDIATEMENT
      res.writeHead(response.status, {
        ...responseHeaders,
        'Content-Type': response.headers['content-type'] || 'application/json'
      });
      
      console.log(`📤 Headers sent to OpenClaw, streaming response...`);
      
      // 📊 Forwarder le stream au fur et à mesure + parser pour tokens
      let buffer = '';
      let allData = '';
      const tokens = { input: 0, output: 0 };
      let outputContent = '';  // 📝 Capturer le contenu de sortie
      
      response.data.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        allData += chunkStr;
        buffer += chunkStr;
        
        // Forwarder immédiatement au client
        res.write(chunk);
        
        // Parser les events SSE pour extraire les tokens et contenu
        const lines = buffer.split('\n');
        buffer = lines[lines.length - 1]; // Garder la dernière ligne incomplète
        
        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].startsWith('data: ')) {
            const eventStr = lines[i].substring(6).trim();
            if (eventStr !== '[DONE]' && eventStr) {
              try {
                const event = JSON.parse(eventStr);
                // Extraire tokens
                if (event.usage) {
                  tokens.input = event.usage.prompt_tokens || 0;
                  tokens.output = event.usage.completion_tokens || 0;
                }
                // 📝 Extraire le contenu de sortie progressif
                if (event.choices?.[0]?.delta?.content) {
                  outputContent += event.choices[0].delta.content;
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          }
        }
      });
      
      response.data.on('end', () => {
        console.log(`✅ Stream ended, closing response...`);
        res.end();
        
        // 📊 Enregistrer les tokens après le stream (avec le contenu capturé)
        const duration = Date.now() - startTime;
        if (tokens.input > 0 || tokens.output > 0) {
          console.log(`✅ Final tokens from stream: ${tokens.input}+${tokens.output}`);
          console.log(`📝 Captured output content: ${outputContent.length} chars`);
          recordTokens(model, tokens.input, tokens.output, duration, inputContent, outputContent, client, 'infomaniak');
        } else {
          console.log(`⚠️  No token info extracted from stream`);
        }
      });
      
      response.data.on('error', (error) => {
        console.error(`❌ Stream error:`, error.message);
        res.end();
      });
    } catch (axiosError) {
      console.error('❌ Axios error:', axiosError.message);
      console.error('❌ Axios error config:', axiosError.config?.url);
      throw axiosError;
    }
  } catch (error) {
    console.error('❌ OpenAI proxy error:', error);
    console.error('❌ Error message:', error.message);
    console.error('❌ Error stack:', error.stack);
    
    // Vérifier si res n'a pas déjà été envoyée
    if (!res.headersSent) {
      res.status(503).json({ error: error.message });
    } else {
      console.error('❌ Response already sent, cannot send error');
    }
  }
}

// 🔗 Fonction pour forwarder et parser les réponses OLLAMA (code original)
function handleOLLAMA(req, res, originalUrl, bodyData, client = 'unknown') {
  const pathAndQuery = originalUrl;
  const model = bodyData?.model || 'unknown';
  const startTime = Date.now();
  
  console.log(req.headers)
  const inputContent = bodyData?.prompt || bodyData?.messages?.[0]?.content || JSON.stringify(bodyData).substring(0, 500) || null;
  
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
      let outputContent = '';

      res.writeHead(proxyRes.statusCode, proxyRes.headers);

      proxyRes.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        buffer += chunkStr;

        const lines = buffer.split('\n');
        buffer = lines[lines.length - 1];

        for (let i = 0; i < lines.length - 1; i++) {
          if (lines[i].trim()) {
            try {
              const data = JSON.parse(lines[i]);
              if (data) {
                if (data.prompt_eval_count) tokenData.prompt_eval_count = data.prompt_eval_count;
                if (data.eval_count) tokenData.eval_count += data.eval_count;
                
                if (data.message?.content) {
                  outputContent += data.message.content;
                } else if (data.response) {
                  outputContent += data.response;
                }
              }
            } catch (e) {}
          }
        }

        res.write(chunk);
      });

      proxyRes.on('end', () => {
        if (buffer.trim()) {
          try {
            const data = JSON.parse(buffer);
            if (data) {
              if (data.prompt_eval_count) tokenData.prompt_eval_count = data.prompt_eval_count;
              if (data.eval_count) tokenData.eval_count += data.eval_count;
              
              if (data.message?.content) {
                outputContent += data.message.content;
              } else if (data.response) {
                outputContent += data.response;
              }
            }
          } catch (e) {}
        }

        res.end();

        const duration = Date.now() - startTime;

        if (tokenData.prompt_eval_count > 0 || tokenData.eval_count > 0) {
          console.log(`📤 Output (${outputContent.length} chars): ${outputContent.substring(0, 80)}${outputContent.length > 80 ? '...' : ''}`);
          recordTokens(model, tokenData.prompt_eval_count, tokenData.eval_count, duration, inputContent, outputContent, client, 'ollama');
        }

        resolve();
      });
    });

    proxyReq.on('error', (err) => {
      console.error('❌ Proxy error:', err.message);
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      resolve();
    });

    if (bodyStr) {
      proxyReq.write(bodyStr);
    }

    proxyReq.end();
  });
}

// 🎯 Router principal - détecte le format et route
app.all('*', async (req, res) => {
  const pathAndQuery = req.originalUrl;
  const fullUrl = `${req.protocol}://${req.get('host')}${pathAndQuery}`;
  let bodyData = req.method !== 'GET' ? req.body : null;
  const client = req.headers['x-client'] || 'unknown';
  
  console.log(`🔄 [${new Date().toISOString()}] New request: ${req.method} ${fullUrl}`);
  console.log(`👤 Client: ${client}`);
  
  if (bodyData) {
    console.log(`📨 Request to ${pathAndQuery}:`, JSON.stringify(bodyData).substring(0, 100));
  }
  
  const format = detectFormat(bodyData, pathAndQuery, req.headers);
  console.log(`🔍 Detected format: ${format}`);
  
  try {
    if (format === 'openai') {
      console.log(`➡️  Routing to handleOpenAI...`);
      await handleOpenAI(req, res, pathAndQuery, bodyData, client);
      console.log(`✅ handleOpenAI completed`);
    } else if (format === 'ollama') {
      console.log(`➡️  Routing to handleOLLAMA...`);
      await handleOLLAMA(req, res, pathAndQuery, bodyData, client);
      console.log(`✅ handleOLLAMA completed`);
    } else {
      // Format inconnu ou GET request - forwarder à OLLAMA sans tracking
      console.log(`➡️  Pass-through to OLLAMA: ${pathAndQuery}`);
      await handleOLLAMA(req, res, pathAndQuery, bodyData, client);
      console.log(`✅ Pass-through completed`);
    }
  } catch (error) {
    console.error(`❌❌ Router error:`, error.message);
    console.error(error.stack);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal proxy error: ' + error.message });
    }
  }
});

function recordTokens(model, inputTokens, outputTokens, duration, inputContent = null, outputContent = null, client = 'unknown', provider = 'unknown') {
  console.log(`📊 recordTokens called: model=${model}, client=${client}, provider=${provider}, input=${inputTokens}, output=${outputTokens}, duration=${duration}ms, hasOutput=${!!outputContent}`);
  
  axios.post(
    `${MONITOR_URL}/api/record`,
    { 
      model, 
      client,
      provider,
      inputTokens, 
      outputTokens,
      duration,
      inputText: inputContent,
      outputText: outputContent
    },
    { timeout: 5000 }
  ).then(() => {
    console.log(`✅ [${model}] [${client}] [${provider}] ${inputTokens}+${outputTokens} tokens (${duration}ms)`);
  }).catch((err) => {
    console.error(`❌ Failed to record tokens for ${model}:`, err.message);
  });
}

app.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log('\n' + '='.repeat(70));
  console.log('🔗 HYBRID PROXY - TOKEN TRACKING (OLLAMA + OpenAI)');
  console.log('='.repeat(70));
  console.log(`✅ Proxy on:              http://0.0.0.0:${PROXY_PORT}`);
  console.log(`📡 OLLAMA forwards to:    http://${OLLAMA_HOST}:${OLLAMA_PORT}`);
  console.log(`📡 OpenAI forwards to:    (auto-detected from request headers)`);
  console.log(`📊 Monitor:               ${MONITOR_URL}`);
  console.log('='.repeat(70) + '\n');
});

process.on('SIGINT', () => {
  process.exit(0);
});
