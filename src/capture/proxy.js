/**
 * Pure Node.js MITM Proxy Server for auto-quiz credential capture.
 *
 * Replaces mitmproxy entirely — zero external dependencies beyond Node.js built-ins.
 * Uses the CA certificate module (ca.js) for on-the-fly TLS cert generation.
 *
 * Intercepts traffic to quiz domains (fengchuanba.com / fengxueba.com),
 * extracts userId, uuid, wxc, secretBoxCode, secretKey, baseUrl from URLs
 * and request/response bodies, then saves to ~/.auto-quiz-session.json.
 *
 * Usage (via CLI):
 *   node src/cli.js capture
 *
 * Standalone:
 *   node src/capture/proxy.js --port 8899
 */

import { createServer } from 'node:http';
import { connect as tlsConnect, createSecureContext, TLSSocket } from 'node:tls';
import { connect as netConnect } from 'node:net';
import { URL } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadOrCreateCA, generateHostCert } from './ca.js';

// ---- Config ----
const QUIZ_DOMAINS = ['fengchuanba.com', 'fengxueba.com', 'fengchuanba.cn', 'fengxueba.cn'];
const SESSION_FILE = join(homedir(), '.auto-quiz-session.json');
const PROFILE_FILE = join(homedir(), '.auto-quiz', 'profiles.json');

// ---- Credential patterns ----
const URL_PATTERNS = [
  [/(?:[?&])code=([\w-]+)/, 'wxc'],
  [/(?:[?&])openid=([\w-]+)/, 'uuid'],
  [/(?:[?&])userId=(\d+)/, 'userId'],
];

const BODY_PATTERNS = [
  [/"wxc"\s*:\s*"([^"]+)"/, 'wxc'],
  [/"uuid"\s*:\s*"([^"]+)"/, 'uuid'],
  [/"userId"\s*:\s*"([^"]+)"/, 'userId'],
  [/"openId"\s*:\s*"([^"]+)"/, 'uuid'],
  [/"openid"\s*:\s*"([^"]+)"/, 'uuid'],
  [/wxc=([\w-]+)/, 'wxc'],
  [/uuid=([\w-]+)/, 'uuid'],
  [/userId=(\d+)/, 'userId'],
];

// ============================================================================
// Credential extraction
// ============================================================================

function isQuizDomain(host) {
  return QUIZ_DOMAINS.some((d) => host.includes(d));
}

function extractFromText(text, patterns) {
  const result = {};
  for (const [pattern, field] of patterns) {
    if (field in result) continue; // first match wins
    const m = text.match(pattern);
    if (m) result[field] = m[1];
  }
  return result;
}

