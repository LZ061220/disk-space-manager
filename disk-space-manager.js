const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, execFileSync } = require('child_process');
const aiAnalyzer = require('./ai-analyzer');

const DEFAULT_PORT = Number(process.env.DISK_MANAGER_PORT || 8765);
const APP_ROOT = __dirname;
const PUBLIC_ROOT = path.join(APP_ROOT, 'disk-space-manager-ui');
const DRIVE_ROOTS = { C: 'C:\\', D: 'D:\\' };
const SESSION_TOKEN = crypto.randomBytes(32).toString('base64url');
const scanCache = new Map();
const levelCache = new Map();
const activeScans = new Map();
const cleanupConfirmations = new Map();
const CACHE_VERSION = 2;
const PERSISTED_CACHE_FILE = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DiskSpaceManager', 'scan-cache.json');

function normalizedPath(target) {
  const resolved = path.resolve(String(target || ''));
  const root = path.parse(resolved).root;
  return (resolved === root ? root : resolved.replace(/[\\/]+$/, '')).toUpperCase();
}

function canonicalPath(target) {
  const resolved = path.resolve(target);
  try { return fs.realpathSync.native(resolved); }
  catch (_) { return resolved; }
}

function isSameOrInside(target, base) {
  const child = normalizedPath(target);
  const parent = normalizedPath(base);
  const prefix = parent.endsWith(path.sep) ? parent : `${parent}${path.sep}`;
  return child === parent || child.startsWith(prefix);
}

function readRedirectedKnownFolders() {
  if (process.platform !== 'win32') return [];
  const script = `$p='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';` +
    `$names=@('Desktop','Personal','My Pictures','My Music','My Video','{374DE290-123F-4565-9164-39C4925E467B}');` +
    `$v=Get-ItemProperty -LiteralPath $p -ErrorAction SilentlyContinue;` +
    `$items=@(); foreach($n in $names){$x=$v.$n;if($x){$items+=[Environment]::ExpandEnvironmentVariables([string]$x)}};` +
    `$json=$items|ConvertTo-Json -Compress;[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$json))`;
  try {
    const encoded = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', timeout: 4000 }).trim();
    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8') || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean);
  } catch (_) { return []; }
}

function buildProtectedPaths() {
  const userHome = os.homedir();
  const systemRoot = process.env.SystemRoot || path.join('C:', 'Windows');
  const trees = [
    systemRoot,
    path.dirname(userHome),
    process.env.ProgramFiles || path.join('C:', 'Program Files'),
    process.env['ProgramFiles(x86)'] || path.join('C:', 'Program Files (x86)'),
    process.env.ProgramData || path.join('C:', 'ProgramData'),
    path.join(userHome, 'AppData'),
    path.join(userHome, 'Desktop'),
    path.join(userHome, 'Documents'),
    path.join(userHome, 'Downloads'),
    path.join(userHome, 'Pictures'),
    path.join(userHome, 'Videos'),
    path.join(userHome, 'Music'),
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    ...readRedirectedKnownFolders(),
  ].filter(Boolean);
  return {
    exact: [userHome, ...Object.values(DRIVE_ROOTS)].map(normalizedPath),
    trees: [...new Set(trees.map(normalizedPath))],
  };
}

const PROTECTED_PATHS = buildProtectedPaths();

function loadPersistedCache() {
  try {
    const saved = JSON.parse(fs.readFileSync(PERSISTED_CACHE_FILE, 'utf8'));
    if (saved._version !== CACHE_VERSION) return;
    for (const letter of ['C', 'D']) if (saved[letter]?.directories) {
      if (saved[letter].candidateState === 'scanning') saved[letter].candidateState = 'ready';
      scanCache.set(letter, saved[letter]);
    }
  } catch (_) {}
}

function persistScanCache() {
  try {
    fs.mkdirSync(path.dirname(PERSISTED_CACHE_FILE), { recursive: true });
    const saved = { _version: CACHE_VERSION };
    for (const [letter, data] of scanCache) saved[letter] = data;
    fs.writeFileSync(PERSISTED_CACHE_FILE, JSON.stringify(saved), 'utf8');
  } catch (_) {}
}

function writeSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  writeSecurityHeaders(res);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function hasValidSessionToken(req) {
  const supplied = String(req.headers['x-disk-manager-token'] || '');
  const expected = SESSION_TOKEN;
  if (supplied.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function validRequestHost(req, port) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function validMutationOrigin(req, port) {
  const origin = String(req.headers.origin || '').toLowerCase();
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function readJsonBody(req, limit = 10000) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      const error = new Error('请求必须使用 application/json');
      error.status = 415;
      return reject(error);
    }
    let body = '';
    let exceeded = false;
    req.setEncoding('utf8');
    req.on('data', chunk => {
      if (exceeded) return;
      body += chunk;
      if (Buffer.byteLength(body) > limit) {
        exceeded = true;
        const error = new Error('请求内容过大');
        error.status = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      try { resolve(JSON.parse(body || '{}')); }
      catch (_) { reject(new Error('请求 JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}

function normalizeDrive(value) {
  const drive = String(value || '').toUpperCase();
  return DRIVE_ROOTS[drive] ? drive : 'C';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  return `${value.toFixed(index === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

async function getDriveInfo(letter) {
  const root = DRIVE_ROOTS[letter];
  try {
    const stat = await fsp.statfs(root);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    if (total > 0) return { letter, root, total, free, used: total - free };
  } catch (_) {
    // Windows versions of Node do not all expose statfs; use the native shell fallback below.
  }
  return new Promise((resolve) => {
    const script = `(Get-Volume -DriveLetter ${letter} -ErrorAction SilentlyContinue | Select-Object Size,SizeRemaining | ConvertTo-Json -Compress)`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }, (error, stdout) => {
      if (error || !stdout.trim()) return resolve({ letter, root, total: 0, free: 0, used: 0 });
      try {
        const value = JSON.parse(stdout);
        const total = Number(value.Size || 0);
        const free = Number(value.SizeRemaining || 0);
        resolve({ letter, root, total, free, used: Math.max(0, total - free) });
      } catch (_) {
        resolve({ letter, root, total: 0, free: 0, used: 0 });
      }
    });
  });
}

function typeForName(name) {
  const extension = path.extname(name).toLowerCase();
  if (!extension) return '未知扩展';
  const groups = {
    '.nvph': '专用数据',
    '.dll': '动态链接库',
    '.bin': '二进制数据',
    '.dat': '通用数据文件',
    '.zip': '压缩包', '.rar': '压缩包', '.7z': '压缩包', '.iso': '镜像文件', '.tar': '压缩包', '.gz': '压缩包',
    '.mp4': '视频', '.mkv': '视频', '.avi': '视频', '.mov': '视频', '.wmv': '视频',
    '.jpg': '图片', '.jpeg': '图片', '.png': '图片', '.gif': '图片', '.webp': '图片', '.psd': '图片',
    '.doc': '文档', '.docx': '文档', '.xls': '文档', '.xlsx': '文档', '.ppt': '文档', '.pptx': '文档', '.pdf': '文档',
    '.exe': '安装包/程序', '.msi': '安装包/程序', '.iso': '镜像文件',
    '.c': '代码', '.h': '代码', '.cpp': '代码', '.cs': '代码', '.java': '代码', '.js': '代码', '.ts': '代码', '.py': '代码', '.go': '代码',
    '.log': '日志', '.tmp': '临时文件', '.cache': '缓存'
  };
  return groups[extension] || '未知扩展';
}

async function walkDirectory(root, token) {
  let total = 0;
  let files = 0;
  const types = {};
  const queue = [root];
  const concurrency = 8;
  async function worker() {
    while (queue.length && !token.cancelled) {
      const current = queue.pop();
      let handle;
      try {
        handle = await fsp.opendir(current);
        for await (const entry of handle) {
          if (token.cancelled) break;
          const full = path.join(current, entry.name);
          try {
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) queue.push(full);
            else if (entry.isFile()) {
              const stat = await fsp.stat(full);
              total += stat.size;
              files += 1;
              const type = typeForName(entry.name);
              types[type] = (types[type] || 0) + stat.size;
            }
          } catch (_) {
            // Locked or inaccessible items are ignored; one bad folder should not stop a scan.
          }
        }
      } catch (_) {
        // Access denied and disconnected drives are expected during a broad scan.
      } finally {
        try { await handle?.close(); } catch (_) {}
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { total, files, types };
}

function isWithinManagedDrive(target) {
  const normalized = normalizedPath(target);
  return Object.values(DRIVE_ROOTS).some(root => {
    const base = normalizedPath(root);
    return isSameOrInside(normalized, base);
  });
}

async function scanDirectoryLevelLegacy(target) {
  const normalized = path.resolve(target);
  if (!isWithinManagedDrive(normalized)) throw new Error('只能查看 C 盘或 D 盘内的目录');
  const entries = [];
  let handle;
  try {
    handle = await fsp.opendir(normalized);
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      entries.push({ name: entry.name, path: path.join(normalized, entry.name), isDirectory: entry.isDirectory() });
    }
  } catch (_) {
    return { path: normalized, entries: [], types: {}, truncated: false };
  } finally {
    try { await handle?.close(); } catch (_) {}
  }
  const token = { cancelled: false };
  const values = await Promise.all(entries.map(async entry => {
    try {
      if (entry.isDirectory) return { name: entry.name, path: entry.path, kind: 'directory', ...(await walkDirectory(entry.path, token)) };
      const stat = await fsp.stat(entry.path);
      const type = typeForName(entry.name);
      return { name: entry.name, path: entry.path, kind: 'file', total: stat.size, files: 1, types: { [type]: stat.size } };
    } catch (_) { return null; }
  }));
  const valid = values.filter(Boolean).sort((a, b) => b.total - a.total);
  const types = {};
  for (const entry of valid) for (const [type, size] of Object.entries(entry.types || {})) types[type] = (types[type] || 0) + size;
  return { path: normalized, entries: valid.slice(0, 200), totalEntries: valid.length, truncated: valid.length > 200, types };
}

async function scanDirectoryLevel(target) {
  const normalized = path.resolve(target);
  if (!isWithinManagedDrive(normalized)) throw new Error('只能查看 C 盘或 D 盘内的目录');
  const cacheKey = normalized.toUpperCase();
  if (levelCache.has(cacheKey)) return levelCache.get(cacheKey);

  const entries = [];
  let handle;
  try {
    handle = await fsp.opendir(normalized);
    for await (const entry of handle) {
      if (entry.isSymbolicLink()) continue;
      entries.push({ name: entry.name, path: path.join(normalized, entry.name), isDirectory: entry.isDirectory() });
    }
  } catch (_) {
    const empty = { path: normalized, entries: [], types: {}, truncated: false, totalEntries: 0 };
    levelCache.set(cacheKey, empty);
    return empty;
  } finally {
    try { await handle?.close(); } catch (_) {}
  }

  const records = [];
  const queue = [];
  for (const entry of entries) {
    if (entry.isDirectory) {
      const record = { name: entry.name, path: entry.path, kind: 'directory', total: 0, files: 0, types: {} };
      records.push(record);
      queue.push({ path: entry.path, record });
    } else {
      try {
        const stat = await fsp.stat(entry.path);
        const type = typeForName(entry.name);
        records.push({ name: entry.name, path: entry.path, kind: 'file', total: stat.size, files: 1, types: { [type]: stat.size } });
      } catch (_) {}
    }
  }

  const concurrency = 10;
  async function worker() {
    while (queue.length) {
      const task = queue.pop();
      let currentHandle;
      try {
        currentHandle = await fsp.opendir(task.path);
        for await (const entry of currentHandle) {
          const full = path.join(task.path, entry.name);
          try {
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) queue.push({ path: full, record: task.record });
            else if (entry.isFile()) {
              const stat = await fsp.stat(full);
              const type = typeForName(entry.name);
              task.record.total += stat.size;
              task.record.files += 1;
              task.record.types[type] = (task.record.types[type] || 0) + stat.size;
            }
          } catch (_) {}
        }
      } catch (_) {
      } finally {
        try { await currentHandle?.close(); } catch (_) {}
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  // Empty folders and zero-byte files do not contribute to disk usage and
  // should not occupy space in the visual map.
  const valid = records.filter(entry => entry.total > 0).sort((a, b) => b.total - a.total);
  const types = {};
  for (const entry of valid) for (const [type, size] of Object.entries(entry.types || {})) types[type] = (types[type] || 0) + size;
  const result = { path: normalized, entries: valid.slice(0, 200), totalEntries: valid.length, truncated: valid.length > 200, types };
  levelCache.set(cacheKey, result);
  return result;
}

function invalidateLevelCache(target) {
  const normalized = path.resolve(target).toUpperCase();
  const parent = path.dirname(normalized);
  for (const key of levelCache.keys()) {
    if (key === normalized || key.startsWith(`${normalized}${path.sep}`) || key === parent || normalized.startsWith(`${key}${path.sep}`)) levelCache.delete(key);
  }
}

function candidateDefinitions(letter) {
  const localAppData = path.join(os.homedir(), 'AppData', 'Local');
  const systemRoot = process.env.SystemRoot || path.join('C:', 'Windows');
  const list = [
    { path: path.join(localAppData, 'Temp'), label: '当前用户临时文件', kind: 'safe', contentsOnly: true, description: '应用产生的临时文件，通常可恢复生成；只清理其中未被占用的内容' },
    { path: path.join(systemRoot, 'Temp'), label: 'Windows 临时文件', kind: 'review', contentsOnly: true, description: '只清理其中未被系统或安装程序占用的内容，保留临时目录本身' },
    { path: path.join(localAppData, 'D3DSCache'), label: 'DirectX 着色器缓存', kind: 'safe', contentsOnly: true, description: '图形缓存，删除后会自动重建；保留缓存目录本身' },
    { path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'), label: 'Edge 浏览器缓存', kind: 'safe', contentsOnly: true, description: '网页缓存；只清理未被占用的内容，保留缓存目录本身' },
    { path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Cache'), label: 'Chrome 浏览器缓存', kind: 'safe', contentsOnly: true, description: '网页缓存；只清理未被占用的内容，保留缓存目录本身' }
  ];
  return list.filter(item => item.path.toUpperCase().startsWith(`${letter}:`));
}

async function collectCandidates(letter) {
  const candidates = [];
  for (const item of candidateDefinitions(letter)) {
    try {
      const stat = await fsp.stat(item.path);
      if (!stat.isDirectory()) continue;
      const summary = await walkDirectory(item.path, { cancelled: false });
      if (summary.total > 0) candidates.push({ ...item, ...summary });
    } catch (_) {}
  }
  return candidates.sort((a, b) => b.total - a.total);
}

async function scanDriveLegacy(letter) {
  if (activeScans.has(letter)) return activeScans.get(letter).promise;
  const token = { cancelled: false };
  const promise = (async () => {
    const root = DRIVE_ROOTS[letter];
    const info = await getDriveInfo(letter);
    let entries = [];
    try {
      const dir = await fsp.opendir(root);
      for await (const entry of dir) {
        if (entry.isSymbolicLink()) continue;
        entries.push({ name: entry.name, path: path.join(root, entry.name), isDirectory: entry.isDirectory() });
      }
    } catch (_) {}
    const dirs = entries.filter(entry => entry.isDirectory);
    const results = [];
    let completed = 0;
    for (let i = 0; i < dirs.length; i += 3) {
      const batch = dirs.slice(i, i + 3);
      const values = await Promise.all(batch.map(async (entry) => {
        const summary = await walkDirectory(entry.path, token);
        completed += 1;
        return { name: entry.name, path: entry.path, ...summary };
      }));
      results.push(...values);
    }
    const candidates = await collectCandidates(letter);
    const data = { letter, info, directories: results.sort((a, b) => b.total - a.total), candidates, scannedAt: new Date().toISOString(), progress: completed };
    scanCache.set(letter, data);
    return data;
  })().finally(() => activeScans.delete(letter));
  activeScans.set(letter, { token, promise });
  return promise;
}

async function scanDrive(letter) {
  if (activeScans.has(letter)) return activeScans.get(letter).promise;
  const token = { cancelled: false };
  const promise = (async () => {
    const root = DRIVE_ROOTS[letter];
    levelCache.delete(normalizedPath(root));
    const info = await getDriveInfo(letter);
    const level = await scanDirectoryLevel(root);
    const directories = level.entries.filter(entry => entry.kind === 'directory');
    const data = {
      letter,
      info,
      directories,
      candidates: [],
      candidateState: 'scanning',
      scannedAt: new Date().toISOString(),
      progress: directories.length
    };
    scanCache.set(letter, data);
    persistScanCache();
    collectCandidates(letter).then(candidates => {
      const current = scanCache.get(letter);
      if (current) { current.candidates = candidates; current.candidateState = 'ready'; persistScanCache(); }
    }).catch(() => {
      const current = scanCache.get(letter);
      if (current) { current.candidateState = 'ready'; persistScanCache(); }
    });
    return data;
  })().finally(() => activeScans.delete(letter));
  activeScans.set(letter, { token, promise });
  return promise;
}

function isProtectedPath(target) {
  const lexical = normalizedPath(target);
  const canonical = normalizedPath(canonicalPath(target));
  if (PROTECTED_PATHS.exact.includes(lexical) || PROTECTED_PATHS.exact.includes(canonical)) return true;
  if (PROTECTED_PATHS.trees.some(base => isSameOrInside(lexical, base) || isSameOrInside(canonical, base))) return true;
  return /(^|\\)(SYSTEM VOLUME INFORMATION|\$RECYCLE\.BIN)(\\|$)/i.test(lexical) ||
    /(^|\\)(SYSTEM VOLUME INFORMATION|\$RECYCLE\.BIN)(\\|$)/i.test(canonical);
}

function isInSafeWhitelist(target) {
  const normalized = path.resolve(target);
  const isKnownCandidate = candidateDefinitions('C').some(item => path.resolve(item.path).toUpperCase() === normalized.toUpperCase()) ||
    candidateDefinitions('D').some(item => path.resolve(item.path).toUpperCase() === normalized.toUpperCase());
  return isKnownCandidate;
}

function getCandidateDefinition(target) {
  const normalized = path.resolve(target).toUpperCase();
  return [...candidateDefinitions('C'), ...candidateDefinitions('D')]
    .find(item => path.resolve(item.path).toUpperCase() === normalized) || null;
}

function issueCleanupConfirmation(target) {
  const token = crypto.randomBytes(24).toString('base64url');
  cleanupConfirmations.set(token, { target: normalizedPath(target), expiresAt: Date.now() + 2 * 60 * 1000 });
  return token;
}

function consumeCleanupConfirmation(token, target) {
  const record = cleanupConfirmations.get(String(token || ''));
  cleanupConfirmations.delete(String(token || ''));
  return Boolean(record && record.expiresAt >= Date.now() && record.target === normalizedPath(target));
}

async function classifyCleanupTarget(target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('缺少要清理的路径');
  const lexicalTarget = path.resolve(target);
  const stat = await fsp.lstat(lexicalTarget);
  const canonicalTarget = await fsp.realpath(lexicalTarget);
  if (!isWithinManagedDrive(lexicalTarget) || !isWithinManagedDrive(canonicalTarget)) throw new Error('只能清理 C 盘或 D 盘内的路径');
  const driveRoot = normalizedPath(path.parse(canonicalTarget).root);
  if (normalizedPath(canonicalTarget) === driveRoot) throw new Error('不允许清理磁盘根目录');

  const definition = getCandidateDefinition(lexicalTarget);
  if (definition) {
    if (stat.isSymbolicLink()) throw new Error('安全清理候选不能是符号链接或目录联接');
    const canonicalDefinition = await fsp.realpath(definition.path);
    if (normalizedPath(canonicalDefinition) !== normalizedPath(canonicalTarget)) throw new Error('清理候选的真实路径与白名单不一致');
    return { target: lexicalTarget, canonicalTarget, definition, whitelisted: true };
  }

  if (isProtectedPath(lexicalTarget) || isProtectedPath(canonicalTarget)) {
    throw new Error('该路径属于系统或个人资料保护目录，不允许强制清理');
  }
  return { target: lexicalTarget, canonicalTarget, definition: null, whitelisted: false };
}

async function moveToRecycleBin(target, confirmationToken) {
  const classification = await classifyCleanupTarget(target);
  if (!classification.whitelisted && !consumeCleanupConfirmation(confirmationToken, classification.canonicalTarget)) {
    const error = new Error('该项目不在安全清理白名单中，需要用户二次确认');
    error.code = 'SAFE_CONFIRMATION_REQUIRED';
    error.confirmationToken = issueCleanupConfirmation(classification.canonicalTarget);
    throw error;
  }
  return new Promise((resolve, reject) => {
    const normalizedTarget = classification.target;
    const definition = classification.definition;
    const contentsOnly = definition?.contentsOnly === true;
    const recycleScript = path.join(APP_ROOT, 'recycle-to-bin.ps1');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', recycleScript, '-TargetPath', normalizedTarget];
    if (contentsOnly) args.push('-ContentsOnly');
    execFile('powershell.exe', args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        // PowerShell 5.1 writes native error text using the system code page.
        // Do not pass that text through to the UTF-8 web UI: it becomes mojibake
        // and usually exposes an internal script path instead of helping the user.
        const message = contentsOnly
          ? '浏览器缓存中有文件正在使用，已清理未占用的内容；请关闭浏览器后重试。'
          : '移入回收站失败，请关闭正在使用该文件夹的程序后重试。';
        return reject(new Error(message));
      }
      if (!contentsOnly && fs.existsSync(normalizedTarget)) return reject(new Error('原路径仍然存在，未完成回收站转移'));
      const output = String(stdout || '').trim();
      resolve(contentsOnly ? (output || '可用缓存内容已移入回收站。') : '已移入回收站');
    });
  });
}

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.resolve(PUBLIC_ROOT, relative);
  if (!isSameOrInside(file, PUBLIC_ROOT)) return json(res, 403, { error: 'forbidden' });
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.ico': 'image/x-icon',
  };
  fs.readFile(file, (error, data) => {
    if (error) return json(res, 404, { error: 'not found' });
    if (path.extname(file).toLowerCase() === '.html') {
      data = Buffer.from(data.toString('utf8').replace('__DISK_MANAGER_SESSION_TOKEN__', SESSION_TOKEN), 'utf8');
    }
    writeSecurityHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function handleRequest(req, res, server) {
  const currentPort = Number(server.address()?.port || DEFAULT_PORT);
  if (!validRequestHost(req, currentPort)) return json(res, 403, { error: '无效的本地服务主机名' });
  const url = new URL(req.url, `http://127.0.0.1:${currentPort}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!hasValidSessionToken(req)) return json(res, 401, { error: '本地会话已失效，请重新打开应用' });
      if (req.method === 'POST' && !validMutationOrigin(req, currentPort)) return json(res, 403, { error: '拒绝来自其他网页的操作请求' });
    }
    if (url.pathname === '/api/drives' && req.method === 'GET') {
      return json(res, 200, { drives: await Promise.all(['C', 'D'].map(getDriveInfo)) });
    }
    if (url.pathname === '/api/scan' && req.method === 'GET') {
      const drive = normalizeDrive(url.searchParams.get('drive'));
      return json(res, 200, await scanDrive(drive));
    }
    if (url.pathname === '/api/cache' && req.method === 'GET') {
      const drive = normalizeDrive(url.searchParams.get('drive'));
      return json(res, 200, scanCache.get(drive) || null);
    }
    if (url.pathname === '/api/level' && req.method === 'GET') {
      const target = url.searchParams.get('path');
      if (!target) return json(res, 400, { error: '缺少目录路径' });
      return json(res, 200, await scanDirectoryLevel(target));
    }
    if (url.pathname === '/api/ai/status' && req.method === 'GET') {
      return json(res, 200, await aiAnalyzer.getStatus());
    }
    if (url.pathname === '/api/ai/analyze' && req.method === 'POST') {
      const payload = await readJsonBody(req, 20000);
      if (!payload.path || typeof payload.path !== 'string') return json(res, 400, { error: '缺少要分析的文件夹路径' });
      const target = await fsp.realpath(path.resolve(payload.path));
      if (!isWithinManagedDrive(target)) return json(res, 403, { error: '只能分析 C 盘或 D 盘内的文件夹' });
      return json(res, 200, await aiAnalyzer.analyzeFolder(target));
    }
    if (url.pathname === '/api/ai/translate' && req.method === 'POST') {
      const payload = await readJsonBody(req, 5000);
      if (!payload.name || typeof payload.name !== 'string' || payload.name.length > 260) return json(res, 400, { error: '缺少有效的文件夹名称' });
      return json(res, 200, await aiAnalyzer.translateFolderName(payload.name));
    }
    if (url.pathname === '/api/recycle' && req.method === 'POST') {
      const payload = await readJsonBody(req, 10000);
      try {
        const target = payload.path;
        const message = await moveToRecycleBin(target, payload.confirmationToken);
        invalidateLevelCache(target);
        for (const [letter, data] of scanCache) {
          const definition = getCandidateDefinition(target);
          if (definition?.contentsOnly) {
            collectCandidates(letter).then(candidates => { data.candidates = candidates; persistScanCache(); }).catch(() => {});
          } else {
            data.candidates = data.candidates.filter(item => normalizedPath(item.path) !== normalizedPath(target));
          }
        }
        persistScanCache();
        return json(res, 200, { ok: true, message });
      } catch (error) {
        if (error.code === 'SAFE_CONFIRMATION_REQUIRED') {
          return json(res, 409, { error: error.message, code: error.code, requiresConfirmation: true, confirmationToken: error.confirmationToken });
        }
        return json(res, error.status || 400, { error: error.message });
      }
    }
    if (url.pathname === '/api/open' && req.method === 'POST') {
      const payload = await readJsonBody(req, 10000);
      const target = await fsp.realpath(path.resolve(payload.path));
      if (!isWithinManagedDrive(target)) return json(res, 403, { error: '只能打开 C 盘或 D 盘内的路径' });
      const stat = await fsp.stat(target);
      const args = stat.isDirectory() ? [target] : ['/select,', target];
      return execFile('explorer.exe', args, { windowsHide: false }, error => {
        if (error) return json(res, 400, { error: error.message });
        json(res, 200, { ok: true });
      });
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的请求方法' });
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    return json(res, error.status || 500, { error: error.message || '服务器错误' });
  }
}

function createServer() {
  let server;
  server = http.createServer((req, res) => handleRequest(req, res, server));
  return server;
}

function listenOnce(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(Number(server.address().port)); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function startServer(options = {}) {
  const preferredPort = Number(options.port ?? DEFAULT_PORT);
  let server = createServer();
  let port;
  try { port = await listenOnce(server, preferredPort); }
  catch (error) {
    if (error.code !== 'EADDRINUSE' || options.fallbackToRandom === false) throw error;
    server = createServer();
    port = await listenOnce(server, 0);
  }
  return { server, port, url: `http://127.0.0.1:${port}` };
}

loadPersistedCache();

if (require.main === module) {
  startServer({ fallbackToRandom: true }).then(service => {
    console.log(`磁盘空间管家已启动：${service.url}`);
    console.log('扫描为只读；清理默认仅处理白名单候选项，白名单外路径需二次确认后送入回收站。');
  }).catch(error => {
    console.error(`启动失败：${error.code === 'EADDRINUSE' ? `端口 ${DEFAULT_PORT} 已被占用` : error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  startServer,
  classifyCleanupTarget,
  isProtectedPath,
  isWithinManagedDrive,
  candidateDefinitions,
  normalizedPath,
  getSessionToken: () => SESSION_TOKEN,
};
