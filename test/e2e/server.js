/* eslint-env node */
'use strict';

// Local HTTPS server for the stand-in booking site. It listens on 127.0.0.1
// only and serves the files in ./site; the test browser is told to resolve the
// booking host to it (see chromeArgs in run.js).

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SITE_HOST = 'www.irctc.co.in';
const SITE_DIR = path.join(__dirname, 'site');
const ASSETS = {
  '/__standin/standin.js': ['standin.js', 'text/javascript; charset=utf-8'],
  '/__standin/standin.css': ['standin.css', 'text/css; charset=utf-8'],
};

// A throwaway self-signed certificate; the browser runs with
// --ignore-certificate-errors, so nothing has to trust it.
function makeCertificate(dir) {
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', `/CN=${SITE_HOST}`, '-addext', `subjectAltName=DNS:${SITE_HOST}`,
    '-keyout', key, '-out', cert,
  ], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// `inUse` is the caller's set of temp directories to remove on exit.
async function startServer(inUse = new Set()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standin-cert-'));
  inUse.add(dir);
  // Sent with every response. It is new on every run, so a page that carries
  // it can only have come from this process.
  const marker = crypto.randomBytes(12).toString('hex');

  const server = https.createServer(makeCertificate(dir), (req, res) => {
    const { pathname } = new URL(req.url, `https://${SITE_HOST}`);
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-standin': marker });
      res.end(body);
    };

    if (pathname === '/__standin/ping') {
      send(200, 'text/plain; charset=utf-8', marker);
    } else if (ASSETS[pathname]) {
      const [file, type] = ASSETS[pathname];
      send(200, type, fs.readFileSync(path.join(SITE_DIR, file)));
    } else if (pathname === '/' || pathname.startsWith('/nget/')) {
      // One document for every page of the site, like the single-page app it stands in for.
      send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(SITE_DIR, 'index.html')));
    } else {
      send(404, 'text/plain; charset=utf-8', 'not part of the stand-in');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  return {
    port: server.address().port,
    marker,
    close: () => new Promise((resolve) => {
      server.close(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        resolve();
      });
      server.closeAllConnections();
    }),
  };
}

module.exports = { startServer, SITE_HOST };
