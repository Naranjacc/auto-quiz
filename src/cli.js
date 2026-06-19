#!/usr/bin/env node
import { Command } from 'commander';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, networkInterfaces } from 'node:os';
import { loadConfig, defaults } from './config.js';
import { KnowledgeBase } from './kb/manager.js';
import { parseQR } from './browser/extractor.js';
import { runApiSession } from './api/session.js';
import { extractFromSaz } from './saz-extract.js';
import { discoverFromSaz, createProfilesFromDiscover } from './batch.js';
import {
  loadProfiles, saveProfile, getProfile,
  deleteProfile, listProfiles, setDefaultProfile,
  setupProfile, resolveFromProfile,
} from './profile.js';

// ---------------------------------------------------------------------------
// Session persistence for API mode (cached WeChat credentials)
// ---------------------------------------------------------------------------
const SESSION_FILE = join(homedir(), '.auto-quiz-session.json');

async function loadSessionFile() {
  if (existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(await readFile(SESSION_FILE, 'utf-8'));
    } catch { /* corrupt */ }
  }
  return {};
}

async function saveSessionFile(data) {
  const existing = await loadSessionFile();
  const merged = { ...existing, ...data };
  await writeFile(SESSION_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Config file persistence (separate from ./config.js which is runtime-only)
// ---------------------------------------------------------------------------
const CONFIG_FILE = join(homedir(), '.auto-quiz.json');

async function loadConfigFile() {
  if (existsSync(CONFIG_FILE)) {
    try {
      return JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
    } catch { /* corrupt — ignore */ }
  }
  return {};
}

async function saveConfigFile(cfg) {
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Resolution: CLI flags > config file > defaults
// ---------------------------------------------------------------------------
async function resolveConfig(globalOpts = {}, cmdOpts = {}) {
  const fileCfg = await loadConfigFile();
  const overrides = {};

  // Config-file values
  if (fileCfg.apiKey) overrides.llmApiKey = fileCfg.apiKey;
  if (fileCfg.llmApiKey) overrides.llmApiKey = fileCfg.llmApiKey;

  // Global flags
  if (globalOpts.kbDir) overrides.kbDir = globalOpts.kbDir;
  if (globalOpts.config) {
    // Load external config.json if provided (overrides file config)
    try {
      if (existsSync(globalOpts.config)) {
        const ext = JSON.parse(await readFile(globalOpts.config, 'utf-8'));
        Object.assign(overrides, ext);
      }
    } catch { /* skip */ }
  }

  // Command-level flags
  if (cmdOpts.accuracy != null) overrides.accuracy = cmdOpts.accuracy;
  if (cmdOpts.speed && cmdOpts.speed !== defaults.speed) overrides.speed = cmdOpts.speed;
  if (cmdOpts.headless != null) overrides.headless = cmdOpts.headless;
  if (cmdOpts.headless === false) overrides.headless = false;

  return loadConfig(overrides);
}

// ---------------------------------------------------------------------------
// CLI definition
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name('auto-quiz')
  .description('Automated quiz answering — QR/link input, KB matching, configurable accuracy & speed')
  .version('0.1.0')
  .option('--kb-dir <path>', 'Knowledge base directory')
  .option('-c, --config <path>', 'Path to external config.json file');

// ---------------------------------------------------------------------------
// run — unified quiz runner (profile or ad-hoc)
// ---------------------------------------------------------------------------
program
  .command('run [name]')
  .description('Run a quiz by profile name, or ad-hoc with --source')
  .option('-s, --source <qr-or-url>', 'QR image path or quiz URL (ad-hoc mode)')
  .option('-a, --accuracy <number>', 'Target accuracy 0-1', parseFloat)
  .option('--speed <speed>', 'Answer speed: fast|medium|slow')
  .option('--session <file>', 'Path to session JSON (ad-hoc mode)')
  .option('--user-id <id>', 'Override userId')
  .option('--uuid <openid>', 'Override WeChat openid')
  .option('--wxc <code>', 'Override WeChat OAuth code')
  .action(async (name, cmdOpts) => {
    let source, session = {}, profileKbDir, profile;

    if (name) {
      // Profile mode
      profile = await getProfile(name);
      if (!profile) {
        console.error('Profile "%s" not found. Use "auto-quiz setup %s" first.', name, name);
        console.error('Available profiles: %s', (await listProfiles()).join(', ') || '(none)');
        process.exit(1);
      }
      source = profile.qrImage || `${profile.baseUrl}/index.html#${profile.secretBoxCode}-${profile.secretKey}`;
      session = profile.session || {};
      profileKbDir = profile.kbDir;
      console.log('[profile] Using saved profile: %s', name);
    } else if (cmdOpts.source) {
      source = cmdOpts.source;
    } else {
      console.error('Specify a profile name or --source.');
      console.error('  auto-quiz run 档案日');
      console.error('  auto-quiz run --source ./qr.jpg');
      process.exit(1);
    }

    // Config: profile > CLI flags > defaults
    const baseConfig = profile ? await resolveFromProfile(profile, cmdOpts) : await resolveConfig(program.opts(), cmdOpts);
    // Allow CLI accuracy/speed to override profile
    if (cmdOpts.accuracy != null) baseConfig.accuracy = cmdOpts.accuracy;
    if (cmdOpts.speed) baseConfig.speed = cmdOpts.speed;

    // Session: CLI flags > session file > profile
    session = { ...session };
    if (cmdOpts.session && existsSync(cmdOpts.session)) {
      try {
        Object.assign(session, JSON.parse(await readFile(cmdOpts.session, 'utf-8')));
      } catch { /* skip */ }
    }
    if (cmdOpts.userId) session.userId = cmdOpts.userId;
    if (cmdOpts.uuid) session.uuid = cmdOpts.uuid;
    if (cmdOpts.wxc) session.wxc = cmdOpts.wxc;

    // QR decode
    let url = source;
    if (isImagePath(url)) {
      console.log('[run] Decoding QR from: %s', url);
      try {
        url = await parseQR(url);
        console.log('[run] QR → %s', url);
      } catch (err) {
        console.error('FATAL: QR decode failed: %s', err.message);
        process.exit(1);
      }
    } else if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url;
    }

    // Load KB (profile KB file takes priority)
    let kb;
    const kbPath = profileKbDir || baseConfig.kbDir;
    try {
      kb = new KnowledgeBase(kbPath);
      await kb.list();
      console.log('[run] KB loaded: %d entries from %s', kb.size, kbPath);
    } catch (err) {
      console.warn('[run] KB load failed (%s). Using random/LLM fallback.', err.message);
      kb = { size: 0, recordHit() {} };
    }

    // Banner
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  auto-quiz  v0.3.0');
    console.log('  Profile: %s', name || '(ad-hoc)');
    console.log('  Accuracy: %d  |  Speed: %s', baseConfig.accuracy, baseConfig.speed);
    console.log('══════════════════════════════════════════');
    console.log('');

    try {
      const result = await runApiSession({ url, session, kb, config: baseConfig });

      // Save updated session back to profile
      if (profile && session.userId) {
        profile.session = { ...profile.session, userId: session.userId, uuid: session.uuid };
        await saveProfile(name, profile);
      }

      // Summary
      console.log('');
      console.log('──────────────────────────────────────────');
      console.log('  SESSION SUMMARY');
      console.log('──────────────────────────────────────────');
      console.log('  Total answered:  %d', result.totalQuestions);
      console.log('  Correct: %d  |  Wrong: %d  |  Accuracy: %s', result.correctCount, result.wrongCount, result.accuracy);
      console.log('  Sources:  KB: %d  |  LLM: %d  |  Random: %d  |  Skip: %d',
        result.sourceCounts.kb, result.sourceCounts.llm, result.sourceCounts.random, result.sourceCounts.skip);
      console.log('  Duration:         %s', result.totalDuration);
      console.log('──────────────────────────────────────────');
      console.log('');
    } catch (err) {
      console.error('FATAL: %s', err.message);
      process.exit(1);
    }
  });

// ---------------------------------------------------------------------------
// setup — create or update a quiz profile
// ---------------------------------------------------------------------------
program
  .command('setup <name>')
  .description('Create or update a quiz profile')
  .requiredOption('-s, --source <qr-or-url>', 'QR image path or quiz URL')
  .option('--kb <dir>', 'Path to KB directory for this quiz (default: ./data/kb)')
  .option('--accuracy <number>', 'Default accuracy (0-1)', '1.0')
  .option('--speed <speed>', 'Default speed: fast|medium|slow', 'fast')
  .option('--user-id <id>', 'Set userId (visitor ID)')
  .option('--uuid <openid>', 'Set WeChat openid')
  .option('--wxc <code>', 'Set WeChat OAuth code')
  .option('--api-key <key>', 'LLM API key for this profile')
  .action(async (name, cmdOpts) => {
    let url = cmdOpts.source;
    let qrPath = null;

    if (isImagePath(url)) {
      qrPath = url;
      try {
        url = await parseQR(url);
        console.log('QR decoded: %s', url);
      } catch (err) {
        console.error('FATAL: QR decode failed: %s', err.message);
        process.exit(1);
      }
    }

    const session = {
      userId: cmdOpts.userId || '',
      uuid: cmdOpts.uuid || '',
      wxc: cmdOpts.wxc || '',
    };

    const profile = await setupProfile({
      name,
      source: cmdOpts.source,
      qrImage: qrPath,
      session,
      kbDir: cmdOpts.kb || null,
      accuracy: parseFloat(cmdOpts.accuracy),
      speed: cmdOpts.speed,
      llmApiKey: cmdOpts.apiKey || null,
    });

    console.log('Profile "%s" saved.', name);
    console.log('  URL: %s', url);
    console.log('  QR:  %s', qrPath || '(none)');
    console.log('  KB:  %s', profile.kbDir || '(none)');
    console.log('  userId: %s  uuid: %s', profile.session.userId || '(not set)', profile.session.uuid || '(not set)');
  });

// ---------------------------------------------------------------------------
// session — update session credentials for a profile
// ---------------------------------------------------------------------------
program
  .command('session <name>')
  .description('Update WeChat session credentials (userId, uuid, wxc) for a profile')
  .option('--user-id <id>', 'Visitor ID from getVisitor')
  .option('--uuid <openid>', 'WeChat openid')
  .option('--wxc <code>', 'WeChat OAuth code')
  .option('--from-saz <file>', 'Extract credentials from a Fiddler SAZ file')
  .action(async (name, cmdOpts) => {
    const profile = await getProfile(name);
    if (!profile) {
      console.error('Profile "%s" not found.', name);
      process.exit(1);
    }

    if (cmdOpts.fromSaz) {
      console.log('Extracting credentials from SAZ: %s', cmdOpts.fromSaz);
      try {
        const extracted = await extractFromSaz(cmdOpts.fromSaz);
        if (extracted.userId) profile.session.userId = extracted.userId;
        if (extracted.uuid) profile.session.uuid = extracted.uuid;
        if (extracted.wxc) profile.session.wxc = extracted.wxc;
        if (extracted.secretBoxCode) profile.secretBoxCode = extracted.secretBoxCode;
        if (extracted.secretKey) profile.secretKey = extracted.secretKey;
        if (extracted.baseUrl) profile.baseUrl = extracted.baseUrl;
        console.log('Extracted: userId=%s uuid=%s', extracted.userId || '(not found)', extracted.uuid || '(not found)');
      } catch (err) {
        console.error('SAZ extraction failed: %s', err.message);
      }
    }

    if (cmdOpts.userId) profile.session.userId = cmdOpts.userId;
    if (cmdOpts.uuid) profile.session.uuid = cmdOpts.uuid;
    if (cmdOpts.wxc) profile.session.wxc = cmdOpts.wxc;

    await saveProfile(name, profile);
    console.log('Session updated for "%s":', name);
    console.log('  userId: %s', profile.session.userId || '(not set)');
    console.log('  uuid:   %s', profile.session.uuid || '(not set)');
    console.log('  wxc:    %s', (profile.session.wxc || '').slice(0, 12) + '...');
  });

// ---------------------------------------------------------------------------
// list — show all profiles
// ---------------------------------------------------------------------------
program
  .command('list')
  .description('List all saved quiz profiles')
  .action(async () => {
    const { profiles, defaultProfile } = await loadProfiles();
    const names = Object.keys(profiles).sort();
    if (names.length === 0) {
      console.log('No profiles saved. Use "auto-quiz setup <name>" to create one.');
      return;
    }
    console.log('Profiles:');
    for (const name of names) {
      const p = profiles[name];
      const marker = name === defaultProfile ? ' ★' : '  ';
      const hasSession = p.session?.userId ? '🔑' : '⚠️ ';
      console.log('%s %s %s — KB: %s  |  %s',
        marker, hasSession, name,
        p.kbDir || '(none)',
        p.baseUrl ? `${p.baseUrl.replace('https://','')}` : '(no URL)');
    }
    console.log('');
    console.log(' ★ = default    🔑 = session set    ⚠️ = needs session');
    console.log('');
    console.log('Run:   auto-quiz run <name>');
    console.log('Setup: auto-quiz setup <name> -s <qr-or-url>');
  });

// ---------------------------------------------------------------------------
// batch — discover all people+quizzes from a SAZ file and create profiles
// ---------------------------------------------------------------------------
program
  .command('batch')
  .description('Scan a SAZ file for ALL users + quizzes, create profiles for everyone')
  .requiredOption('--saz <file>', 'Fiddler SAZ file with captures from all people')
  .option('--label <name>', 'Quiz label (e.g. "档案日") for profile naming')
  .option('--run', 'Also run the quiz for each person after setup')
  .action(async (cmdOpts) => {
    console.log('Scanning SAZ: %s', cmdOpts.saz);
    console.log('');

    let people;
    try {
      people = await discoverFromSaz(cmdOpts.saz);
    } catch (err) {
      console.error('SAZ scan failed: %s', err.message);
      process.exit(1);
    }

    if (people.length === 0) {
      console.log('No users found in SAZ. Make sure everyone opened the quiz link in WeChat.');
      console.log('Each person should see at least the first question before exporting.');
      process.exit(1);
    }

    console.log('Found %d person(s) in SAZ:', people.length);
    console.log('');

    const profiles = await createProfilesFromDiscover(people, cmdOpts.label);
    console.log('');
    console.log('Created %d profile(s).', profiles.length);
    console.log('');

    if (cmdOpts.run) {
      console.log('Running quizzes...');
      for (const name of profiles) {
        console.log('');
        console.log('━━━ %s ━━━', name);
        try {
          // Re-use the run logic — just call the run handler
          // For simplicity, shell out
          const { execSync } = await import('node:child_process');
          execSync(`node "${process.argv[1]}" run "${name}"`, {
            stdio: 'inherit',
            timeout: 600000,
          });
        } catch (err) {
          console.error('Run failed for %s: %s', name, err.message);
        }
      }
    } else {
      console.log('Run with:');
      for (const name of profiles) {
        console.log('  node src/cli.js run "%s"', name);
      }
    }
  });

// ---------------------------------------------------------------------------
// import — import study materials into a profile's KB
// ---------------------------------------------------------------------------
program
  .command('import <name>')
  .description('Import study materials (DOCX/JSON/MD/TXT) into profile KB')
  .requiredOption('-f, --file <path>', 'Study material file to import')
  .option('-t, --tags <tags>', 'Comma-separated tags for all imported entries')
  .action(async (name, cmdOpts) => {
    const profile = await getProfile(name);
    if (!profile) {
      console.error('Profile "%s" not found.', name);
      process.exit(1);
    }

    const kbDir = profile.kbDir || join(homedir(), '.auto-quiz', `kb-${name}`);
    const kb = new KnowledgeBase(kbDir);

    const ext = basename(cmdOpts.file).split('.').pop()?.toLowerCase();
    const tags = cmdOpts.tags ? cmdOpts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];

    console.log('Importing %s into "%s" KB...', cmdOpts.file, name);

    let count = 0;
    if (ext === 'docx') {
      // Use the DOCX import logic (red text = answer)
      const { execSync } = await import('node:child_process');
      const xml = execSync(`unzip -p "${cmdOpts.file}" word/document.xml`, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
      const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
      const paragraphs = xml.match(paraRegex) || [];

      for (const para of paragraphs) {
        const runRegex = /<w:r[\s>][\s\S]*?<\/w:r>/g;
        const runs = para.match(runRegex) || [];
        let questionParts = [], answer = '';

        for (const run of runs) {
          const textMatch = run.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
          if (!textMatch) continue;
          const text = textMatch[1];
          const isRed = /<w:color[^>]*w:val="[^"]*[Rr][Ee][Dd]|FF0000|C00000/.test(run);
          if (isRed) answer = text;
          else questionParts.push(text);
        }

        const question = questionParts.join('').replace(/\s+/g, '').trim();
        if (question && answer && question.length > 5 && answer.length < 200) {
          await kb.add({ question, answer, tags });
          count++;
        }
      }
    } else if (ext === 'json') {
      count = await kb.importFromJSON(cmdOpts.file, { tags });
    } else if (ext === 'md' || ext === 'markdown') {
      count = await kb.importFromMarkdown(cmdOpts.file, { tags });
    } else {
      // Plain text — try Q&A line-pair format
      const content = await readFile(cmdOpts.file, 'utf-8');
      const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length - 1; i += 2) {
        const q = lines[i].replace(/^[Qq]\d*[.、:：]\s*/, '').trim();
        const a = lines[i + 1].replace(/^[Aa]\d*[.、:：]\s*/, '').trim();
        if (q && a && q.length > 3) {
          await kb.add({ question: q, answer: a, tags });
          count++;
        }
      }
    }

    console.log('Imported %d Q&A pairs.', count);
    console.log('KB now has %d entries.', kb.size);

    // Save KB path to profile
    if (!profile.kbDir) {
      profile.kbDir = kbDir;
      await saveProfile(name, profile);
      console.log('KB path saved to profile: %s', kbDir);
    }
  });

