// serve.js — zero-dependency static file server + /auth reverse-proxy.
//   node serve.js [port]   (default 8123)
// Serves the games-compendium from the PROJECT ROOT (each game page under /web/, ES modules reach ../src/*).
// In production it also fronts Keycloak: everything under /auth is proxied to the Keycloak upstream, and if
// that upstream is DOWN (auth node offline / pod restarting) it serves maintenance.html (HTTP 503) instead of
// a raw gateway error. Because this server runs on piserver — independent of the auth node — the maintenance
// page stays available precisely when sign-in is not. Upstream is configurable via KC_UPSTREAM_HOST/PORT.

import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';

const port = Number(process.argv[2]) || 8123;
const root = process.cwd();

// Keycloak upstream (the in-cluster ClusterIP:port). Overridable via env for portability.
const KC_HOST = process.env.KC_UPSTREAM_HOST || '10.43.180.247';
const KC_PORT = Number(process.env.KC_UPSTREAM_PORT) || 8080;
const KC_TIMEOUT_MS = Number(process.env.KC_UPSTREAM_TIMEOUT_MS) || 12000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Serve the friendly maintenance page (falls back to plain text if the file is missing).
async function serveMaintenance(res) {
  if (res.headersSent || res.writableEnded) return;
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '30', 'Cache-Control': 'no-store' };
  try {
    const html = await readFile(join(root, 'maintenance.html'));
    res.writeHead(503, headers).end(html);
  } catch {
    res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' })
      .end('Sign-in is temporarily undergoing maintenance. Please try again shortly.');
  }
}

// Reverse-proxy /auth/* to Keycloak; on a connection failure/timeout (upstream down) show maintenance.
function proxyAuth(req, res) {
  const upstream = httpRequest(
    { host: KC_HOST, port: KC_PORT, method: req.method, path: req.url, headers: req.headers, timeout: KC_TIMEOUT_MS },
    (upRes) => {
      res.writeHead(upRes.statusCode || 502, upRes.headers);
      upRes.pipe(res);
    },
  );
  // Upstream unreachable (no endpoints / refused / reset) → maintenance page.
  upstream.on('error', () => serveMaintenance(res));
  upstream.on('timeout', () => { upstream.destroy(); serveMaintenance(res); });
  req.on('error', () => upstream.destroy());
  req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);

  // Auth traffic is proxied to Keycloak (with a maintenance fallback), never treated as a static file.
  if (pathname === '/auth' || pathname.startsWith('/auth/')) {
    proxyAuth(req, res);
    return;
  }

  // Static files from the project root, with path-traversal protection.
  let p = pathname;
  if (p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const filePath = normalize(join(root, p));
  if (!filePath.startsWith(root)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, () => {
  console.log(`Serving ${root}\n  → http://localhost:${port}/  (/auth proxied to ${KC_HOST}:${KC_PORT}; Ctrl+C to stop)`);
});