function extractQuizConfig(url) {
  // URL: https://host/path#secretBoxCode-secretKey
  const m = url.match(/#(\d+)-([a-zA-Z0-9]+)/);
  if (!m) return {};
  const hostM = url.match(/https?:\/\/([^/?#]+)/);
  return {
    secretBoxCode: m[1],
    secretKey: m[2],
    baseUrl: hostM ? `https://${hostM[1]}` : null,
  };
}

// ============================================================================
// Persistence
// ============================================================================

async function saveCredentials(newCreds) {
  let existing = {};
  try {
    if (existsSync(SESSION_FILE)) {
      existing = JSON.parse(await readFile(SESSION_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }

  const merged = { ...existing, ...newCreds };
  const dir = SESSION_FILE.replace(/[/\\][^/\\]+$/, '');
  await mkdir(dir, { recursive: true });
  await writeFile(SESSION_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  console.log(`  ✅ Credentials saved to ${SESSION_FILE}`);
}

async function updateProfileIfMatch(quizConfig, creds) {
  if (!quizConfig.baseUrl || !existsSync(PROFILE_FILE)) return;
  try {
    const profiles = JSON.parse(await readFile(PROFILE_FILE, 'utf-8'));
    let updated = false;
    for (const [name, p] of Object.entries(profiles.profiles || {})) {
      if (p.baseUrl === quizConfig.baseUrl && p.secretBoxCode === quizConfig.secretBoxCode) {
        p.session = { ...(p.session || {}), ...creds };
        console.log(`  ✅ Updated profile "${name}" with fresh credentials`);
        updated = true;
      }
    }
    if (updated) {
      await writeFile(PROFILE_FILE, JSON.stringify(profiles, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error(`  ⚠️  Failed to update profile: ${e.message}`);
  }
}

// ============================================================================
// Request body capture (stream → buffer)
// ============================================================================

function captureRequestBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

function captureResponseBody(res) {
  return new Promise((resolve) => {
    const chunks = [];
    res.on('data', (chunk) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', () => resolve(Buffer.alloc(0)));
  });
}

// ============================================================================
// Process intercepted request
// ============================================================================

async function processInterceptedRequest(method, url, reqBodyBuf) {
  const parsedUrl = url;
  const urlStr = typeof parsedUrl === 'string' ? parsedUrl : parsedUrl.href || parsedUrl;

  // Extract from URL
  const urlCreds = extractFromText(urlStr, URL_PATTERNS);

  // Extract from request body
  let bodyCreds = {};
  if (reqBodyBuf && reqBodyBuf.length > 0) {
    const bodyText = reqBodyBuf.toString('utf-8');
    bodyCreds = extractFromText(bodyText, BODY_PATTERNS);
  }

  // Merge (URL wins — OAuth code from redirect)
  const newCreds = { ...bodyCreds, ...urlCreds };
  const quizConfig = extractQuizConfig(urlStr);

  if (Object.keys(newCreds).length > 0) {
    console.log(`  🎯 Credentials found: ${JSON.stringify(newCreds)}`);
    await saveCredentials(newCreds);
    if (Object.keys(quizConfig).length > 0) {
      await updateProfileIfMatch(quizConfig, newCreds);
    }
  }

  if (Object.keys(quizConfig).length > 0) {
    console.log(`  📋 Quiz config: ${JSON.stringify(quizConfig)}`);
  }
}

// ============================================================================
// HTTPS Interception (CONNECT tunnel → MITM)
// ============================================================================

let caKey = null;
let caCert = null;
const hostCertCache = new Map();

function getHostSecureContext(hostname) {
  if (hostCertCache.has(hostname)) return hostCertCache.get(hostname);

  const { key, cert } = generateHostCert(hostname, caKey, caCert);
  const ctx = createSecureContext({ key, cert });
  hostCertCache.set(hostname, ctx);
  return ctx;
}

async function handleConnect(req, clientSocket, head) {
  const [hostname, portStr] = req.url.split(':');
  const port = parseInt(portStr, 10) || 443;

  // Only MITM quiz domains — pass through everything else
  if (!isQuizDomain(hostname)) {
    const serverSocket = netConnect(port, hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });
    serverSocket.on('error', () => clientSocket.end());
    clientSocket.on('error', () => serverSocket.end());
    return;
  }

  // === MITM Mode: intercept HTTPS for quiz domains ===
  console.log(`[quiz] CONNECT ${hostname}:${port}`);

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

  // Wrap client socket in TLS server using per-host cert
  const tlsCtx = getHostSecureContext(hostname);
  const tlsSocket = new TLSSocket(clientSocket, {
    isServer: true,
    secureContext: tlsCtx,
  });

  // Handle HTTP requests over the decrypted TLS connection
  let buffer = Buffer.alloc(0);
  tlsSocket.on('data', async (data) => {
    buffer = Buffer.concat([buffer, data]);

    // Simple HTTP/1.1 request parser (state machine)
    while (buffer.length > 0) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break; // incomplete header

      const headerText = buffer.subarray(0, headerEnd).toString('utf-8');
      const headerLines = headerText.split('\r\n');
      const requestLine = headerLines[0];
      const m = requestLine.match(/^(\w+)\s+(\S+)\s+HTTP\/(\d\.\d)$/);
      if (!m) break;

      const method = m[1];
      const path = m[2];
      const hostHeader = headerLines.find((l) => l.toLowerCase().startsWith('host:'));
      const host = hostHeader ? hostHeader.split(':')[1].trim() : hostname;
      const url = `https://${host}${path}`;

      // Parse Content-Length for body
      const clHeader = headerLines.find((l) => l.toLowerCase().startsWith('content-length:'));
      const contentLength = clHeader ? parseInt(clHeader.split(':')[1].trim(), 10) : 0;

      const totalLength = headerEnd + 4 + contentLength;
      if (buffer.length < totalLength) break; // incomplete body

      // Extract request body
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + contentLength;
      const reqBody = buffer.subarray(bodyStart, bodyEnd);

      // Remove parsed request from buffer
      buffer = buffer.subarray(totalLength);

      // Extract credentials
      console.log(`[quiz] ${method} ${url.substring(0, 150)}`);
      await processInterceptedRequest(method, url, reqBody);

      // Forward to real server
      const tlsClient = tlsConnect(port, hostname, {
        servername: hostname,
        rejectUnauthorized: false,
      }, () => {
        // Rewrite request to absolute path
        const pathOnly = path.replace(/^https?:\/\/[^/]+/, '') || '/';
        const forwardedHeader = headerText
          .replace(/^(\w+)\s+\S+/, `$1 ${pathOnly}`)
          .replace(/proxy-connection:/gi, 'connection:')
          .replace(/Proxy-Connection:/gi, 'Connection:');

        tlsClient.write(forwardedHeader + '\r\n\r\n');
        if (reqBody.length > 0) tlsClient.write(reqBody);

        // Pipe response back (capture response body too)
        captureResponseBody(tlsClient).then(async (respBody) => {
          if (respBody.length > 0) {
            const respText = respBody.toString('utf-8');
            const respCreds = extractFromText(respText, BODY_PATTERNS);
            if (Object.keys(respCreds).length > 0) {
              console.log(`  🎯 Credentials in response: ${JSON.stringify(respCreds)}`);
              await saveCredentials(respCreds);
            }
          }
        });

        tlsClient.pipe(tlsSocket, { end: false });
      });

      tlsClient.on('error', () => tlsSocket.end());
    }
  });

  tlsSocket.on('error', () => { /* client disconnect */ });
}

// ============================================================================
// HTTP Forward Proxy (plaintext HTTP interception)
// ============================================================================

async function handleHttp(req, res) {
  const host = req.headers.host || '';
  const url = `http://${host}${req.url}`;

  if (!isQuizDomain(host)) {
    // Pass through non-quiz traffic
    res.writeHead(501, { 'Content-Type': 'text/plain' });
    res.end('Only quiz domain interception supported. Set proxy for quiz traffic.');
    return;
  }

  console.log(`[quiz] ${req.method} ${url.substring(0, 150)}`);

  // Capture request body
  const reqBody = await captureRequestBody(req);

  // Extract credentials
  await processInterceptedRequest(req.method, url, reqBody);

  // Forward request to real server
  const urlObj = new URL(url);
  const options = {
    hostname: urlObj.hostname,
    port: urlObj.port || 80,
    path: urlObj.pathname + urlObj.search + (urlObj.hash || ''),
    method: req.method,
    headers: { ...req.headers },
  };

  // Remove proxy headers
  delete options.headers['proxy-connection'];
  delete options.headers['proxy-authorization'];

  const proxyReq = (urlObj.protocol === 'https:' ? await import('node:https').then((m) => m.request) : await import('node:http').then((m) => m.request))(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);

    // Capture response body for creds
    captureResponseBody(proxyRes).then(async (respBody) => {
      if (respBody.length > 0) {
        const respText = respBody.toString('utf-8');
        const respCreds = extractFromText(respText, BODY_PATTERNS);
        if (Object.keys(respCreds).length > 0) {
          console.log(`  🎯 Credentials in response: ${JSON.stringify(respCreds)}`);
          await saveCredentials(respCreds);
        }
      }
    });
  });

  proxyReq.on('error', () => res.end());
  proxyReq.end(reqBody);
}

// ============================================================================
// Start proxy server
// ============================================================================

export async function startProxy({ port = 8899, onReady } = {}) {
  console.log('[capture] Loading CA certificate...');
  const ca = await loadOrCreateCA();
  caKey = ca.key;
  caCert = ca.cert;

  const server = createServer((req, res) => {
    handleHttp(req, res).catch(() => {});
  });

  server.on('connect', (req, clientSocket, head) => {
    handleConnect(req, clientSocket, head).catch(() => {});
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[capture] Port ${port} is already in use. Try --port <other>.`);
      process.exit(1);
    }
    throw err;
  });

  await new Promise((resolve) => server.listen(port, '0.0.0.0', resolve));

  console.log(`[capture] MITM proxy listening on 0.0.0.0:${port}`);

  if (onReady) onReady();

  return server;
}

// ============================================================================
// Standalone entry
// ============================================================================

const args = process.argv.slice(2);
if (args.includes('--standalone') || process.argv[1]?.includes('proxy.js')) {
  const portArg = args.indexOf('--port');
  const port = portArg >= 0 ? parseInt(args[portArg + 1], 10) || 8899 : 8899;

  startProxy({ port }).catch((err) => {
    console.error('[capture] Fatal:', err);
    process.exit(1);
  });
}