// ---------------------------------------------------------------------------
// kb — knowledge base management
// ---------------------------------------------------------------------------
const kbCmd = program.command('kb').description('Manage the knowledge base');

kbCmd
  .command('add')
  .description('Manually add a Q&A pair to the KB')
  .requiredOption('-q, --question <text>', 'Question text')
  .requiredOption('-a, --answer <text>', 'Answer text')
  .option('-t, --tags <tags>', 'Comma-separated tags')
  .action(async (cmdOpts) => {
    const config = await resolveConfig(program.opts());
    const kb = new KnowledgeBase(config.kbDir);
    const tags = cmdOpts.tags ? cmdOpts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const id = await kb.add({ question: cmdOpts.question, answer: cmdOpts.answer, tags });
    console.log(`Added entry: ${id}`);
  });

kbCmd
  .command('import')
  .description('Bulk import Q&A pairs from a file')
  .requiredOption('-f, --file <path>', 'File to import (JSON or Markdown)')
  .option('--format <format>', 'File format: json|markdown')
  .option('-t, --tags <tags>', 'Comma-separated tags to attach')
  .action(async (cmdOpts) => {
    const config = await resolveConfig(program.opts());
    const kb = new KnowledgeBase(config.kbDir);
    const tags = cmdOpts.tags ? cmdOpts.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
    const ext = (cmdOpts.format || basename(cmdOpts.file).split('.').pop() || 'json').toLowerCase();
    const isMd = ext === 'markdown' || ext === 'md';

    let count;
    if (isMd) {
      count = await kb.importFromMarkdown(cmdOpts.file, { tags });
    } else {
      count = await kb.importFromJSON(cmdOpts.file, { tags });
    }
    console.log(`Imported ${count} entries.`);
  });

