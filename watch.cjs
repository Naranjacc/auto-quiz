/**
 * One-shot: start capture proxy, detect credentials, auto-run quiz.
 * Usage: node watch.cjs <profile-name>
 */

const { spawn, execSync } = require('node:child_process');
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

const SESSION_FILE = join(homedir(), '.auto-quiz-session.json');
const PROFILE = process.argv[2] || '安全知识竞赛';
const PORT = process.argv[3] || '8899';

console.log('');
console.log('╔═════════════════════════════════════╗');
console.log('║  🚀 auto-quiz 一键答题             ║');
console.log('╠═════════════════════════════════════╣');
console.log('║  Profile:  %s', PROFILE);
console.log('║  Port:     %s', PORT);
console.log('║  Session:  ~/.auto-quiz-session.json');
console.log('╠═════════════════════════════════════╣');
console.log('║  📱 请在手机上:                    ║');
console.log('║  1. WiFi代理 → 本机IP:%s', PORT);
console.log('║  2. 微信打开答题链接               ║');
console.log('║  3. 点"开始答题"                   ║');
console.log('║                                    ║');
console.log('║  ⏳ 等待凭据捕获中...               ║');
console.log('╚═════════════════════════════════════╝');
console.log('');

// ---- Start capture proxy in background ----
const addonPath = join(__dirname, 'scripts', 'capture_addon.py');
const mitmPath = 'C:\\Program Files\\mitmproxy\\bin\\mitmdump.exe';
const proxy = spawn(mitmPath, ['-s', addonPath, '--listen-port', PORT, '--quiet'], {
  stdio: 'pipe',
  env: { ...process.env },
});

proxy.stderr.on('data', (d) => {
  // Filter mitmproxy noise, show only addon output
  const s = d.toString();
  if (s.includes('[quiz]') || s.includes('Credentials') || s.includes('🎯') || s.includes('✅')) {
    process.stdout.write(s);
  }
});

proxy.on('error', (err) => {
  console.error('Proxy error:', err.message);
  process.exit(1);
});

// ---- Monitor session.json ----
let lastRaw = '';
let count = 0;

const check = setInterval(() => {
  count++;
  if (!existsSync(SESSION_FILE)) return;

  try {
    const raw = readFileSync(SESSION_FILE, 'utf-8');
    if (raw === lastRaw) return;
    lastRaw = raw;

    const creds = JSON.parse(raw);

    // Still waiting for full credentials
    if (!creds.userId || !creds.uuid || !creds.wxc) {
      if (creds.wxc) process.stdout.write(`  📡 wxc captured, waiting for userId...\n`);
      return;
    }

    // ---- GOT IT ----
    clearInterval(check);
    console.log('');
    console.log('🎯 凭据已捕获！');
    console.log('   userId: %s', creds.userId);
    console.log('   uuid:   %s', creds.uuid);
    console.log('   wxc:    %s...', creds.wxc.substring(0, 20));
    console.log('');

    // Kill proxy
    proxy.kill('SIGINT');

    // Update profile with fresh session credentials
    console.log('📝 更新 profile session...');
    try {
      const profilesPath = join(homedir(), '.auto-quiz', 'profiles.json');
      if (existsSync(profilesPath)) {
        const profiles = JSON.parse(readFileSync(profilesPath, 'utf-8'));
        if (profiles.profiles?.[PROFILE]) {
          profiles.profiles[PROFILE].session = {
            userId: creds.userId,
            uuid: creds.uuid,
            wxc: creds.wxc,
          };
          require('fs').writeFileSync(profilesPath, JSON.stringify(profiles, null, 2), 'utf-8');
          console.log('   ✅ Profile updated');
        }
      }
    } catch (e) { console.log('   ⚠️  Profile update skipped: %s', e.message); }

    // Run quiz
    console.log('');
    console.log('🚀 开始答题...');
    console.log('═'.repeat(55));

    const quiz = spawn('node', ['src/cli.js', 'run', PROFILE, '--speed', 'fast'], {
      stdio: 'inherit',
      cwd: __dirname,
    });

    quiz.on('exit', (code) => {
      console.log('═'.repeat(55));
      console.log(code === 0 ? '✅ 答题完成' : '⚠️  答题结束 (exit=%d)', code);
      process.exit(code || 0);
    });

  } catch (e) {
    // JSON parse error — file may be being written, retry
    if (count % 20 === 0) process.stdout.write('.');
  }
}, 500);

// Timeout after 5 minutes
setTimeout(() => {
  clearInterval(check);
  proxy.kill('SIGINT');
  console.log('\n⏰ 超时 (5min) — 未检测到凭据。请确认手机代理设置。');
  process.exit(1);
}, 300000);

// Ctrl+C cleanup
process.on('SIGINT', () => {
  clearInterval(check);
  proxy.kill('SIGINT');
  console.log('\n👋 已停止。');
  process.exit(0);
});
