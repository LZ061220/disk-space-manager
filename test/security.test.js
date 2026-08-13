const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const manager = require('../disk-space-manager');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${port}`, ...(options.headers || {}) };
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: options.method || 'GET', headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

test('protected path rules cover roots and user profile data', () => {
  assert.equal(manager.isProtectedPath('C:\\'), true);
  assert.equal(manager.isProtectedPath(path.join(os.homedir(), 'Documents')), true);
  assert.equal(manager.isProtectedPath(path.join(os.homedir(), 'AppData', 'Local')), true);
});

test('candidate definitions ignore TEMP/TMP overrides', () => {
  const originalTemp = process.env.TEMP;
  const originalTmp = process.env.TMP;
  process.env.TEMP = 'D:\\DefinitelyNotTheRealTemp';
  process.env.TMP = 'D:\\DefinitelyNotTheRealTemp';
  try {
    const candidate = manager.candidateDefinitions('C').find(item => item.label === '当前用户临时文件');
    assert.equal(manager.normalizedPath(candidate.path), manager.normalizedPath(path.join(os.homedir(), 'AppData', 'Local', 'Temp')));
  } finally {
    if (originalTemp === undefined) delete process.env.TEMP; else process.env.TEMP = originalTemp;
    if (originalTmp === undefined) delete process.env.TMP; else process.env.TMP = originalTmp;
  }
});

test('HTTP API requires a session token and same-origin POST requests', async t => {
  const service = await manager.startServer({ port: 0 });
  t.after(() => service.server.close());

  const page = await request(service.port, '/');
  assert.equal(page.status, 200);
  assert.match(page.body, new RegExp(manager.getSessionToken()));
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);

  const missingToken = await request(service.port, '/api/drives');
  assert.equal(missingToken.status, 401);

  const tokenHeaders = { 'X-Disk-Manager-Token': manager.getSessionToken() };
  const drives = await request(service.port, '/api/drives', { headers: tokenHeaders });
  assert.equal(drives.status, 200);

  const crossSite = await request(service.port, '/api/recycle', {
    method: 'POST',
    headers: { ...tokenHeaders, Origin: 'https://example.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: path.join(os.homedir(), 'Documents'), force: true }),
  });
  assert.equal(crossSite.status, 403);

  const protectedTarget = path.join(os.homedir(), 'Documents');
  assert.equal(fs.existsSync(protectedTarget), true);
  const protectedAttempt = await request(service.port, '/api/recycle', {
    method: 'POST',
    headers: { ...tokenHeaders, Origin: service.url, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: protectedTarget, force: true }),
  });
  assert.equal(protectedAttempt.status, 400);
  assert.match(JSON.parse(protectedAttempt.body).error, /保护目录/);
  assert.equal(fs.existsSync(protectedTarget), true);
});