kbCmd
  .command('export')
  .description('Export all Q&A pairs to a JSON file')
  .requiredOption('-f, --file <path>', 'Output file path')
  .action(async (cmdOpts) => {
    const config = await resolveConfig(program.opts());
    const kb = new KnowledgeBase(config.kbDir);
    const count = await kb.exportToJSON(cmdOpts.file);
    console.log(`Exported ${count} entries to ${cmdOpts.file}`);
  });

kbCmd
  .command('stats')
  .description('Show knowledge base statistics')
  .action(async () => {
    const config = await resolveConfig(program.opts());
    const kb = new KnowledgeBase(config.kbDir);
    const s = await kb.stats();
    console.log(`Total entries: ${s.total}`);
    if (Object.keys(s.byTag).length > 0) {
      console.log('By tag:');
      for (const [tag, count] of Object.entries(s.byTag)) {
        console.log(`  ${tag}: ${count}`);
      }
    }
  });

// ---------------------------------------------------------------------------
// config — persist settings
// ---------------------------------------------------------------------------
program
  .command('config')
  .description('Set configuration values (persisted to ~/.auto-quiz.json)')
  .option('--api-key <key>', 'Set DeepSeek API key for LLM fallback')
  .action(async (cmdOpts) => {
    const cfg = await loadConfigFile();
    if (cmdOpts.apiKey !== undefined) {
      cfg.apiKey = cmdOpts.apiKey;
      await saveConfigFile(cfg);
      console.log('API key saved to %s', CONFIG_FILE);
    }
    if (cmdOpts.apiKey === undefined) {
      // Print current config (redact key)
      const display = { ...cfg };
      if (display.apiKey) display.apiKey = display.apiKey.slice(0, 6) + '...';
      console.log('Current config (%s):', CONFIG_FILE);
      console.log(JSON.stringify(display, null, 2));
    }
  });

