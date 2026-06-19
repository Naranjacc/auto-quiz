/**
 * auto-quiz Web Dashboard
 * Start: node src/server.js  →  http://localhost:3456
 */

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, watch } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import cron from 'node-cron';

import {
  loadProfiles, saveProfile, getProfile, deleteProfile
} from './profile.js';
import { discoverFromSaz } from './batch.js';
import { createApiClient } from './api/client.js';
import { runApiSession } from './api/session.js';
import { KnowledgeBase } from './kb/manager.js';
import { loadConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = 3456;
const UPLOAD_DIR = join(dirname(__dirname), 'uploads');
await mkdir(UPLOAD_DIR, { recursive: true }).catch(() => {});

// ---- Hot Reload (--watch) ----
const isWatchMode = process.argv.includes('--watch');
const isChildProcess = process.env.AUTO_QUIZ_CHILD === '1';

if (isWatchMode && !isChildProcess) {
  // Parent process: spawn child and watch for changes
  let child = null;

  function startChild() {
    const args = process.argv.slice(1).filter(a => a !== '--watch');
    child = spawn(process.execPath, args, {
      env: { ...process.env, AUTO_QUIZ_CHILD: '1' },
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code !== 0 && code !== null) {
        console.log('[watch] Server exited with code %s, will restart on change...', code);
      }
    });
  }

  startChild();

  // Debounced restart on file change
  let restartTimer = null;
  const srcDir = join(__dirname);

  function debounceRestart(filename) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      console.log('[watch] File changed: %s — restarting server...', filename);
      if (child) { child.kill('SIGTERM'); child = null; }
      setTimeout(startChild, 500);
    }, 300);
  }

  try {
    const watcher = watch(srcDir, { recursive: true }, (eventType, filename) => {
      if (filename && !filename.includes('node_modules') && !filename.startsWith('.')) {
        debounceRestart(filename);
      }
    });
    watcher.on('error', (err) => {
      console.error('[watch] Watch error:', err.message);
    });
    console.log('[watch] Hot reload enabled — watching %s', srcDir);
  } catch (err) {
    console.error('[watch] Failed to start file watcher:', err.message);
    console.log('[watch] Falling back to no-reload mode. Polling every 5s instead.');
    // Fallback: poll every 5 seconds
    let lastMtimes = new Map();
    setInterval(async () => {
      try {
        const { readdir, stat } = await import('node:fs/promises');
        async function scanDir(dir) {
          const entries = await readdir(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = join(dir, e.name);
            if (e.name.startsWith('.') || full.includes('node_modules')) continue;
            if (e.isDirectory()) { await scanDir(full); continue; }
            const s = await stat(full);
            const prev = lastMtimes.get(full);
            if (prev && s.mtimeMs > prev) {
              debounceRestart(full);
              lastMtimes.set(full, s.mtimeMs);
              return;
            }
            lastMtimes.set(full, s.mtimeMs);
          }
        }
        await scanDir(srcDir);
      } catch {}
    }, 5000);
  }

  // Keep parent alive
  process.on('SIGINT', () => { if (child) child.kill('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { if (child) child.kill('SIGTERM'); process.exit(0); });
  // Prevent exit — child restart loop keeps running
  setInterval(() => {}, 60_000); // Keep event loop alive
  // Don't start server in parent
  // NOTE: the actual server runs in the child process via recursion below
  if (typeof globalThis.__server_started === 'undefined') {
    globalThis.__server_started = true; // prevent parent from reaching listen()
  }
}

// Only the child (or non-watch mode) starts the actual server
if (!isWatchMode || isChildProcess) {

// Active runs + last SAZ + schedule jobs
const runs = new Map();
let lastSazPath = null;

// ---- Schedule Store ----
const schedules = new Map(); // scheduleId → { id, profileName, cronExpression, cronJob, createdAt, lastRun, lastResult }

// ---- Shared run logic (used by API.run + schedule cron jobs) ----
async function executeProfileRun(profileName) {
  const profile = await getProfile(profileName);
  if (!profile) throw new Error(`Profile "${profileName}" not found`);

  const qr = profile.qrImage;
  let url;
  if (qr) {
    const { parseQR } = await import('./browser/extractor.js');
    const absQr = qr.startsWith('/') || /^[A-Z]:/i.test(qr) ? qr : join(dirname(__dirname), qr);
    url = await parseQR(absQr);
  } else if (profile.baseUrl && profile.secretBoxCode && profile.secretKey) {
    url = profile.baseUrl + '/index.html#' + profile.secretBoxCode + '-' + profile.secretKey;
  } else {
    throw new Error('No QR image or URL in profile');
  }

  const cfg = loadConfig({ accuracy: profile.accuracy ?? 1, speed: profile.speed ?? 'fast' });
  const fileCfg = existsSync(join(homedir(), '.auto-quiz.json'))
    ? JSON.parse(await readFile(join(homedir(), '.auto-quiz.json'), 'utf-8'))
    : {};
  if (!cfg.llmApiKey && fileCfg.apiKey) cfg.llmApiKey = fileCfg.apiKey;

  const kb = new KnowledgeBase(profile.kbDir || cfg.kbDir);
  await kb.list().catch(() => {});

  return await runApiSession({ url, session: profile.session || {}, kb, config: cfg });
}

// ---- Helpers ----
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function getBody(req) {
  return new Promise((resolve) => {
    const bufs = [];
    req.on('data', c => bufs.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(bufs);
      const raw = buf.toString('utf8');
      const ct = (req.headers['content-type'] || '').toLowerCase();
      console.log('[getBody] content-type=%s  bytes=%d  body=%s',
        ct, buf.length, raw.slice(0, 300));
      if (!raw.trim()) {
        console.error('[getBody] Empty body received');
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        console.error('[getBody] JSON parse error: %s — raw: %s', e.message, raw.slice(0, 300));
        resolve(null);
      }
    });
  });
}

// ---- Dashboard HTML (inline) ----
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

async function renderDashboard() {
  const { profiles } = await loadProfiles();
  const fileCfg = existsSync(join(homedir(), '.auto-quiz.json'))
    ? JSON.parse(await readFile(join(homedir(), '.auto-quiz.json'), 'utf-8'))
    : {};
  const hasApiKey = !!(fileCfg.apiKey);

  const profileCards = Object.entries(profiles).map(([name, p]) => {
    const hasSession = !!(p.session?.userId);
    const kbLabel = p.kbDir ? '📚 '+p.kbDir : '📚 无题库';
    return `<div class="card">
      <div class="flex">
        <div style="flex:1">
          <strong>${hasSession ? '🔑' : '⚠️'} ${esc(name)}</strong>
          <div class="muted">${esc(p.baseUrl || '(no URL)')} | ${(p.secretBoxCode||'').slice(0,10)}...</div>
          <div class="muted">userId: ${p.session?.userId || '?'} | ${kbLabel} | 正确率: ${(p.accuracy*100).toFixed(0)}% | 速度: ${p.speed||'fast'}</div>
        </div>
        <div style="text-align:right">
          ${hasSession ? `<button class="btn btn-go" onclick="runQuiz('${esc(name)}')">🚀 答题</button>` : `<span class="tag tag-warn">需配置</span>`}
          <br><button class="btn btn-sm" onclick="editProfile('${esc(name)}')" style="margin-top:4px">✏️ 设置</button>
          <button class="btn btn-sm" onclick="delProfile('${esc(name)}')" style="margin-top:4px">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>auto-quiz</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"Microsoft YaHei",sans-serif;background:#f5f6fa;color:#222;max-width:800px;margin:0 auto;padding:20px}
h1{font-size:20px;margin-bottom:20px}
h1 span{color:#0984e3}
.card{background:#fff;border-radius:10px;padding:16px;margin-bottom:12px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.card h3{font-size:14px;color:#666;margin-bottom:8px}
.btn{padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin:2px}
.btn-go{background:#27ae60;color:#fff;font-size:15px;padding:10px 24px}
.btn-go:hover{background:#219a52}
.btn-blue{background:#0984e3;color:#fff}
.btn-blue:hover{background:#0773c5}
.btn-sm{background:#eee;font-size:12px}
.btn-sm:hover{background:#ddd}
.btn-danger{background:#e74c3c;color:#fff}
.flex{display:flex;align-items:center;gap:12px}
.muted{font-size:13px;color:#888}
.tag{padding:2px 8px;border-radius:4px;font-size:12px;display:inline-block}
.tag-warn{background:#ffeaa7;color:#d68910}
.tag-ok{background:#d5f5e3;color:#27ae60}
.upload-zone{border:2px dashed #bbb;border-radius:10px;padding:30px;text-align:center;margin:12px 0;cursor:pointer}
.upload-zone:hover{border-color:#0984e3;background:#f0f7ff}
input,select{padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:14px;width:100%;margin:4px 0}
.row{display:flex;gap:8px;margin:8px 0}
.row>*{flex:1}
.modal{position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:999}
.modal>div{background:#fff;border-radius:12px;padding:24px;min-width:360px;max-width:550px;max-height:80vh;overflow-y:auto}
#log{background:#1a1a2e;color:#0f0;font-family:monospace;font-size:12px;padding:12px;border-radius:8px;max-height:300px;overflow-y:auto;white-space:pre-wrap}
.bar{background:#eee;height:6px;border-radius:3px;margin:8px 0}
.bar>div{background:#27ae60;height:100%;border-radius:3px;transition:width .3s}
.hidden{display:none!important}
</style>
</head>
<body>
<h1>🤖 auto-<span>quiz</span> <span style="font-size:12px;color:#888">Dashboard</span></h1>
<div id="jsErrors"></div>

<div class="card"><h3>📤 上传 SAZ 抓包文件（自动识别所有人和 quiz）</h3>
  <form id="sazForm" enctype="multipart/form-data">
    <input type="file" name="saz" accept=".saz" onchange="uploadSaz()" style="width:auto">
    <span id="sazStatus" class="muted"></span>
  </form>
  <div id="sazResult"></div>
</div>

<div class="card"><h3>➕ 新建 / ✏️ 编辑 Profile</h3>
  <input type="text" id="pfName" placeholder="Profile 名称（如：档案日-张三）">
  <div class="row">
    <input type="text" id="pfUrl" placeholder="Quiz 链接 或 QR 图片路径">
    <input type="text" id="pfUserId" placeholder="userId（可选，SAZ 自动填）">
  </div>
  <div class="row">
    <select id="pfSpeed"><option value="fast">Fast (0.5-2s)</option><option value="medium" selected>Medium (2-5s)</option><option value="slow">Slow (5-12s)</option></select>
    <select id="pfAccuracy"><option value="1">正确率 100%</option><option value="0.9">正确率 90%</option><option value="0.85">正确率 85%</option><option value="0.7">正确率 70%</option></select>
  </div>
  <div class="row">
    <input type="text" id="pfKb" placeholder="题库目录路径（如：./data/kb-安全，可选）">
    <input type="file" id="pfKbFile" accept=".docx,.json,.md,.txt" onchange="importKbForProfile()" style="width:auto">
  </div>
  <button class="btn btn-blue" onclick="createProfile()">💾 保存</button>
  <button class="btn btn-sm" style="display:none" id="pfDelBtn" onclick="delCurrentProfile()">🗑 删除此 Profile</button>
  <span class="muted">API Key: ${hasApiKey ? '✅ 已配置' : '⚠️ 未配置（LLM 不可用）'} | 正确率设置：人工模拟偶尔答错</span>
</div>

<div class="card"><h3>📋 Profiles (${Object.keys(profiles).length})</h3>
  <div id="profileList">${profileCards || '<div class="muted">暂无，上传 SAZ 或手动创建</div>'}</div>
</div>

<div class="card hidden" id="resultCard">
  <h3 id="resultTitle">📊 答题结果</h3>
  <div class="bar"><div id="resultBar" style="width:0%"></div></div>
  <div id="resultStatus" class="muted"></div>
  <pre id="resultLog" style="background:#1a1a2e;color:#0f0;font-size:12px;padding:12px;border-radius:8px;max-height:300px;overflow-y:auto;white-space:pre-wrap"></pre>
</div>

<div class="modal hidden" id="runModal"><div>
  <h3 id="runTitle">🚀 答题中...</h3>
  <div class="bar"><div id="runBar" style="width:0%"></div></div>
  <div id="runStatus" class="muted"></div>
  <div id="log"></div>
  <br><button class="btn btn-sm" onclick="closeRun()">关闭</button>
</div></div>

<script>
// Debug: catch all errors
window.onerror = function(msg, url, line) {
  var el = document.getElementById('jsErrors');
  if (el) el.innerHTML += '<div style=color:red>JS Error line '+line+': '+msg+'</div>';
};
console.log('auto-quiz dashboard loaded');
const API = '/api';
let pollTimer = null;

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/'/g,'&#39;').replace(/"/g,'&quot;'); }

// ---- Profile CRUD ----
async function createProfile() {
  const name = document.getElementById('pfName').value.trim();
  if (!name) return alert('请输入名称');
  const url = document.getElementById('pfUrl').value.trim();
  let baseUrl='', secretBoxCode='', secretKey='', qrImage=null;
  if (url && url.startsWith('http')) {
    try { const u = new URL(url); baseUrl=u.protocol+'//'+u.host; const h=(u.hash||'').replace('#',''); const [c,k]=h.split('-'); secretBoxCode=c||''; secretKey=k||''; }catch{}
  } else if (url) { qrImage = url; }
  const speed = document.getElementById('pfSpeed').value;
  const accuracy = parseFloat(document.getElementById('pfAccuracy').value);
  const userId = document.getElementById('pfUserId').value.trim();

  await fetch(API+'/profile/'+encodeURIComponent(name), {
    method:'POST', headers:{'Content-Type':'application/json; charset=utf-8'},
    body: JSON.stringify({
      baseUrl, secretBoxCode, secretKey,
      session: { userId: userId||'', uuid:'', wxc:'' },
      qrImage, accuracy, speed, kbDir: null, llmApiKey: null
    })
  });
  location.reload();
}

async function delProfile(name) {
  if (!confirm('删除 ' + name + '？')) return;
  await fetch(API+'/profile/'+encodeURIComponent(name), {method:'DELETE'});
  location.reload();
}

var editingName = null;
async function editProfile(name) {
  editingName = name;
  document.getElementById('pfName').value = name;
  var res = await fetch(API+'/profile/'+encodeURIComponent(name));
  var p = await res.json();
  if (p) {
    document.getElementById('pfUrl').value = p.baseUrl ? (p.baseUrl+'/index.html#'+p.secretBoxCode+'-'+p.secretKey) : (p.qrImage||'');
    document.getElementById('pfUserId').value = p.session?.userId||'';
    document.getElementById('pfSpeed').value = p.speed||'medium';
    document.getElementById('pfAccuracy').value = p.accuracy||'1';
    document.getElementById('pfKb').value = p.kbDir||'';
    document.getElementById('pfDelBtn').style.display = 'inline-block';
    window.scrollTo(0,0);
  }
}

async function delCurrentProfile() {
  if (editingName && confirm('删除 '+editingName+'？')) {
    await delProfile(editingName);
    editingName = null;
  }
}

async function importKbForProfile() {
  var file = document.getElementById('pfKbFile').files[0];
  if (!file) return;
  var name = editingName || document.getElementById('pfName').value.trim();
  if (!name) { alert('请先输入 Profile 名称'); return; }
  var form = new FormData(); form.append('file', file);
  var res = await fetch(API+'/upload', {method:'POST',body:form});
  var data = await res.json();
  if (!data.files?.length) { alert('上传失败'); return; }
  // Import into KB
  var importRes = await fetch(API+'/kb/import', {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},
    body:JSON.stringify({profileName:name, filePath:data.files[0].path})
  });
  var result = await importRes.json();
  if (result.error) { alert('导入失败: '+result.error); return; }
  alert('已导入 '+result.count+' 条题目！');
  document.getElementById('pfKb').value = result.kbDir||'';
  // Auto-save profile with KB path
  if (editingName) editProfile(editingName);
}

// ---- SAZ Upload ----
async function uploadSaz() {
  const file = document.querySelector('input[name=saz]').files[0];
  if (!file) return;
  document.getElementById('sazStatus').textContent = '上传中...';
  const form = new FormData(); form.append('saz', file);
  const res = await fetch(API+'/upload', {method:'POST',body:form});
  const data = await res.json();
  if (!data.files?.length) { document.getElementById('sazStatus').textContent='上传失败'; return; }
  document.getElementById('sazStatus').textContent = '分析中...';

  const discoverRes = await fetch(API+'/saz/discover', {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({filePath:data.files[0].path})});
  const {people} = await discoverRes.json();
  const div = document.getElementById('sazResult');
  if (!people || !people.length) {
    div.innerHTML = '<div class="card"><span class="tag tag-warn">未发现用户</span> 确保 SAZ 包含完整登录流程</div>';
    document.getElementById('sazStatus').textContent = '';
    return;
  }
  div.innerHTML = '<div class="card"><h3>✅ 发现 '+people.length+' 人</h3>'+
    people.map(p=>'<div style="padding:4px 0">👤 <b>'+esc(p.name)+'</b> '+esc(p.phone)+' '+esc(p.department)+' | quiz: '+esc((p.secretBoxCode||'').slice(0,8))+'...</div>').join('')+
    '<br><input type="text" id="batchLabel" placeholder="统一标签（可空）" style="width:auto"> '+
    '<button class="btn btn-blue" onclick="batchCreate()">一键建 Profile</button></div>';
  document.getElementById('sazStatus').textContent = '✅ 完成';
}

async function batchCreate() {
  const label = document.getElementById('batchLabel').value.trim();
  const res = await fetch(API+'/saz/create-profiles', {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({filePath:'',label})});
  const data = await res.json();
  document.getElementById('sazResult').innerHTML += '<p class="tag tag-ok">✅ 已创建 '+ (data.created?.length||0) +' 个 Profile</p>';
  setTimeout(()=>location.reload(), 1000);
}

// ---- Run Quiz ----
function closeRun() {
  document.getElementById('runModal').classList.add('hidden');
  if (pollTimer) { clearInterval(pollTimer); pollTimer=null; }
}

async function runQuiz(name) {
  // Show both modal and inline result
  var card = document.getElementById('resultCard');
  card.classList.remove('hidden');
  document.getElementById('resultTitle').textContent = '📊 '+name+' 答题中...';
  document.getElementById('resultBar').style.width = '0%';
  document.getElementById('resultStatus').textContent = '连接服务器...';
  document.getElementById('resultLog').textContent = '';

  try {
    var res = await fetch(API+'/run', {method:'POST',headers:{'Content-Type':'application/json; charset=utf-8'},body:JSON.stringify({name:name})});
    var data = await res.json();
    if (data.error) { document.getElementById('resultStatus').textContent='❌ '+data.error; return; }
    var runId = data.runId;
    document.getElementById('resultStatus').textContent = '答题进行中...';

    pollTimer = setInterval(async function(){
      try {
        var r = await fetch(API+'/run/'+runId);
        var s = await r.json();
        if (!s) return;
        var n = s.questions ? s.questions.length : 0;
        document.getElementById('resultBar').style.width = Math.min(95, n*4)+'%';
        document.getElementById('resultStatus').textContent = '已答 '+n+' 题';
        if (s.questions && s.questions.length) {
          var lines = [];
          for (var i = Math.max(0, n-8); i < n; i++) {
            var q = s.questions[i];
            lines.push('Q'+(i+1)+' ['+(q.source||'?').toUpperCase()+'] → '+(q.answer||'').slice(0,40));
          }
          document.getElementById('resultLog').textContent = lines.join(String.fromCharCode(10));
        }
        if (s.status === 'done') {
          clearInterval(pollTimer);
          document.getElementById('resultBar').style.width='100%';
          var r = s.result || {};
          var acc = r.accuracy || (r.correctCount >= 0 ? (r.correctCount/r.totalQuestions*100).toFixed(1)+'%' : '?');
          document.getElementById('resultStatus').innerHTML='✅ 完成！<b>'+r.totalQuestions+'</b> 题 | 正确: <b style=color:#27ae60>'+(r.correctCount||0)+'</b> 错误: <b style=color:#e74c3c>'+(r.wrongCount||0)+'</b> 正确率: <b>'+acc+'</b> | '+r.totalDuration;
          document.getElementById('resultLog').textContent = (s.questions||[]).map(function(q,i){var m=q.correct?'✓':'✗'; return m+' Q'+(i+1)+' ['+(q.source||'?').toUpperCase()+'] → '+(q.answer||'')}).join(String.fromCharCode(10));
        }
        if (s.status === 'error') { clearInterval(pollTimer); document.getElementById('resultStatus').textContent='❌ '+(s.error||''); }
      } catch(e) { console.error(e); }
    }, 1500);
  } catch(e) {
    document.getElementById('resultStatus').textContent = '❌ '+e.message;
    console.error(e);
  }
}
</script></body></html>`;
}

// ---- API Routes ----
const API = {
  async profiles() {
    return (await loadProfiles()).profiles;
  },
  async profile(name) { return getProfile(name); },
  async saveProfile(name, data) { await saveProfile(name, data); return {ok:true}; },
  async deleteProfile(name) { await deleteProfile(name); return {ok:true}; },
  async upload(req) {
    const ct = req.headers['content-type']||'';
    const m = ct.match(/boundary=(.+)/);
    if (!m) return {error:'need multipart'};
    const bufs = [];
    for await (const c of req) bufs.push(c);
    const str = Buffer.concat(bufs).toString('binary');
    const boundary = m[1];
    const parts = str.split('--'+boundary);
    const files = [];
    for (const p of parts) {
      const fn = p.match(/filename="([^"]+)"/);
      if (!fn) continue;
      const hEnd = p.indexOf('\r\n\r\n');
      if (hEnd<0) continue;
      let data = p.slice(hEnd+4);
      data = data.replace(/\r\n--$/,'').replace(/\r\n$/,'');
      const saveName = randomUUID().slice(0,8)+extname(fn[1]);
      const savePath = join(UPLOAD_DIR, saveName);
      await writeFile(savePath, Buffer.from(data,'binary'));
      files.push({filename:fn[1], path:savePath});
    }
    return {files};
  },
  async discoverSaz(body) {
    if (!body?.filePath) return {people:[]};
    lastSazPath = body.filePath;
    return {people: await discoverFromSaz(body.filePath)};
  },
  async createProfiles(body) {
    const filePath = body?.filePath || lastSazPath;
    if (!filePath) return {error:'No SAZ file'};
    const people = await discoverFromSaz(filePath);
    const created = [];
    for (const p of people) {
      const label = body.label || (p.name || 'user');
      const name = label+'-'+p.userId.slice(-4);
      await saveProfile(name, {
        baseUrl: p.baseUrl||'https://x'+p.secretBoxCode.slice(0,6)+'.fengxueba.com',
        secretBoxCode: p.secretBoxCode,
        secretKey: p.secretKey,
        session: {userId:p.userId, uuid:p.uuid, wxc:p.wxc},
        kbDir: null, qrImage: null, accuracy:1.0, speed:'fast', llmApiKey:null,
      });
      created.push({name, person:p});
    }
    return {created};
  },
  async run(name) {
    const runId = randomUUID().slice(0,8);
    const state = {id:runId, profile:name, status:'running', questions:[], startTime:Date.now()};
    runs.set(runId, state);

    (async ()=>{
      try {
        const result = await executeProfileRun(name);
        state.status = 'done';
        state.result = result;
        for (const r of (result?.results||[])) state.questions.push({text:r.question, answer:r.answer, source:r.source, correct:r.correct});
      } catch(e) {
        state.status = 'error'; state.error = e.message;
      }
    })();
    return {runId, status:'started'};
  },
  getRun(id) { return runs.get(id) || {error:'not found'}; },
  async kbImport(body) {
    const { profileName, filePath } = body || {};
    if (!profileName || !filePath) return {error:'profileName and filePath required'};
    if (!existsSync(filePath)) return {error:'file not found: '+filePath};

    const profile = await getProfile(profileName);
    const kbDir = profile?.kbDir || join(homedir(), '.auto-quiz', 'kb-'+profileName);
    const kb = new KnowledgeBase(kbDir);
    await kb.list().catch(()=>{});

    const ext = extname(filePath).toLowerCase();
    let count = 0;

    if (ext === '.json') {
      count = await kb.importFromJSON(filePath);
    } else if (ext === '.md') {
      count = await kb.importFromMarkdown(filePath);
    } else if (ext === '.docx') {
      const { execSync } = await import('node:child_process');
      const xml = execSync('unzip -p "'+filePath+'" word/document.xml', {encoding:'utf8',maxBuffer:50*1024*1024});
      const paras = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) || [];
      for (const para of paras) {
        const runs = para.match(/<w:r[\s>][\s\S]*?<\/w:r>/g) || [];
        let q='', a='';
        for (const run of runs) {
          const tm = run.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
          if (!tm) continue;
          const text = tm[1];
          if (/<w:color[^>]*w:val="[^"]*[Rr][Ee][Dd]|FF0000|C00000/.test(run)) a=text;
          else q+=text;
        }
        q=q.replace(/\s+/g,'').trim();
        if (q&&a&&q.length>5&&a.length<200) { await kb.add({question:q,answer:a}); count++; }
      }
    } else if (ext === '.txt') {
      const content = await readFile(filePath,'utf-8');
      const lines = content.split('\n').map(l=>l.trim()).filter(Boolean);
      for (let i=0;i<lines.length-1;i+=2) {
        const q=lines[i].replace(/^[Qq]\d*[.、:：]\s*/,'').trim();
        const a=lines[i+1].replace(/^[Aa]\d*[.、:：]\s*/,'').trim();
        if (q&&a&&q.length>3) { await kb.add({question:q,answer:a}); count++; }
      }
    }

    // Save kbDir to profile
    if (profile && !profile.kbDir && count > 0) {
      profile.kbDir = kbDir;
      await saveProfile(profileName, profile);
    }

    return {count, kbDir};
  },

  // ---- Schedule Management ----
  async createSchedule(body) {
    const { profileName, cronExpression } = body || {};
    if (!profileName || !cronExpression) {
      return { error: 'profileName and cronExpression are required' };
    }

    // Validate profile exists
    const profile = await getProfile(profileName);
    if (!profile) return { error: `Profile not found: "${profileName}"` };

    // Validate cron expression
    if (!cron.validate(cronExpression)) {
      return { error: `Invalid cron expression: "${cronExpression}". Use format: "*/5 * * * *" (5 fields: minute hour day-of-month month day-of-week)` };
    }

    // Check for duplicate
    for (const [, s] of schedules) {
      if (s.profileName === profileName && s.cronExpression === cronExpression) {
        return { error: 'A schedule for this profile with the same cron expression already exists', existingId: s.id };
      }
    }

    const scheduleId = randomUUID().slice(0, 8);
    const createdAt = new Date().toISOString();

    // Schedule the cron job
    const cronJob = cron.schedule(cronExpression, async () => {
      console.log('[schedule] Triggered: %s → profile "%s"', scheduleId, profileName);
      try {
        const runId = randomUUID().slice(0, 8);
        const state = { id: runId, profile: profileName, status: 'running', questions: [], startTime: Date.now() };
        runs.set(runId, state);

        const result = await executeProfileRun(profileName);
        state.status = 'done';
        state.result = result;
        for (const r of (result?.results || [])) state.questions.push({
          text: r.question, answer: r.answer, source: r.source, correct: r.correct,
        });

        // Update schedule last run info
        const sched = schedules.get(scheduleId);
        if (sched) {
          sched.lastRun = new Date().toISOString();
          sched.lastResult = result;
          sched.lastRunId = runId;
        }
        console.log('[schedule] Completed: %s → %d questions, accuracy: %s',
          scheduleId, result?.totalQuestions || 0, result?.accuracy || '?');
      } catch (e) {
        console.error('[schedule] Failed: %s → %s', scheduleId, e.message);
        const sched = schedules.get(scheduleId);
        if (sched) {
          sched.lastRun = new Date().toISOString();
          sched.lastResult = { error: e.message };
        }
      }
    }, { scheduled: true });

    const entry = { id: scheduleId, profileName, cronExpression, cronJob, createdAt, lastRun: null, lastResult: null, lastRunId: null };
    schedules.set(scheduleId, entry);

    console.log('[schedule] Created: %s → profile "%s"  cron: "%s"', scheduleId, profileName, cronExpression);
    return { id: scheduleId, profileName, cronExpression, createdAt };
  },

  listSchedules() {
    const result = [];
    for (const [, s] of schedules) {
      result.push({
        id: s.id,
        profileName: s.profileName,
        cronExpression: s.cronExpression,
        createdAt: s.createdAt,
        lastRun: s.lastRun,
        lastResult: s.lastResult ? {
          totalQuestions: s.lastResult.totalQuestions,
          correctCount: s.lastResult.correctCount,
          wrongCount: s.lastResult.wrongCount,
          accuracy: s.lastResult.accuracy,
          totalDuration: s.lastResult.totalDuration,
          error: s.lastResult.error,
        } : null,
        lastRunId: s.lastRunId,
      });
    }
    return result;
  },

  deleteSchedule(id) {
    const s = schedules.get(id);
    if (!s) return { error: 'Schedule not found' };
    s.cronJob.stop();
    schedules.delete(id);
    console.log('[schedule] Deleted: %s', id);
    return { ok: true };
  },
};

// ---- Server ----
createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  if (req.method==='OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost:'+PORT);
  const p = url.pathname;

  try {
    if ((p==='/'||p==='/dashboard') && req.method==='GET') {
      const html = await renderDashboard();
      res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
      res.end(html);
    }
    else if (p==='/api/profiles' && req.method==='GET') json(res, await API.profiles());
    else if (p.startsWith('/api/profile/') && req.method==='GET') json(res, await API.profile(decodeURIComponent(p.replace('/api/profile/',''))));
    else if (p.startsWith('/api/profile/') && req.method==='POST') json(res, await API.saveProfile(decodeURIComponent(p.replace('/api/profile/','')), await getBody(req)));
    else if (p.startsWith('/api/profile/') && req.method==='DELETE') json(res, await API.deleteProfile(decodeURIComponent(p.replace('/api/profile/',''))));
    else if (p==='/api/upload' && req.method==='POST') json(res, await API.upload(req));
    else if (p==='/api/saz/discover' && req.method==='POST') json(res, await API.discoverSaz(await getBody(req)));
    else if (p==='/api/saz/create-profiles' && req.method==='POST') json(res, await API.createProfiles(await getBody(req)));
    else if (p==='/api/run' && req.method==='POST') json(res, await API.run((await getBody(req))?.name));
    else if (p.startsWith('/api/run/') && req.method==='GET') json(res, API.getRun(p.replace('/api/run/','')));
    else if (p==='/api/kb/import' && req.method==='POST') json(res, await API.kbImport(await getBody(req)));
    else if (p==='/api/schedule' && req.method==='GET') json(res, API.listSchedules());
    else if (p==='/api/schedule' && req.method==='POST') json(res, await API.createSchedule(await getBody(req)));
    else if (p.startsWith('/api/schedule/') && req.method==='DELETE') json(res, API.deleteSchedule(p.replace('/api/schedule/','')));
    else { res.writeHead(404); res.end('404'); }
  } catch(e) {
    console.error(e);
    res.writeHead(500);
    res.end(String(e));
  }
}).listen(PORT, ()=>{
  console.log('\n  auto-quiz Dashboard → http://localhost:'+PORT+'\n');
  if (isWatchMode) console.log('  Hot reload: enabled (--watch)\n');
});

} // end if (!isWatchMode || isChildProcess)
