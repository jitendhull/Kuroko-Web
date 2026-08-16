// Unified Local static server, CORS Proxy, M3U8 rewriter, and Native Player Launcher.
import http from 'http';
import https from 'https';
import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { spawn } from 'child_process';
import dns from 'dns';

const PORT = 3000;

// HTTP Agent connection pooling for fast keep-alive reuse
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 50 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 50 });

// Chrome-like cipher suites for TLS fingerprint spoofing to bypass Cloudflare
const CHROME_CIPHERS = [
  'TLS_AES_128_GCM_SHA256',
  'TLS_AES_256_GCM_SHA384',
  'TLS_CHACHA20_POLY1305_SHA256',
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'ECDHE-RSA-AES128-SHA',
  'ECDHE-RSA-AES256-SHA'
].join(':');

const CHROME_SIGALGS = [
  'ecdsa_secp256r1_sha256',
  'rsa_pss_rsae_sha256',
  'rsa_pkcs1_sha256',
  'ecdsa_secp384r1_sha384',
  'rsa_pss_rsae_sha384',
  'rsa_pkcs1_sha384'
].join(':');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// DNS-over-HTTPS (DoH) resolver cache and function to bypass ISP blocking
const dnsCache = {};
async function resolveDoh(hostname) {
  if (dnsCache[hostname]) return dnsCache[hostname];
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(':')) {
    return hostname;
  }
  try {
    const url = `https://dns.google/resolve?name=${encodeURIComponent(hostname)}&type=A`;
    const res = await new Promise((resolve, reject) => {
      https.get(url, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    const ip = res.Answer?.find(ans => ans.type === 1)?.data;
    if (ip) {
      dnsCache[hostname] = ip;
      console.log(`[DoH] Resolved ${hostname} -> ${ip}`);
      return ip;
    }
  } catch (err) {
    console.error(`[DoH] Resolution failed for ${hostname}:`, err.message);
  }
  return hostname;
}

// Rewrite relative and absolute URLs in M3U8 playlists to route through local proxy
function rewriteManifest(manifestText, baseUrl, referer) {
  const lines = manifestText.split('\n');
  const rewritten = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      if (trimmed.includes('URI=')) {
        return trimmed.replace(/URI=["']([^"']+)["']/g, (match, uri) => {
          try {
            const absUrl = new URL(uri, baseUrl).toString();
            return `URI="http://localhost:${PORT}/proxy?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}"`;
          } catch (_) {
            return match;
          }
        });
      }
      return line;
    }
    try {
      const absUrl = new URL(trimmed, baseUrl).toString();
      return `http://localhost:${PORT}/proxy?url=${encodeURIComponent(absUrl)}&referer=${encodeURIComponent(referer)}`;
    } catch (_) {
      return line;
    }
  });
  return rewritten.join('\n');
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsedUrl.pathname;

  console.log(`${req.method} ${pathname}`);

  // 1. CORS Proxy Endpoint
  if (pathname === '/proxy') {
    const targetUrlStr = parsedUrl.searchParams.get('url');
    const referer = parsedUrl.searchParams.get('referer') || '';

    if (!targetUrlStr) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing "url" parameter');
      return;
    }

    try {
      // Forward all incoming client headers, overriding host/origin/referer/user-agent/encoding
      const headers = {};
      for (const [key, val] of Object.entries(req.headers)) {
        const lowerKey = key.toLowerCase();
        if (!['host', 'connection', 'origin', 'referer', 'user-agent', 'accept-encoding'].includes(lowerKey)) {
          headers[lowerKey] = val;
        }
      }

      headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

      // Fallback standard browser headers to satisfy Cloudflare/security checks
      const defaults = {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin'
      };
      for (const [k, v] of Object.entries(defaults)) {
        if (!headers[k]) {
          headers[k] = v;
        }
      }

      if (referer) {
        headers['referer'] = referer;
        try {
          headers['origin'] = new URL(referer).origin;
        } catch (_) {}
      }

      const makeRequest = async (currentUrlStr) => {
        try {
          const targetUrl = new URL(currentUrlStr);
          const originalHostname = targetUrl.hostname;
          
          let resolvedIp = originalHostname;
          try {
            await new Promise((resolve, reject) => {
              dns.lookup(originalHostname, (err) => {
                if (err) reject(err);
                else resolve();
              });
            });
          } catch (dnsErr) {
            console.log(`[DNS] Local lookup failed for ${originalHostname}, falling back to DoH...`);
            resolvedIp = await resolveDoh(originalHostname);
          }

          const isHttps = targetUrl.protocol === 'https:';
          const transport = isHttps ? https : http;

          const requestHeaders = { ...headers };
          requestHeaders['Host'] = originalHostname;

          const options = {
            method: req.method,
            headers: requestHeaders,
            hostname: resolvedIp,
            agent: isHttps ? httpsAgent : httpAgent,
            port: targetUrl.port || (isHttps ? 443 : 80),
            path: targetUrl.pathname + targetUrl.search
          };

          if (isHttps) {
            options.ciphers = CHROME_CIPHERS;
            options.sigalgs = CHROME_SIGALGS;
            options.minVersion = 'TLSv1.2';
            options.maxVersion = 'TLSv1.3';
            options.honorCipherOrder = false;
            options.servername = originalHostname;
          }

          console.log('[Proxy Request Options]:', JSON.stringify({
            hostname: options.hostname,
            port: options.port,
            path: options.path,
            method: options.method,
            headers: options.headers,
            servername: options.servername
          }, null, 2));

          const proxyReq = transport.request(options, (proxyRes) => {
            console.log(`[Proxy Response] ${proxyRes.statusCode} for ${currentUrlStr}`);
            // Handle HTTP redirects transparently on the server side
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
              const redirectUrl = new URL(proxyRes.headers.location, currentUrlStr).toString();
              console.log(`Proxy following redirect: ${currentUrlStr} -> ${redirectUrl}`);
              makeRequest(redirectUrl);
              return;
            }

            const isM3u8 = currentUrlStr.includes('.m3u8') ||
                           String(proxyRes.headers['content-type']).includes('mpegurl') ||
                           String(proxyRes.headers['content-type']).includes('mpegURL');

            // Copy matching headers back to browser client
            const resHeaders = {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': '*',
              'Access-Control-Allow-Methods': '*'
            };

            const copyHeaders = [
              'content-type',
              'content-length',
              'content-range',
              'accept-ranges',
              'content-encoding'
            ];

            copyHeaders.forEach(h => {
              if (proxyRes.headers[h]) {
                resHeaders[h] = proxyRes.headers[h];
              }
            });

            // If M3U8, we intercept the text and rewrite it
            if (isM3u8) {
              delete resHeaders['content-encoding']; // Decompress first on server side if encoded
              delete resHeaders['content-length'];   // Length changes after rewrite

              resHeaders['content-type'] = 'application/x-mpegURL';
              res.writeHead(proxyRes.statusCode, resHeaders);

              let body = '';
              proxyRes.setEncoding('utf8');
              proxyRes.on('data', chunk => body += chunk);
              proxyRes.on('end', () => {
                const rewritten = rewriteManifest(body, currentUrlStr, referer);
                res.end(rewritten);
              });
            } else {
              res.writeHead(proxyRes.statusCode, resHeaders);
              proxyRes.pipe(res);
            }
          });

          proxyReq.on('error', (err) => {
            console.error('Proxy request error:', err.message, err.stack);
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end(`Bad Gateway: ${err.message}`);
          });

          if (req.method === 'POST') {
            req.pipe(proxyReq);
          } else {
            proxyReq.end();
          }
        } catch (err) {
          console.error('makeRequest setup error:', err.message);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(`Internal Server Error: ${err.message}`);
        }
      };

      makeRequest(targetUrlStr);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Invalid URL: ${err.message}`);
    }
    return;
  }

  // 2. Native Player Launcher Endpoint
  if (pathname === '/play-native') {
    const targetUrl = parsedUrl.searchParams.get('url');
    const referer = parsedUrl.searchParams.get('referer') || '';
    const player = parsedUrl.searchParams.get('player') || 'mpv';
    const subUrl = parsedUrl.searchParams.get('sub') || '';

    if (!targetUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "url" parameter' }));
      return;
    }

    try {
      let args = [];
      let command = player;

      if (player === 'mpv') {
        args.push(targetUrl);
        if (referer) {
          args.push(`--http-header-fields=Referer: ${referer}`);
        }
        if (subUrl) {
          args.push(`--sub-files=${subUrl}`);
        }
      } else if (player === 'vlc') {
        args.push(targetUrl);
        if (referer) {
          args.push(`--http-referrer=${referer}`);
        }
        if (subUrl) {
          args.push(`--sub-file=${subUrl}`);
        }
      } else {
        throw new Error('Unsupported player type');
      }

      console.log(`Spawning native player: ${command} ${args.join(' ')}`);
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.unref();

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ success: true, player, command, args }));
    } catch (err) {
      res.writeHead(500, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // 3. Static File Server Path
  let filePath = '.' + pathname;
  if (filePath === './') {
    filePath = './index.html';
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.stat(filePath, (err, stats) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}\n`);
      }
      return;
    }

    const acceptEncoding = req.headers['accept-encoding'] || '';
    const headers = {
      'Content-Type': contentType,
      'Cache-Control': extname === '.html' ? 'no-cache' : 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*'
    };

    const rawStream = fs.createReadStream(filePath);

    if (/\bgzip\b/.test(acceptEncoding) && ['.html', '.js', '.css', '.json', '.svg'].includes(extname)) {
      headers['Content-Encoding'] = 'gzip';
      res.writeHead(200, headers);
      rawStream.pipe(zlib.createGzip()).pipe(res);
    } else if (/\bdeflate\b/.test(acceptEncoding) && ['.html', '.js', '.css', '.json', '.svg'].includes(extname)) {
      headers['Content-Encoding'] = 'deflate';
      res.writeHead(200, headers);
      rawStream.pipe(zlib.createDeflate()).pipe(res);
    } else {
      headers['Content-Length'] = stats.size;
      res.writeHead(200, headers);
      rawStream.pipe(res);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Local server & proxy running at http://localhost:${PORT}/`);
});