// ---------------------------------------------------------------------------
// Session engine
// ---------------------------------------------------------------------------

/** Image file extensions that trigger QR decoding instead of URL navigation. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.webp']);

/**
 * Determine whether a source string is a local image path (for QR decoding)
 * or a URL to navigate to directly.
 */
function isImagePath(source) {
  const lower = source.toLowerCase();
  for (const ext of IMAGE_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  // Also treat paths that exist on disk as images
  if (existsSync(source) && !/^https?:\/\//i.test(source)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// capture — start automatic credential capture proxy (mitmproxy preferred)
// ---------------------------------------------------------------------------
program
  .command('capture')
  .description('Start automatic WeChat quiz credential capture proxy')
  .option('-p, --port <number>', 'Proxy listen port', '8899')
  .option('--web', 'Start mitmweb (browser UI) instead of headless mitmdump')
  .option('--cert', 'Show CA cert install path and exit')
  .action(async (cmdOpts) => {
    const { spawn, execSync } = await import('node:child_process');
    const { CA_CERT_PATH } = await import('./capture/ca.js');
    const addonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'capture_addon.py');
    const port = cmdOpts.port || '8899';
    const SESSION_FILE = join(homedir(), '.auto-quiz-session.json');

    // --cert: show CA cert install instructions
    if (cmdOpts.cert) {
      console.log('CA Certificate: %s', CA_CERT_PATH);
      console.log('');
      console.log('Install on phone:');
      console.log('  Android: Settings → Security → Install from storage → select ca-cert.pem');
      console.log('  iOS:     Settings → General → About → Certificate Trust Settings');
      console.log('  或手机浏览器开 http://mitm.it → 装 CA 证书（mitmproxy 运行时）');
      process.exit(0);
    }

    // ---- Find mitmproxy ----
    let mitmEngine = null; // 'mitmproxy' | 'node'

    // Try to find mitmproxy
    const mitmCmd = cmdOpts.web ? 'mitmweb' : 'mitmdump';
    const mitmPaths = [
      mitmCmd, // PATH
      'C:\\Program Files\\mitmproxy\\bin\\mitmdump.exe',
      'C:\\Program Files (x86)\\mitmproxy\\bin\\mitmdump.exe',
      join(homedir(), 'AppData', 'Local', 'Programs', 'mitmproxy', 'mitmdump.exe'),
      join(homedir(), '.local', 'bin', 'mitmdump'),
    ];

    let mitmPath = null;
    for (const p of mitmPaths) {
      if (p === mitmCmd) {
        try { execSync(process.platform === 'win32' ? `where ${mitmCmd} 2>nul` : `which ${mitmCmd} 2>/dev/null`, { stdio: 'pipe' }); mitmPath = mitmCmd; break; }
        catch { continue; }
      }
      if (existsSync(p)) { mitmPath = p; break; }
    }

    if (mitmPath) {
      mitmEngine = 'mitmproxy';
    } else {
      // Fallback: pure Node.js proxy
      mitmEngine = 'node';
    }

    // ---- Get local IP ----
    let localIP = 'YOUR_IP';
    try {
      const ifaces = networkInterfaces();
      for (const addrs of Object.values(ifaces)) {
        for (const a of addrs) {
          if (a.family === 'IPv4' && !a.internal) { localIP = a.address; break; }
        }
        if (localIP !== 'YOUR_IP') break;
      }
    } catch {}

    // ---- Display instructions ----
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  🔍 auto-quiz Credential Capture                ║');
    console.log('╠══════════════════════════════════════════════════╣');
    const engineLabel = (mitmEngine === 'mitmproxy' ? `mitmproxy (${mitmPath})` : 'Node.js fallback').padEnd(40);
    console.log('║  Engine: %s ║', engineLabel);
    console.log('║  Proxy:  %s:%s                          ║', localIP, port);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║  操作步骤（手机）：                              ║');
    console.log('║  1. WiFi 设代理 → %s:%s               ║', localIP, port);
    console.log('║  2. 装 CA 证书: 手机浏览器开 http://mitm.it     ║');
    console.log('║     (仅 mitmproxy; Node 模式手动装 ca-cert.pem)   ║');
    console.log('║  3. 微信打开答题链接 → 点"开始答题"             ║');
    console.log('║  4. 凭据自动保存 ✅                              ║');
    console.log('║  5. 按 Ctrl+C 停止                                ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
    console.log('[capture] Press Ctrl+C to stop...');
    console.log('');

    // ---- Start proxy ----
    let proc = null;
    let server = null;

    const showSummary = () => {
      if (existsSync(SESSION_FILE)) {
        try {
          const raw = readFileSync(SESSION_FILE, 'utf-8');
          const session = JSON.parse(raw);
          console.log('');
          console.log('╔══════════════════════════════════════════════════╗');
          console.log('║  📋 Captured Credentials                         ║');
          console.log('╠══════════════════════════════════════════════════╣');
          if (session.userId) console.log('║  userId: %s ║', session.userId.padEnd(40));
          if (session.uuid)   console.log('║  uuid:   %s ║', session.uuid.padEnd(40));
          if (session.wxc)    console.log('║  wxc:    %s ║', (session.wxc.substring(0, 20) + '...').padEnd(40));
          console.log('╠══════════════════════════════════════════════════╣');
          console.log('║  Run:   auto-quiz run <profile>                  ║');
          console.log('╚══════════════════════════════════════════════════╝');
          console.log('');
        } catch {}
      }
    };

    const cleanup = () => {
      console.log('');
      console.log('[capture] Stopping...');
      if (mitmEngine === 'mitmproxy' && proc) {
        proc.kill('SIGINT');
        setTimeout(() => { if (!proc.killed) proc.kill('SIGTERM'); }, 3000);
      } else if (mitmEngine === 'node' && server) {
        server.close(() => {
          console.log('[capture] Capture proxy stopped.');
          showSummary();
        });
      }
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    if (mitmEngine === 'mitmproxy') {
      // ---- mitmproxy mode ----
      const args = ['-s', addonPath, '--listen-port', port];
      if (!cmdOpts.web) args.push('--quiet');

      proc = spawn(mitmPath, args, { stdio: 'inherit', env: { ...process.env } });

      await new Promise((resolve) => {
        proc.on('exit', (code) => {
          console.log('[capture] mitmproxy stopped.');
          showSummary();
          resolve();
        });
      });
    } else {
      // ---- Node.js fallback ----
      const { startProxy } = await import('./capture/proxy.js');
      server = await startProxy({ port });
      await new Promise(() => {}); // keep alive
    }
  });

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
program.parse(process.argv);
