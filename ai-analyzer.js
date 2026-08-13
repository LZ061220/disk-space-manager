const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const MAX_FILES = 1800;
const MAX_DEPTH = 8;
const SKIP_NAMES = new Set(['.git', '.svn', '.hg', 'node_modules', '__pycache__', '$recycle.bin', 'system volume information']);
let localServer = null;
let localServerPromise = null;
function stopLocalServer() {
  if (localServer && !localServer.killed) localServer.kill();
  localServer = null;
  localServerPromise = null;
}
process.once('exit', stopLocalServer);
process.once('SIGINT', () => { stopLocalServer(); process.exit(0); });
process.once('SIGTERM', () => { stopLocalServer(); process.exit(0); });

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const n = bytes / Math.pow(1024, i);
  return `${n.toFixed(i === 0 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function typeForExtension(name) {
  const ext = path.extname(name).toLowerCase();
  const groups = {
    code: new Set(['.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.php', '.html', '.css', '.vue']),
    document: new Set(['.txt', '.md', '.doc', '.docx', '.pdf', '.rtf', '.xls', '.xlsx', '.ppt', '.pptx', '.csv']),
    image: new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.psd', '.ico']),
    video: new Set(['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm']),
    audio: new Set(['.mp3', '.wav', '.flac', '.aac', '.m4a', '.ogg']),
    archive: new Set(['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.iso']),
    program: new Set(['.exe', '.msi', '.appx', '.dll', '.sys']),
    data: new Set(['.json', '.xml', '.yaml', '.yml', '.db', '.sqlite', '.sql', '.dat', '.bin']),
  };
  for (const [type, extensions] of Object.entries(groups)) if (extensions.has(ext)) return type;
  return ext ? 'other' : 'no-extension';
}

async function collectFolderSummary(target) {
  const root = path.resolve(target);
  const stat = await fsp.stat(root);
  if (!stat.isDirectory()) throw new Error('请选择一个文件夹');
  const typeStats = new Map();
  const extensionStats = new Map();
  const topFolders = new Map();
  const samples = [];
  const queue = [{ dir: root, depth: 0 }];
  let files = 0;
  let directories = 0;
  let totalBytes = 0;
  let skipped = 0;

  while (queue.length && files < MAX_FILES) {
    const current = queue.shift();
    let handle;
    try {
      handle = await fsp.opendir(current.dir);
      for await (const entry of handle) {
        if (files >= MAX_FILES) break;
        if (SKIP_NAMES.has(entry.name.toLowerCase())) { skipped += 1; continue; }
        const full = path.join(current.dir, entry.name);
        if (entry.isDirectory()) {
          directories += 1;
          if (current.depth < MAX_DEPTH) queue.push({ dir: full, depth: current.depth + 1 });
          continue;
        }
        if (!entry.isFile()) continue;
        try {
          const fileStat = await fsp.stat(full);
          const kind = typeForExtension(entry.name);
          const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)';
          const firstFolder = path.relative(root, full).split(path.sep)[0] || entry.name;
          const record = typeStats.get(kind) || { count: 0, bytes: 0 };
          record.count += 1; record.bytes += fileStat.size; typeStats.set(kind, record);
          extensionStats.set(ext, (extensionStats.get(ext) || 0) + 1);
          topFolders.set(firstFolder, (topFolders.get(firstFolder) || 0) + fileStat.size);
          totalBytes += fileStat.size; files += 1;
          if (samples.length < 80) samples.push(path.relative(root, full));
        } catch (_) {}
      }
    } catch (_) {
      skipped += 1;
    } finally {
      try { await handle?.close(); } catch (_) {}
    }
  }

  return {
    root,
    files,
    directories,
    totalBytes,
    totalSize: formatBytes(totalBytes),
    truncated: files >= MAX_FILES,
    skipped,
    types: Object.fromEntries([...typeStats.entries()].sort((a, b) => b[1].bytes - a[1].bytes)),
    extensions: Object.fromEntries([...extensionStats.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)),
    topFolders: Object.fromEntries([...topFolders.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)),
    samples,
  };
}

function requestJson(port, requestPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    let timer;
    const request = http.request({ hostname: '127.0.0.1', port, path: requestPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(data);
          if (response.statusCode >= 400) return reject(new Error(parsed.error || `本地模型请求失败（${response.statusCode}）`));
          resolve(parsed);
        } catch (_) { reject(new Error('本地模型返回了无效结果')); }
      });
    });
    timer = setTimeout(() => request.destroy(new Error('本地模型响应超时')), 30000);
    request.on('error', reject); request.end(body);
  });
}

function waitForLocalServer(port) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: '/health' }, response => {
      response.resume();
      if (response.statusCode >= 200 && response.statusCode < 300) resolve(true);
      else reject(new Error(`本地模型尚未就绪（${response.statusCode}）`));
    });
    request.setTimeout(3000, () => request.destroy(new Error('本地模型健康检查超时')));
    request.on('error', reject);
  });
}

function parseModelJson(text) {
  const raw = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (process.env.DISK_MANAGER_AI_DEBUG) console.error('model raw:', raw);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('本地模型没有返回 JSON');
  return JSON.parse(raw.slice(start, end + 1));
}

function uniqueItems(items) {
  return [...new Set((items || []).map(item => String(item || '').trim()).filter(Boolean))];
}

function buildRuleProfile(summary) {
  const folderName = path.basename(summary.root);
  const lowerName = folderName.toLowerCase();
  const sampleText = (summary.samples || []).join(' ').toLowerCase();
  const haystack = `${lowerName} ${sampleText}`;
  const typeStats = summary.types || {};
  const extensions = summary.extensions || {};
  const has = type => Boolean(typeStats[type]?.count);
  const hasExt = (...names) => names.some(name => Boolean(extensions[name]));
  const evidence = [];
  let folderType = '混合资料目录';
  let source = '来源暂时无法确定';
  let purpose = '这是一个内容混合的文件夹，暂时无法仅凭目录结构确定唯一用途。';
  let riskLevel = '需要确认';
  let confidence = 0.58;
  let residualPossibility = '暂时无法确认是否为软件残留，建议结合最近修改时间和对应程序是否仍安装来判断。';
  let startupPossibility = '未发现明显的开机启动目录或启动脚本信号。';
  let conclusion = '当前证据不足，建议结合文件夹名称、最近修改时间和文件来源进一步判断。';
  let safeAction = '先查看分析依据和最近修改时间，再决定是否处理。';
  let doNotDelete = '不要直接删除名称和用途不明确的文件。';
  let suggestions = [];
  let strong = false;

  const gameName = /(overwatch|steam|epic|游戏|game|games|genshin|wuthering|minecraft|valorant|league|lol|pubg|elden ring|cyberpunk)/i.test(haystack);
  const gameResource = gameName || hasExt('.pak', '.assets', '.bundle', '.unity3d', '.usm') || (has('program') && has('data') && has('other') && summary.totalBytes > 2 * 1024 * 1024 * 1024);
  const systemFolder = /(^|\\)(windows|system32|program files|program files \(x86\)|programdata|system volume information)(\\|$)/i.test(summary.root);
  const media = (has('image') || has('video') || has('audio')) && !has('code');
  const startup = /(startup|开机启动|启动项|autorun|start menu|开始菜单|快捷方式)/i.test(haystack) || hasExt('.lnk', '.url', '.autorun', '.bat', '.cmd', '.vbs');
  const cache = /(cache|缓存|temp|temporary|临时|crash|dump|logs?|日志|shadercache|webcache)/i.test(haystack) || hasExt('.tmp', '.cache', '.log', '.dmp');
  const developer = has('code') || hasExt('.sln', '.csproj', '.vcxproj', '.gitignore', '.json', '.yaml', '.yml');
  const software = has('program') && (has('data') || hasExt('.config', '.ini', '.json', '.manifest'));
  const documents = has('document') && !media && !gameResource;

  if (systemFolder) {
    folderType = 'Windows 系统或系统组件目录';
    source = 'Windows 操作系统';
    purpose = '该目录位于 Windows 系统目录或系统软件目录中，通常由系统组件、驱动或已安装程序使用。';
    conclusion = '这个文件夹更可能来自 Windows 系统或系统级软件，不应当作为普通应用残留处理。';
    evidence.push('路径位于 Windows、Program Files 或 ProgramData 等系统目录');
    riskLevel = '高风险';
    confidence = 0.95;
    strong = true;
  } else if (startup) {
    folderType = '疑似启动程序或快捷方式目录';
    source = '某个应用程序或 Windows 启动目录';
    purpose = '目录中出现了启动目录、快捷方式或脚本相关信号，可能用于开机启动、快速启动或自动运行。';
    evidence.push('发现启动目录、快捷方式或脚本相关名称/扩展名');
    riskLevel = '高风险';
    confidence = 0.84;
    startupPossibility = '存在启动项可能性。删除前应先确认它是否与开机启动、托盘程序或快捷方式有关。';
    residualPossibility = '如果对应软件已经卸载，这个目录可能是启动残留；但不能仅凭名称直接删除。';
    conclusion = '这个目录更像启动程序、快捷方式或自动运行脚本相关目录，清理前必须确认它是否仍被系统或软件使用。';
    safeAction = '优先核对启动项来源、快捷方式目标和对应程序，再处理无效链接或已确认的残留。';
    doNotDelete = '不要直接删除仍指向有效程序的快捷方式、脚本或启动配置。';
    suggestions = ['先确认目录中的快捷方式或脚本指向哪个程序。', '在任务管理器“启动应用”或系统启动目录中核对对应项目。', '如果程序仍在使用，建议从软件设置中关闭开机启动，不要直接删除文件。', '只有确认目标程序已卸载且没有启动引用后，才考虑移入回收站。'];
    strong = true;
  } else if (gameResource) {
    folderType = '疑似游戏安装或游戏资源目录';
    if (/overwatch/i.test(haystack)) source = '暴雪 Battle.net / 守望先锋';
    else if (/steam/i.test(haystack)) source = 'Steam 游戏平台';
    else if (/wuthering/i.test(haystack)) source = '库洛游戏 / 鸣潮';
    else if (/genshin/i.test(haystack)) source = '米哈游 / 原神';
    else if (/minecraft/i.test(haystack)) source = 'Minecraft 游戏';
    else source = '某个游戏平台或游戏安装程序';
    purpose = '该目录很可能是游戏安装目录或游戏资源目录，包含大量二进制资源、程序文件和数据文件。';
    evidence.push('文件夹名称或文件样本包含游戏名称信号');
    if (hasExt('.pak', '.assets', '.bundle', '.unity3d', '.usm')) evidence.push('发现 .pak、.assets、.bundle 等常见游戏资源文件');
    if (has('program') || has('data')) evidence.push(`包含程序文件 ${typeStats.program?.count || 0} 个、数据文件 ${typeStats.data?.count || 0} 个`);
    riskLevel = '谨慎处理';
    confidence = gameName ? 0.92 : 0.78;
    residualPossibility = '仅凭目录结构无法确认是否为卸载残留；如果目录中仍有主程序或游戏平台记录，它更可能是正在使用的游戏目录。';
    startupPossibility = '当前没有足够证据表明它是开机启动目录；游戏启动器或更新器仍可能在其他位置注册启动项。';
    conclusion = '这个目录更可能是正在使用的游戏安装/资源目录，而不是普通软件残留；不要因为占用空间大就直接删除。';
    safeAction = '可以优先检查 cache、logs、crash、shadercache 等明确的缓存和日志子目录。';
    doNotDelete = '不要直接删除 pak、assets、bundle、dll、bin、data 等游戏资源和运行文件。';
    suggestions = ['这更像游戏安装/资源目录，不建议直接删除整个文件夹。', '优先使用游戏平台或游戏自带卸载功能，避免破坏卸载记录。', '可以重点检查明确命名为 cache、logs、crash、shadercache 的子目录。', '如果怀疑是卸载残留，请先确认游戏已卸载、没有对应快捷方式和后台进程，再移入回收站测试。'];
    strong = true;
  } else if (media) {
    folderType = '疑似媒体素材或个人媒体库';
    source = '个人媒体资料或媒体处理软件';
    purpose = '该目录主要由图片、视频或音频组成，可能是照片、视频素材、录音或媒体缓存。';
    evidence.push('图片、视频或音频文件占主要比例');
    riskLevel = '谨慎处理';
    confidence = 0.88;
    residualPossibility = '如果目录位于播放器、剪辑软件或浏览器目录下，可能包含媒体缓存；如果位于个人目录，则更可能是原始素材。';
    startupPossibility = '未发现明显启动程序信号。';
    conclusion = '这个目录更像媒体素材或个人媒体库，清理前应先区分原始文件、备份文件和可再生成的缓存。';
    safeAction = '优先检查重复文件、缩略图、代理文件、临时导出和缓存目录。';
    doNotDelete = '不要直接删除原始照片、视频、音频或唯一备份。';
    suggestions = ['先确认这些媒体是否还有备份或正在被剪辑软件使用。', '可以按最近修改时间和文件大小检查重复素材。', '只建议清理明确的缓存、代理文件、缩略图和临时导出目录。', '不要仅因为文件夹占用空间大就删除原始照片、视频或音频。'];
    strong = true;
  } else if (cache) {
    folderType = '疑似缓存、日志或临时文件目录';
    source = '某个应用程序产生的缓存或日志';
    purpose = '目录名称或文件扩展名表现出缓存、日志、崩溃转储或临时文件特征。';
    evidence.push('发现 cache、temp、log、dump 等名称或扩展名');
    riskLevel = '相对低风险';
    confidence = 0.82;
    residualPossibility = '可能是软件运行产生的缓存，也可能是已经卸载软件留下的残留，需要确认对应程序是否仍存在。';
    startupPossibility = '未发现明显启动程序信号。';
    conclusion = '这个目录具有缓存、日志或临时文件特征，通常比普通资料目录更适合进一步检查，但仍不能把所有文件都视为可删除。';
    safeAction = '优先处理明确的日志、崩溃转储、临时文件和缓存内容，保留目录本身。';
    doNotDelete = '不要删除用途不明的 DLL、EXE、配置文件或仍被占用的文件。';
    suggestions = ['先关闭可能正在使用该目录的软件，再检查文件是否仍被占用。', '优先清理日志、崩溃转储、缩略图和缓存内容，保留目录本身。', '如果对应软件已经卸载，可以重点检查该目录是否只剩旧缓存。', '不要删除名称不明确的 DLL、EXE 或配置文件。'];
    strong = true;
  } else if (developer) {
    folderType = '疑似开发项目或软件工程目录';
    source = '开发工具或程序员项目';
    purpose = '目录包含代码、工程配置或依赖相关文件，可能是开发项目、源码仓库或构建目录。';
    evidence.push('发现代码文件或工程配置文件');
    riskLevel = '谨慎处理';
    confidence = 0.86;
    residualPossibility = '构建产物和依赖目录可能是可再生成的，但源码、配置和版本控制文件通常不是残留。';
    startupPossibility = '未发现明显启动程序信号。';
    conclusion = '这个目录更像开发项目或软件工程目录，构建产物可能可以清理，但源码和配置文件不应当按残留处理。';
    safeAction = '优先检查 build、dist、bin、obj、node_modules、缓存和虚拟环境目录。';
    doNotDelete = '不要直接删除源码、README、配置文件、许可证和版本控制文件。';
    suggestions = ['保留源码、README、配置文件和版本控制目录。', '可以重点检查 node_modules、bin、obj、dist、build、缓存和虚拟环境目录。', '删除构建目录前，确认项目可以重新构建并且没有未备份的产物。', '不要把所有 DLL、EXE 或 bin 目录都判定为残留。'];
    strong = true;
  } else if (software) {
    folderType = '疑似软件安装或应用数据目录';
    source = `${folderName} 应用程序`;
    purpose = '目录包含程序文件和配置/数据文件，可能是已安装软件、便携软件或应用数据目录。';
    evidence.push('同时发现程序文件和配置/数据文件');
    riskLevel = '谨慎处理';
    confidence = 0.79;
    residualPossibility = '有可能是已卸载软件的残留，也可能是当前仍在使用的便携软件或应用数据。';
    startupPossibility = '需要进一步检查是否存在启动器、托盘程序或快捷方式，当前不能直接判断。';
    conclusion = '这个目录可能是软件安装目录、便携软件目录或应用数据目录，当前不能仅凭占用空间判断为残留。';
    safeAction = '先确认软件是否仍能启动、是否出现在应用列表和开始菜单，再考虑处理。';
    doNotDelete = '不要直接删除仍在使用的软件目录、卸载组件、配置文件和用户数据。';
    suggestions = ['先确认软件是否仍能从开始菜单、桌面快捷方式或任务管理器中找到。', '优先使用系统“应用和功能”卸载，不建议直接删除安装目录。', '如果确认是残留，可先移入回收站观察一段时间，不要永久删除。', '重点检查 uninstall、unins、logs、cache 等明确残留特征。'];
    strong = true;
  } else if (documents) {
    folderType = '疑似文档资料目录';
    source = '用户文档或办公软件';
    purpose = '目录主要由文档、表格、演示文稿或文本资料组成。';
    evidence.push('文档类文件占主要比例');
    riskLevel = '高风险';
    confidence = 0.85;
    residualPossibility = '不建议把普通文档目录当作软件残留处理。';
    startupPossibility = '未发现明显启动程序信号。';
    conclusion = '这个目录更像文档资料目录，不应按软件残留或缓存目录直接清理。';
    safeAction = '优先检查重复副本、临时导出文件和已经确认无用的旧版本。';
    doNotDelete = '不要删除没有备份的个人文档、表格、照片说明或项目资料。';
    suggestions = ['先确认文档是否已经备份或同步到其他位置。', '可以清理明确的临时导出文件和重复副本。', '不要根据文件夹名称或占用空间直接删除个人资料。'];
    strong = true;
  }

  return { folderType, source, purpose, evidence, riskLevel, confidence, residualPossibility, startupPossibility, conclusion, safeAction, doNotDelete, suggestions, strong };
}

function enrichAnalysis(summary, result) {
  const profile = buildRuleProfile(summary);
  const modelSuggestions = profile.strong ? [] : [...(result.suggestions || []), ...(result.cleanupAdvice || [])];
  const mergedSuggestions = uniqueItems([...(profile.suggestions || []), ...modelSuggestions]).slice(0, 7);
  const mergedEvidence = uniqueItems([...(profile.evidence || []), ...(result.evidence || [])]).slice(0, 6);
  const profileSummary = `${profile.purpose} 当前目录共 ${Number(summary.files || 0).toLocaleString()} 个文件、${Number(summary.directories || 0).toLocaleString()} 个子目录，占用约 ${summary.totalSize || '0 B'}。`;
  return {
    ...result,
    folderType: profile.strong ? profile.folderType : (result.folderType || profile.folderType),
    source: profile.strong ? profile.source : (result.source || profile.source),
    purpose: profile.strong ? profile.purpose : (result.purpose || profile.purpose),
    summary: profile.strong ? profileSummary : (result.summary || profileSummary),
    evidence: mergedEvidence,
    riskLevel: profile.riskLevel,
    residualPossibility: profile.residualPossibility,
    startupPossibility: profile.startupPossibility,
    conclusion: profile.strong ? profile.conclusion : (result.conclusion || profile.conclusion),
    safeAction: profile.safeAction,
    doNotDelete: profile.doNotDelete,
    suggestions: mergedSuggestions,
    cleanupAdvice: mergedSuggestions,
    confidence: Math.max(Number(result.confidence || 0), profile.confidence),
    importantFiles: uniqueItems(result.importantFiles || []).slice(0, 12),
  };
}

function heuristicAnalyze(summary) {
  const profile = buildRuleProfile(summary);
  const typeStats = summary.types || {};
  const hasCode = Boolean(typeStats.code);
  const hasDocs = Boolean(typeStats.document);
  const hasMedia = Boolean(typeStats.image || typeStats.video || typeStats.audio);
  const hasArchives = Boolean(typeStats.archive);
  const hasPrograms = Boolean(typeStats.program);
  const folderName = path.basename(summary.root);
  let folderType = '混合文件夹';
  if (hasCode && hasDocs) folderType = '软件项目或开发资料';
  else if (hasCode) folderType = '代码项目';
  else if (hasMedia && !hasCode) folderType = '媒体资料或个人素材';
  else if (hasDocs && !hasMedia) folderType = '文档资料';
  else if (hasArchives && hasPrograms) folderType = '安装包与备份文件';
  else if (hasArchives) folderType = '压缩包或备份目录';
  else if (hasPrograms) folderType = '程序文件目录';
  const typeRows = Object.entries(typeStats).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);
  const categories = typeRows.map(([name, value]) => ({ name: ({ code: '代码', document: '文档', image: '图片', video: '视频', audio: '音频', archive: '压缩包', program: '程序', data: '数据', other: '其他', 'no-extension': '无扩展名' }[name] || name), count: value.count, size: formatBytes(value.bytes) }));
  const suggestions = [];
  if (hasArchives) suggestions.push('检查长期未使用的压缩包和镜像文件，确认后再清理。');
  if (summary.extensions['.tmp'] || summary.extensions['.cache']) suggestions.push('可以重点检查临时文件和缓存文件。');
  if (summary.extensions['.log']) suggestions.push('日志文件较多时，可按时间保留近期日志。');
  if (hasCode) suggestions.push('代码项目建议保留 README、配置文件和源码，谨慎处理构建目录。');
  if (!suggestions.length) suggestions.push('建议按文件类型和最近修改时间逐项检查，不要直接删除未知文件。');
  return {
    ...profile,
    folderType: profile.strong ? profile.folderType : folderType,
    purpose: profile.purpose,
    summary: `“${folderName}”共包含 ${summary.files.toLocaleString()} 个文件、${summary.directories.toLocaleString()} 个子目录，占用约 ${summary.totalSize}。用途初步判断为：${profile.folderType}。主要内容为${categories.slice(0, 3).map(item => item.name).join('、') || '未知类型'}。`,
    categories,
    importantFiles: summary.samples.filter(item => /(^|[\\/])(readme|license|package\.json|requirements\.txt|\.env|dockerfile)(\.|$)/i.test(item)).slice(0, 12),
    suggestions: uniqueItems([...(profile.suggestions || []), ...suggestions]).slice(0, 7),
    cleanupAdvice: uniqueItems([...(profile.suggestions || []), ...suggestions]).slice(0, 7),
    confidence: Math.max(0.62, profile.confidence),
    provider: '本地规则分析（未检测到模型）',
  };
}

function buildPrompt(summary) {
  return `You are a careful local Windows folder analyzer. Use only the statistics and file-name samples below. Return exactly one JSON object and no Markdown fences. Required fields: source (the most likely application, platform, Windows system, or user source), folderType, purpose, summary, conclusion, confidence. Write all human-readable values in Simplified Chinese. The most important result is source: tell the user at a glance whether this comes from a game, application, Windows system, media software, developer tool, or user files. Do not output cleaning advice, startup analysis, residual analysis, risk analysis, or long lists. If the exact application cannot be identified, say so clearly instead of guessing.\n\nFolder data:\n${JSON.stringify(summary, null, 2)}`;
}

async function callOllama(summary) {
  const body = JSON.stringify({ model: process.env.DISK_MANAGER_OLLAMA_MODEL || 'qwen2.5:3b', messages: [{ role: 'user', content: buildPrompt(summary) }], stream: false, format: 'json', options: { temperature: 0.2, num_predict: 384 } });
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: 11434, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try { const parsed = JSON.parse(data); const result = parseModelJson(parsed.message?.content || '{}'); resolve({ ...result, provider: `Ollama · ${process.env.DISK_MANAGER_OLLAMA_MODEL || 'qwen2.5:3b'}` }); }
        catch (_) { reject(new Error('Ollama 返回了无法解析的结果')); }
      });
    });
    request.setTimeout(30000, () => request.destroy(new Error('Ollama 响应超时')));
    request.on('error', reject); request.end(body);
  });
}

async function ensureBundledLlama() {
  const appRoot = __dirname;
  const aiRoot = path.join(appRoot, 'ai');
  const executable = path.join(aiRoot, 'llama-server.exe');
  const model = (await fsp.readdir(path.join(aiRoot, 'models')).catch(() => []))
    .filter(name => name.toLowerCase().endsWith('.gguf')).map(name => path.join(aiRoot, 'models', name))[0];
  if (!fs.existsSync(executable) || !model) throw new Error('未找到内置本地模型');
  if (!localServerPromise) {
    localServerPromise = (async () => {
      const port = 18765;
      localServer = spawn(executable, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '-n', '384', '--jinja'], { cwd: aiRoot, windowsHide: true, stdio: 'ignore' });
      localServer.once('exit', () => { localServer = null; localServerPromise = null; });
      for (let i = 0; i < 120; i += 1) {
        try { await waitForLocalServer(port); return port; }
        catch (_) { await new Promise(resolve => setTimeout(resolve, 250)); }
      }
      throw new Error('内置本地模型启动超时');
    })();
  }
  const port = await localServerPromise;
  return { port, model };
}

async function callBundledPrompt(prompt, maxTokens = 384) {
  const { port, model } = await ensureBundledLlama();
  const response = await requestJson(port, '/v1/chat/completions', { model: path.basename(model), messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: maxTokens });
  const content = response.choices?.[0]?.message?.content || '{}';
  return { content, provider: `内置本地模型 · ${path.basename(model)}` };
}

async function callBundledLlama(summary) {
  const response = await callBundledPrompt(buildPrompt(summary), 384);
  return { ...parseModelJson(response.content), provider: response.provider };
}

function heuristicTranslate(name) {
  const dictionary = {
    desktop: '桌面', downloads: '下载', documents: '文档', pictures: '图片', videos: '视频', music: '音乐', projects: '项目', project: '项目', backup: '备份', backups: '备份', temp: '临时文件', cache: '缓存', steam: 'Steam 游戏', games: '游戏', game: '游戏', photos: '照片', screenshots: '截图', public: '公共', appdata: '应用数据', overwatch: '守望先锋', 'wuthering waves': '鸣潮', genshin: '原神', 'genshin impact': '原神', minecraft: '我的世界', photoshop: 'Photoshop（图像处理）'
  };
  const translated = dictionary[String(name || '').trim().toLowerCase()];
  return translated || name;
}

async function translateFolderName(name) {
  const originalName = String(name || '').trim();
  if (!originalName) throw new Error('缺少文件夹名称');
  const prompt = `You translate folder names for a Windows disk manager. Return exactly one JSON object and no Markdown. Required fields: translatedName and confidence. Translate the folder name into natural Simplified Chinese. Keep product names, game titles, version numbers, acronyms, and names that are already Chinese unchanged when appropriate. Folder name: ${JSON.stringify(originalName)}`;
  try {
    const response = await callBundledPrompt(prompt, 96);
    const result = parseModelJson(response.content);
    const modelName = String(result.translatedName || originalName).trim();
    const dictionaryName = heuristicTranslate(originalName);
    return { originalName, translatedName: dictionaryName !== originalName ? dictionaryName : modelName, confidence: Number(result.confidence || 0.8), provider: dictionaryName !== originalName ? '本地词典 + AI' : response.provider };
  } catch (error) {
    if (process.env.DISK_MANAGER_AI_DEBUG) console.error('translate:', error.message);
    return { originalName, translatedName: heuristicTranslate(originalName), confidence: 0.45, provider: '本地规则翻译' };
  }
}

async function analyzeFolder(target) {
  const summary = await collectFolderSummary(target);
  let result;
  try { result = await callBundledLlama(summary); }
  catch (error) {
    if (process.env.DISK_MANAGER_AI_DEBUG) console.error('bundled llama:', error.message);
    try { result = await callOllama(summary); }
    catch (ollamaError) {
      if (process.env.DISK_MANAGER_AI_DEBUG) console.error('ollama:', ollamaError.message);
      result = heuristicAnalyze(summary);
    }
  }
  return { ok: true, path: summary.root, stats: summary, analysis: enrichAnalysis(summary, result) };
}

async function getStatus() {
  const appRoot = __dirname;
  const executable = path.join(appRoot, 'ai', 'llama-server.exe');
  const modelDir = path.join(appRoot, 'ai', 'models');
  const models = await fsp.readdir(modelDir).catch(() => []);
  return { bundledModel: fs.existsSync(executable) && models.some(name => name.toLowerCase().endsWith('.gguf')), ollama: false, model: models.find(name => name.toLowerCase().endsWith('.gguf')) || null };
}

module.exports = { analyzeFolder, getStatus, translateFolderName };
