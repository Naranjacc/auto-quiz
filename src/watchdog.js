/**
 * Watchdog: monitor mitmproxy capture, auto-run quiz when credentials appear.
 *
 * Usage: node src/cli.js watch 安全知识竞赛
 *
 * Flow:
 *   1. Start mitmproxy capture proxy (mitmweb optional)
 *   2. Monitor ~/.auto-quiz-session.json for changes
 *   3. When matching credentials detected → auto-run quiz
 */

import { readFileSync, existsSync, watch } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const SESSION_FILE = join(homedir(), '.auto-quiz-session.json');
const PROFILE_NAME = process.argv[2] || '安全知识竞赛';

console.log('╔══════════════════════════════════════════════════╗');
console.log('║  🚀 auto-quiz Watchdog                          ║');
console.log('╠══════════════════════════════════════════════════╣');
console.log('║  Profile: %-40s ║', PROFILE_NAME);
console.log('║  Monitoring: ~/.auto-quiz-session.json          ║');
console.log('╠══════════════════════════════════════════════════╣');
console.log('║  📱 请在手机上打开微信答题链接并点"开始答题"    ║');
console.log('║  凭据捕获后自动开始答题...                       ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log('');

let lastCreds = '';
let triggered = false;

function checkAndRun() {
  if (triggered) return;
  if (!existsSync(SESSION_FILE)) return;

  try {
    const raw = readFileSync(SESSION_FILE, 'utf-8');
    if (raw === lastCreds) return;

    const creds = JSON.parse(raw);

    // Need at minimum: userId + uuid + wxc
    if (!creds.userId || !creds.uuid || !creds.wxc) return;

    // Check if credentials actually changed
    const credStr = `${creds.userId}|${creds.uuid}|${creds.wxc}`;
    if (credStr === lastCreds) return;

    lastCreds = credStr;
    triggered = true;

    console.log('');
    console.log('🎯 凭据已捕获！');
    console.log('   userId: %s', creds.userId);
    console.log('   uuid:   %s', creds.uuid);
    console.log('   wxc:    %s', creds.wxc.substring(0, 20) + '...');
    console.log('');
    console.log('🚀 开始自动答题...');
    console.log('');

    // Update profile with fresh creds
    const { execSync } = require('node:child_process');
    try {
      execSync(
        `node src/cli.js setup "${PROFILE_NAME}" ` +
        `--user-id "${creds.userId}" --uuid "${creds.uuid}" --wxc "${creds.wxc}" ` +
        `--no-prompt`,
        { stdio: 'inherit', cwd: process.cwd() }
      );
    } catch {
      // Setup might fail if profile already exists — continue anyway
    }

    // Run the quiz
    const proc = spawn('node', ['src/cli.js', 'run', PROFILE_NAME, '--speed', 'fast'], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });

    proc.on('exit', (code) => {
      console.log('');
      console.log(code === 0 ? '✅ 答题完成' : '⚠️  答题结束 (exit=%d)', code);
      process.exit(code || 0);
    });

  } catch {
    // File might be locked — retry next tick
  }
}

// Poll every 500ms (fs.watch unreliable on Windows for JSON files)
const interval = setInterval(checkAndRun, 500);

// Also try initial check
checkAndRun();

// Keep alive
process.on('SIGINT', () => {
  clearInterval(interval);
  if (!triggered) console.log('\n👋 Watchdog stopped (no credentials captured).');
  process.exit(0);
});
