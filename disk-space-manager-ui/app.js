const state = { drive: 'C', data: null, level: null, path: 'C:\\', history: [], selected: null, drives: [] };
const levelCache = new Map();
let candidatePollTimer = null;
const $ = selector => document.querySelector(selector);
const sessionToken = document.querySelector('meta[name="disk-manager-token"]')?.content || '';
const formatBytes = bytes => {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const n = bytes / Math.pow(1024, i);
  return `${n.toFixed(i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
};
const esc = value => String(value).replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
const typeColor = type => ({ '视频':'video', '图片':'image', '压缩包':'archive', '代码':'code', '文档':'doc', '安装包/程序':'program', '临时文件':'temp', '缓存':'temp' }[type] || 'other');

async function getJson(url, options) {
  const requestOptions = { ...(options || {}), headers: { ...(options?.headers || {}), 'X-Disk-Manager-Token': sessionToken } };
  const response = await fetch(url, requestOptions);
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || '请求失败');
    Object.assign(error, payload);
    error.status = response.status;
    throw error;
  }
  return payload;
}
function setStatus(message, isError = false) { const el = $('#statusText'); el.textContent = message; el.classList.toggle('error', isError); }
function rootPath() { return `${state.drive}:\\`; }
function parentPath(target) {
  const normalized = target.replace(/[\\/]+$/, '');
  if (/^[A-Z]:$/i.test(normalized)) return normalized.toUpperCase() + '\\';
  const index = normalized.lastIndexOf('\\');
  return index <= 2 ? normalized.slice(0, 2) + '\\' : normalized.slice(0, index);
}

function renderDrives() {
  $('#driveCards').innerHTML = state.drives.map(drive => {
    const used = drive.total ? Math.round(drive.used / drive.total * 100) : 0;
    return `<article class="drive-card ${drive.letter === state.drive ? 'active' : ''}" data-drive="${drive.letter}" tabindex="0" role="button" aria-label="选择 ${drive.letter} 盘">
      <div class="drive-card-head"><div class="drive-name"><span class="drive-letter">${drive.letter}</span><div><strong>${drive.letter}盘</strong><small>${drive.total ? '本地磁盘' : '暂不可用'}</small></div></div><span class="drive-percent">${drive.total ? used + '%' : '—'}</span></div>
      <div class="meter"><div class="meter-fill" style="width:${Math.min(100, used)}%"></div></div>
      <div class="drive-foot"><span>已用 <b>${formatBytes(drive.used)}</b></span><span>可用 <b>${formatBytes(drive.free)}</b></span></div>
    </article>`;
  }).join('');
  document.querySelectorAll('.drive-card').forEach(card => {
    const choose = () => { state.drive = card.dataset.drive; state.data = null; state.level = null; state.path = rootPath(); state.history = []; state.selected = null; levelCache.clear(); renderDrives(); loadCacheOrScan(); };
    card.addEventListener('click', choose); card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') choose(); });
  });
}

function renderBreadcrumb() {
  const parts = state.path.split('\\').filter(Boolean);
  const root = `${parts.shift() || state.drive}:\\`;
  const items = [`<button type="button" data-breadcrumb="${esc(root)}">${esc(root)}</button>`];
  let built = root;
  for (const part of parts) { built = built.endsWith('\\') ? built + part : built + '\\' + part; items.push(`<span>›</span><button type="button" data-breadcrumb="${esc(built)}">${esc(part)}</button>`); }
  $('#breadcrumb').innerHTML = items.join('');
  document.querySelectorAll('[data-breadcrumb]').forEach(button => button.addEventListener('click', () => openLevel(button.dataset.breadcrumb, true)));
}

function sortedEntries() {
  // Empty folders and zero-byte files have no space footprint in the map.
  const entries = [...(state.level?.entries || [])].filter(item => Number(item.total || 0) > 0);
  return entries.sort((a, b) => $('#sortSelect').value === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : b.total - a.total);
}

function renderTreemap() {
  const allEntries = sortedEntries();
  const entries = allEntries.slice(0, 30);
  if (!entries.length) { $('#treemap').innerHTML = '<div class="empty">没有读取到可访问的内容，可能需要以管理员身份运行。</div>'; return; }
  const max = Math.max(...entries.map(item => item.total), 1);
  const parentTotal = /^[A-Z]:\\$/i.test(state.path) && Number(state.data?.info?.used || 0) > 0
    ? Number(state.data.info.used)
    : Object.values(state.level?.types || {}).reduce((sum, size) => sum + Number(size || 0), 0) || allEntries.reduce((sum, item) => sum + Number(item.total || 0), 0);
  $('#treemap').innerHTML = entries.map((item, index) => {
    const ratio = item.total / max;
    const columns = Math.max(2, Math.min(12, Math.round(2 + Math.sqrt(ratio) * 10)));
    const rows = Math.max(1, Math.min(4, Math.round(1 + Math.sqrt(ratio) * 3)));
    const kind = item.kind === 'directory' ? 'folder' : typeColor(Object.keys(item.types || {})[0] || '文件');
    const percentage = parentTotal > 0 ? item.total / parentTotal * 100 : 0;
    const percentageLabel = percentage > 0 && percentage < 1 ? '&lt;1%' : `${percentage >= 10 ? Math.round(percentage) : percentage.toFixed(1)}%`;
    const sizeClass = columns >= 9 || rows >= 3 ? 'tile-large' : columns >= 5 || rows >= 2 ? 'tile-medium' : 'tile-compact';
    return `<button type="button" class="treemap-item ${kind} ${sizeClass}" style="--cols:${columns};--rows:${rows}" data-entry-index="${index}" title="${esc(item.path)}\n${formatBytes(item.total)}"><span class="tile-percent">${percentageLabel}</span><strong>${esc(item.name)}</strong><small>${formatBytes(item.total)}</small></button>`;
  }).join('');
  document.querySelectorAll('[data-entry-index]').forEach(button => {
    const item = entries[Number(button.dataset.entryIndex)];
    button.addEventListener('click', () => selectEntry(item));
    button.addEventListener('dblclick', () => item.kind === 'directory' && openLevel(item.path));
  });
}

function renderDirectoryList() {
  const entries = sortedEntries().slice(0, 50);
  $('#directoryList').innerHTML = entries.map(item => `<div class="directory-row" data-list-index="${sortedEntries().indexOf(item)}"><button class="dir-name" type="button">${item.kind === 'directory' ? '▰' : '●'} ${esc(item.name)}</button><span class="dir-size">${formatBytes(item.total)}</span><span class="dir-files">${item.files ? item.files.toLocaleString() + ' 文件' : ''}</span></div>`).join('');
  document.querySelectorAll('[data-list-index]').forEach(row => {
    const item = sortedEntries()[Number(row.dataset.listIndex)];
    row.querySelector('button').addEventListener('click', () => selectEntry(item));
    row.querySelector('button').addEventListener('dblclick', () => item.kind === 'directory' && openLevel(item.path));
  });
}

function renderTypeSummary(types, total) {
  const rows = Object.entries(types || {}).sort((a, b) => b[1] - a[1]).slice(0, 7);
  $('#typeSummary').innerHTML = rows.length ? rows.map(([type, size]) => `<div class="type-row"><span class="type-dot ${typeColor(type)}"></span><span>${esc(type)}</span><b>${formatBytes(size)}</b><i><em style="width:${Math.max(3, size / Math.max(total, 1) * 100)}%"></em></i></div>`).join('') : '<p class="muted-line">暂无足够的文件类型数据。</p>';
}

function selectEntry(item) {
  state.selected = item;
  aiFolderPath = item.kind === 'directory' ? item.path : '';
  $('#detailFeedback').hidden = true;
  $('#detailFeedback').classList.remove('show');
  $('#addCleanBtn').disabled = false;
  $('#addCleanBtn').classList.remove('completed');
  $('#detailEmpty').hidden = true; $('#detailBody').hidden = false;
  $('#detailPath').textContent = item.path; $('#detailSize').textContent = formatBytes(item.total); $('#detailFiles').textContent = `${(item.files || 1).toLocaleString()} 个文件`;
  const isCandidate = /temp|cache|build|dist|bin|obj|node_modules|\.venv|target|\.zip$|\.rar$|\.7z$|\.iso$/i.test(item.path);
  $('#detailRisk').textContent = isCandidate ? '建议确认' : '人工判断'; $('#detailRisk').className = `risk ${isCandidate ? 'review' : 'manual'}`;
  $('#addCleanBtn').textContent = item.kind === 'directory' ? '移入回收站' : '移入回收站';
  renderTypeSummary(item.types, item.total);
  resetInlineAI(item);
  setStatus(`已选中 ${item.name} · 可查看详情、打开位置或移入回收站`);
}

function renderLevel() {
  renderBreadcrumb(); renderTreemap(); renderDirectoryList();
  const count = sortedEntries().length;
  $('#scanMeta').textContent = `${state.drive}盘 · ${count.toLocaleString()} 个项目 · 单击查看详情，双击目录下钻`;
  $('#upBtn').disabled = /^.:\\$/i.test(state.path);
}

async function openLevel(target, replace = false, force = false) {
  setStatus(`正在分析 ${target} 的内容…`);
  try {
    const key = target.toUpperCase();
    const level = !force && levelCache.has(key) ? levelCache.get(key) : await getJson(`/api/level?path=${encodeURIComponent(target)}`);
    levelCache.set(key, level);
    if (!replace && state.path !== target) state.history.push(state.path);
    state.path = target; state.level = level; state.selected = null; renderLevel(); setStatus(`已完成目录分析：${level.entries.length}${level.truncated ? '+' : ''} 个项目。`);
  } catch (error) { setStatus(error.message, true); }
}

async function scan() {
  $('#scanBtn').disabled = true; $('#scanBtn').innerHTML = `扫描 ${state.drive} 盘中… <span>·</span>`; setStatus(`正在扫描 ${state.drive} 盘，遇到无权限目录会自动跳过…`);
  try {
    state.data = await getJson(`/api/scan?drive=${state.drive}`);
    state.path = rootPath(); state.history = []; state.level = { path: state.path, entries: state.data.directories.map(item => ({ ...item, kind: 'directory' })), totalEntries: state.data.directories.length, types: {} };
    levelCache.set(state.path.toUpperCase(), state.level); renderLevel(); renderCandidates(); pollCandidates(); setStatus(`扫描完成：已统计 ${state.data.directories.length} 个一级目录，清理候选正在后台整理。`);
  } catch (error) { setStatus(error.message, true); }
  finally { $('#scanBtn').disabled = false; $('#scanBtn').innerHTML = '扫描当前磁盘 <span>→</span>'; }
}

async function loadCacheOrScan() {
  setStatus(`正在读取 ${state.drive} 盘最近一次结果…`);
  try {
    state.data = await getJson(`/api/cache?drive=${state.drive}`);
    if (!state.data) return scan();
    state.path = rootPath(); state.history = []; state.level = { path: state.path, entries: state.data.directories.map(item => ({ ...item, kind: 'directory' })), totalEntries: state.data.directories.length, types: {} };
    levelCache.set(state.path.toUpperCase(), state.level); renderLevel(); renderCandidates(); pollCandidates(); setStatus(`已显示 ${state.drive} 盘最近一次扫描结果。`);
  } catch (error) { setStatus(error.message, true); }
}

function pollCandidates() {
  clearInterval(candidatePollTimer);
  if (state.data?.candidateState !== 'scanning') return;
  let attempts = 0;
  candidatePollTimer = setInterval(async () => {
    attempts += 1;
    try {
      const latest = await getJson(`/api/cache?drive=${state.drive}`);
      if (latest) { state.data = latest; renderCandidates(); }
      if (latest?.candidateState !== 'scanning' || attempts >= 40) clearInterval(candidatePollTimer);
    } catch (_) { if (attempts >= 40) clearInterval(candidatePollTimer); }
  }, 1200);
}

function renderCandidates() {
  const list = state.data?.candidates || [];
  $('#candidateCount').textContent = `${list.length} 项`;
  $('#candidateList').innerHTML = list.length ? list.map(item => {
    const actionLabel = item.contentsOnly ? '清理可用内容 →' : '移入回收站 →';
    return `<div class="candidate" data-candidate-path="${esc(item.path)}"><div class="candidate-icon">✦</div><div><strong>${esc(item.label)}</strong><p>${esc(item.description)}<br><span title="${esc(item.path)}">${esc(item.path)}</span></p><button class="recycle" data-path="${esc(item.path)}" data-contents-only="${item.contentsOnly ? '1' : '0'}">${actionLabel}</button></div><div class="candidate-size">${formatBytes(item.total)}</div></div>`;
  }).join('') : state.data?.candidateState === 'scanning' ? '<div class="empty">正在整理缓存、压缩包和项目残留候选…</div>' : '<div class="empty">暂未发现可安全关注的缓存项目。</div>';
  document.querySelectorAll('.candidate').forEach(card => card.addEventListener('click', event => {
    if (event.target.closest('.recycle')) return;
    const item = list.find(candidate => candidate.path.toUpperCase() === card.dataset.candidatePath.toUpperCase());
    if (item) selectEntry({ ...item, name: item.label, kind: 'directory' });
  }));
  document.querySelectorAll('.recycle').forEach(button => button.addEventListener('click', () => recyclePath(button.dataset.path, false, button)));
}

let aiFolderPath = '';
function resetInlineAI(item) {
  const isFolder = item?.kind === 'directory' && Boolean(aiFolderPath);
  $('#aiInline').hidden = !isFolder;
  $('#aiAnalyzeBtn').disabled = !isFolder;
  $('#aiTranslateBtn').disabled = !isFolder;
  $('#aiProvider').textContent = '本地模式';
  $('#aiStatus').textContent = isFolder ? '当前文件夹已就绪。' : '请选择一个文件夹后使用 AI 功能。';
  $('#aiTranslatedName').hidden = true;
  $('#aiTranslatedName').textContent = '';
  $('#aiReport').innerHTML = '<div class="empty">点击“分析此文件夹”，判断当前目录是游戏、应用、媒体、缓存还是其他类型。</div>';
}

function renderAIReport(payload) {
  const analysis = payload.analysis || {};
  $('#aiProvider').textContent = analysis.provider || '本地分析';
  const source = analysis.source || '来源暂时无法确定';
  const type = analysis.folderType || '文件夹类型暂时无法确定';
  const conclusion = analysis.conclusion || analysis.purpose || analysis.summary || '暂无明确结论。';
  $('#aiReport').innerHTML = `<div class="ai-origin-card"><span>来源判断</span><strong>${esc(source)}</strong><em>${esc(type)}</em></div><div class="ai-conclusion"><h3>一句话说明</h3><p>${esc(conclusion)}</p></div><div class="ai-meta">扫描 ${Number(payload.stats?.files || 0).toLocaleString()} 个文件 · ${esc(payload.stats?.totalSize || '0 B')} · 置信度 ${Math.round(Number(analysis.confidence || 0) * 100)}%</div>`;
}

async function analyzeCurrentFolder() {
  if (!aiFolderPath) return;
  $('#aiAnalyzeBtn').disabled = true;
  $('#aiTranslateBtn').disabled = true;
  $('#aiStatus').textContent = '正在分析当前文件夹，文件内容不会上传…';
  $('#aiReport').innerHTML = '<div class="empty">正在分析，请稍候。大文件夹可能需要一点时间。</div>';
  try {
    const result = await getJson('/api/ai/analyze', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ path: aiFolderPath }) });
    renderAIReport(result);
    $('#aiStatus').textContent = '分析完成。';
    setStatus(`AI 已完成文件夹分析：${aiFolderPath}`);
  } catch (error) {
    $('#aiStatus').textContent = error.message;
    $('#aiReport').innerHTML = `<div class="empty">分析失败：${esc(error.message)}</div>`;
    setStatus(error.message, true);
  } finally {
    $('#aiAnalyzeBtn').disabled = false;
    $('#aiTranslateBtn').disabled = false;
  }
}

async function translateCurrentFolder() {
  if (!state.selected || !aiFolderPath) return;
  $('#aiTranslateBtn').disabled = true;
  $('#aiStatus').textContent = '正在翻译文件夹名称…';
  try {
    const result = await getJson('/api/ai/translate', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ name: state.selected.name }) });
    $('#aiTranslatedName').textContent = result.translatedName || state.selected.name;
    $('#aiTranslatedName').hidden = false;
    $('#aiProvider').textContent = result.provider || '本地翻译';
    $('#aiStatus').textContent = '文件夹名称翻译完成。';
  } catch (error) {
    $('#aiStatus').textContent = error.message;
    setStatus(error.message, true);
  } finally {
    $('#aiTranslateBtn').disabled = false;
  }
}

async function recyclePath(target, manual, button) {
  const label = state.selected?.path === target ? target : target;
  if (!confirm(`确认把以下项目移入回收站吗？\n\n${label}\n\n${manual ? '这是一个人工选择的目录，请确认路径无误。' : '这是系统识别的清理候选。'}`)) return;
  const selectedTarget = state.selected?.path?.toUpperCase() === target.toUpperCase();
  if (!button && manual) button = $('#addCleanBtn');
  if (button) { button.disabled = true; button.textContent = '处理中…'; }
  try {
    const requestRecycle = confirmationToken => getJson('/api/recycle', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ path:target, confirmationToken }) });
    let recycleResult;
    try {
      recycleResult = await requestRecycle(null);
    } catch (error) {
      if (error.code !== 'SAFE_CONFIRMATION_REQUIRED') throw error;
      const forceConfirmed = confirm(`安全提醒：该文件不在安全清理白名单中。\n\n${label}\n\n强制清理会将它移入回收站，可能影响程序运行或文件数据。\n\n是否确认强制清除？`);
      if (!forceConfirmed) {
        if (button) { button.disabled = false; button.textContent = button.dataset.contentsOnly === '1' ? '清理可用内容 →' : '移入回收站 →'; }
        setStatus('已取消强制清理。');
        return;
      }
      recycleResult = await requestRecycle(error.confirmationToken);
    }
    if (state.data) state.data.candidates = state.data.candidates.filter(item => item.path.toUpperCase() !== target.toUpperCase());
    renderCandidates();
    const targetUpper = target.toUpperCase();
    const currentUpper = state.path.toUpperCase();
    if (currentUpper === targetUpper || currentUpper.startsWith(`${targetUpper}\\`)) state.path = parentPath(target);
    const currentParent = parentPath(target).toUpperCase();
    levelCache.delete(currentParent); levelCache.delete(state.path.toUpperCase());
    if (currentParent === state.path.toUpperCase() || state.path.toUpperCase() === targetUpper) await openLevel(state.path, true, true);
    if (selectedTarget) {
      const partiallySkipped = recycleResult.message?.includes('skipped') || recycleResult.message?.includes('正在使用');
      $('#detailFeedbackText').textContent = partiallySkipped ? '可处理内容已移入回收站，部分占用文件已跳过 ✅' : '该文件夹已移入回收站 ✅';
      $('#detailFeedback').hidden = false;
      $('#detailFeedback').classList.remove('show');
      void $('#detailFeedback').offsetWidth;
      $('#detailFeedback').classList.add('show');
      $('#addCleanBtn').disabled = true;
      $('#addCleanBtn').classList.add('completed');
      $('#addCleanBtn').textContent = '已完成 ✓';
      $('#detailRisk').textContent = '已完成';
      $('#detailRisk').className = 'risk safe';
    }
    const payload = await getJson('/api/drives'); state.drives = payload.drives; renderDrives();
    setStatus(recycleResult.message || '已移入回收站，当前空间地图和容量已刷新。');
  }
  catch (error) { if (button) { button.disabled = false; button.textContent = button.dataset.contentsOnly === '1' ? '清理可用内容 →' : '移入回收站 →'; } setStatus(error.message, true); }
}

$('#scanBtn').addEventListener('click', scan);
$('#aiAnalyzeBtn').addEventListener('click', analyzeCurrentFolder);
$('#aiTranslateBtn').addEventListener('click', translateCurrentFolder);
$('#refreshBtn')?.addEventListener('click', async () => { try { const payload = await getJson('/api/drives'); state.drives = payload.drives; renderDrives(); setStatus('磁盘容量已刷新。'); } catch (error) { setStatus(error.message, true); } });
$('#sortSelect').addEventListener('change', () => { if (state.level) { renderTreemap(); renderDirectoryList(); } });
$('#upBtn').addEventListener('click', () => openLevel(parentPath(state.path), true));
$('#openBtn').addEventListener('click', async () => { if (!state.selected) return; try { await getJson('/api/open', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ path:state.selected.path }) }); setStatus('已打开文件位置。'); } catch (error) { setStatus(error.message, true); } });
$('#addCleanBtn').addEventListener('click', () => { if (state.selected) recyclePath(state.selected.path, true); });
document.addEventListener('keydown', event => { if (event.target.matches('input,select,textarea')) return; if (event.key.toLowerCase() === 'c') { state.drive = 'C'; loadCacheOrScan(); } if (event.key.toLowerCase() === 'd') { state.drive = 'D'; loadCacheOrScan(); } if (event.key.toLowerCase() === 's') scan(); });

getJson('/api/drives').then(payload => { state.drives = payload.drives; renderDrives(); }).catch(error => { $('#serverState')?.classList.add('error'); setStatus(error.message, true); });

// 从“草稿-便携版”移植的 Grainient 背景：用 WebGL 绘制缓慢流动的紫粉渐变和细颗粒。
function initGrainient() {
  const host = $('#grainientBackground');
  const canvas = $('#grainientCanvas');
  if (!host || !canvas) return;
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: false });
  if (!gl) { host.classList.add('no-webgl'); return; }

  const vertexSource = `#version 300 es
    in vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;
  const fragmentSource = `#version 300 es
    precision highp float;
    uniform vec2 iResolution;
    uniform float iTime;
    out vec4 fragColor;
    #define S(a,b,t) smoothstep(a,b,t)
    mat2 Rot(float a) { float s = sin(a), c = cos(a); return mat2(c,-s,s,c); }
    vec2 hash(vec2 p) { p = vec2(dot(p, vec2(2127.1,81.17)), dot(p, vec2(1269.5,283.37))); return fract(sin(p) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
      return 0.5 + 0.5 * mix(mix(dot(-1.0 + 2.0 * hash(i), f), dot(-1.0 + 2.0 * hash(i + vec2(1.0,0.0)), f - vec2(1.0,0.0)), u.x), mix(dot(-1.0 + 2.0 * hash(i + vec2(0.0,1.0)), f - vec2(0.0,1.0)), dot(-1.0 + 2.0 * hash(i + vec2(1.0,1.0)), f - vec2(1.0,1.0)), u.x), u.y);
    }
    void main() {
      float t = iTime * 0.48;
      vec2 uv = gl_FragCoord.xy / iResolution.xy;
      float ratio = iResolution.x / iResolution.y;
      vec2 p = uv - 0.5;
      p.y /= ratio;
      float degree = noise(vec2(t * 0.1, p.x * p.y) * 2.0);
      p *= Rot(radians((degree - 0.5) * 500.0 + 180.0));
      p.y *= ratio;
      p.x += sin(p.y * 5.0 + t * 2.0) / 50.0;
      p.y += sin(p.x * 7.5 + t * 2.0) / 25.0;
      float blend = S(-0.35, 0.25, p.x);
      float vertical = S(0.5, -0.35, p.y);
      vec3 dark = vec3(0.055, 0.020, 0.14);
      vec3 indigo = vec3(0.322, 0.153, 1.0);
      vec3 pink = vec3(1.0, 0.624, 0.988);
      vec3 col = mix(mix(dark, indigo, blend), mix(indigo, pink, blend), vertical);
      vec2 grainUv = uv * 2.0;
      float grain = fract(sin(dot(grainUv, vec2(12.9898,78.233))) * 43758.5453);
      col += (grain - 0.5) * 0.1;
      col = (col - 0.5) * 1.5 + 0.5;
      col = clamp(col, 0.0, 1.0);
      fragColor = vec4(col, 1.0);
    }
  `;
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  try {
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'position');
    const resolution = gl.getUniformLocation(program, 'iResolution');
    const time = gl.getUniformLocation(program, 'iTime');
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = host.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(program); gl.uniform2f(resolution, canvas.width, canvas.height);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host); resize();
    gl.useProgram(program); gl.enableVertexAttribArray(position); gl.bindBuffer(gl.ARRAY_BUFFER, buffer); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const start = performance.now();
    const render = now => {
      gl.useProgram(program); gl.uniform1f(time, (now - start) / 1000); gl.drawArrays(gl.TRIANGLES, 0, 3); requestAnimationFrame(render);
    };
    requestAnimationFrame(render);
  } catch (error) {
    host.classList.add('no-webgl');
    console.warn('Grainient background unavailable:', error);
  }
}

initGrainient();
