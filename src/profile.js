/**
 * Quiz profile manager — persists quiz configurations so the user can
 * run quizzes by name without re-entering URLs or credentials each time.
 *
 * Profiles stored at ~/.auto-quiz/profiles.json
 *
 * Profile shape:
 *   {
 *     name: string,           // e.g. "档案日"
 *     baseUrl: string,        // e.g. "https://x218549.fengchuanba.com"
 *     secretBoxCode: string,  // from URL hash
 *     secretKey: string,      // from URL hash
 *     session: {
 *       userId: string,
 *       uuid: string,         // WeChat openid
 *       wxc: string,          // WeChat OAuth code (may expire)
 *     },
 *     qrImage: string|null,   // path to QR image
 *     kbDir: string|null,    // path to KB JSON
 *     accuracy: number,
 *     speed: string,
 *     llmApiKey: string|null,
 *   }
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseQuizUrl } from './api/client.js';
import { loadConfig } from './config.js';

const PROFILE_DIR = join(homedir(), '.auto-quiz');
const PROFILE_FILE = join(PROFILE_DIR, 'profiles.json');
const CONFIG_FILE = join(homedir(), '.auto-quiz.json');

/** Load the persisted config file (for API key etc.). */
async function loadConfigFile() {
  if (existsSync(CONFIG_FILE)) {
    try { return JSON.parse(await readFile(CONFIG_FILE, 'utf-8')); } catch { /* */ }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

async function ensureDir() {
  if (!existsSync(PROFILE_DIR)) {
    await mkdir(PROFILE_DIR, { recursive: true });
  }
}

/**
 * Load all profiles from disk.
 * @returns {Promise<object>} { profiles: { [name]: Profile }, defaultProfile: string|null }
 */
export async function loadProfiles() {
  await ensureDir();
  if (!existsSync(PROFILE_FILE)) {
    return { profiles: {}, defaultProfile: null };
  }
  try {
    const raw = await readFile(PROFILE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { profiles: {}, defaultProfile: null };
  }
}

/**
 * Save profiles to disk.
 */
export async function saveProfiles(data) {
  await ensureDir();
  await writeFile(PROFILE_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Get a single profile by name.
 */
export async function getProfile(name) {
  const { profiles } = await loadProfiles();
  return profiles[name] || null;
}

/**
 * Save (create or update) a profile.
 */
export async function saveProfile(name, profile) {
  const data = await loadProfiles();
  data.profiles[name] = { ...data.profiles[name], ...profile, name };
  await saveProfiles(data);
  return data.profiles[name];
}

/**
 * Delete a profile.
 */
export async function deleteProfile(name) {
  const data = await loadProfiles();
  delete data.profiles[name];
  if (data.defaultProfile === name) data.defaultProfile = null;
  await saveProfiles(data);
}

/**
 * List all profile names.
 */
export async function listProfiles() {
  const { profiles } = await loadProfiles();
  return Object.keys(profiles).sort();
}

/**
 * Set the default profile.
 */
export async function setDefaultProfile(name) {
  const data = await loadProfiles();
  if (!data.profiles[name]) throw new Error(`Profile "${name}" not found`);
  data.defaultProfile = name;
  await saveProfiles(data);
}

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

/**
 * Build a profile from a QR image or URL + optional session data.
 *
 * @param {object} opts
 * @param {string} opts.name         - Profile name
 * @param {string} opts.source       - QR image path or quiz URL
 * @param {string} [opts.qrImage]    - Path to save QR image (if source is image)
 * @param {object} [opts.session]    - { userId, uuid, wxc }
 * @param {string} [opts.kbDir]     - Path to KB JSON file
 * @param {number} [opts.accuracy]   - Default 1.0
 * @param {string} [opts.speed]      - Default 'fast'
 * @param {string} [opts.llmApiKey]  - Optional LLM API key
 * @returns {Promise<object>} The saved profile
 */
export async function setupProfile(opts) {
  const { name, source, session = {}, kbDir, accuracy = 1.0, speed = 'fast', llmApiKey } = opts;

  let baseUrl, secretBoxCode, secretKey;

  // If source is a URL, parse it directly
  if (/^https?:\/\//i.test(source)) {
    const parsed = parseQuizUrl(source, session);
    baseUrl = parsed.baseUrl;
    secretBoxCode = parsed.secretBoxCode;
    secretKey = parsed.secretKey;
  } else {
    // It's a QR image — we need to decode it first
    // The caller should have already decoded the QR and passed the URL,
    // or will set qrImage for later decoding
    // For now, just store the QR path
  }

  // If we couldn't parse (QR image case), use session or empty values
  if (!baseUrl && session.baseUrl) baseUrl = session.baseUrl;
  if (!secretBoxCode && session.secretBoxCode) secretBoxCode = session.secretBoxCode;
  if (!secretKey && session.secretKey) secretKey = session.secretKey;

  const profile = {
    name,
    baseUrl: baseUrl || '',
    secretBoxCode: secretBoxCode || '',
    secretKey: secretKey || '',
    session: {
      userId: session.userId || '',
      uuid: session.uuid || '',
      wxc: session.wxc || '',
    },
    qrImage: /^https?:\/\//i.test(source) ? null : source,
    kbDir: kbDir || null,
    accuracy,
    speed,
    llmApiKey: llmApiKey || null,
  };

  return saveProfile(name, profile);
}

// ---------------------------------------------------------------------------
// Resolve a full config from a profile + runtime overrides
// ---------------------------------------------------------------------------

/**
 * Resolve runtime config from a profile (profile values override defaults,
 * persisted ~/.auto-quiz.json fills gaps, CLI flags override all).
 *
 * @param {object} profile  - A saved profile
 * @param {object} overrides - CLI-level overrides (accuracy, speed, etc.)
 * @returns {Promise<object>} Merged config
 */
export async function resolveFromProfile(profile, overrides = {}) {
  // Load persisted config for API key
  const fileCfg = await loadConfigFile();

  const cfg = loadConfig({
    accuracy: profile.accuracy ?? 1.0,
    speed: profile.speed ?? 'fast',
    ...overrides,
  });

  // LLM API key priority: CLI > profile > persisted config > defaults
  if (!cfg.llmApiKey && profile.llmApiKey) {
    cfg.llmApiKey = profile.llmApiKey;
  }
  if (!cfg.llmApiKey && fileCfg.apiKey) {
    cfg.llmApiKey = fileCfg.apiKey;
  }

  return cfg;
}
