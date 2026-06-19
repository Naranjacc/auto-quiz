/**
 * Batch profile extractor — from one SAZ file, discover all unique
 * (userId, uuid, quizBox) combinations and set up profiles for each.
 *
 * Usage:
 *   node src/cli.js batch --saz capture.saz
 *
 * This scans the SAZ for:
 *   - getVisitor responses: maps openid → visitorId
 *   - startExplore / getSecretBox* requests: maps secretBoxCode → secretKey → baseUrl
 *   - registerInfo: user's name, phone, department
 *
 * Then creates one profile per (name, quizBox) pair.
 */

import { readFile, rm, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';

import { saveProfile, listProfiles } from './profile.js';

/**
 * @typedef {object} DiscoveredPerson
 * @property {string} name        - From registerInfo.name
 * @property {string} phone       - From registerInfo.phone
 * @property {string} userId      - visitorId
 * @property {string} uuid        - WeChat openid
 * @property {string} wxc         - WeChat OAuth code (may be expired)
 * @property {string} department  - value1 from registerInfo
 * @property {string} baseUrl
 * @property {string} secretBoxCode
 * @property {string} secretKey
 */

/**
 * Extract all unique person+quiz combinations from a SAZ file.
 *
 * @param {string} sazPath
 * @returns {Promise<DiscoveredPerson[]>}
 */
export async function discoverFromSaz(sazPath) {
  const tmpDir = join(tmpdir(), `batch-saz-${randomUUID().slice(0, 8)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    execSync(`unzip -o "${sazPath}" -d "${tmpDir}"`, { stdio: 'pipe', timeout: 30000 });

    const rawDir = join(tmpDir, 'raw');
    if (!existsSync(rawDir)) throw new Error('Invalid SAZ: no raw/ directory');

    const files = (await readdir(rawDir)).sort();

    // Map: openid → visitor metadata (from getVisitor responses)
    const visitorMap = new Map();

    // Map: visitorId → user info (from getSecretBoxFromWeChat responses)
    const registerMap = new Map();

    // Map: secretBoxCode → { secretKey, baseUrl }
    const quizMap = new Map();

    // Scan all request files for params
    for (const file of files) {
      if (!file.endsWith('_c.txt')) continue;
      const content = await readFile(join(rawDir, file), 'utf-8');
      const lines = content.split(/\r?\n/);
      const firstLine = lines[0] || '';
      const body = lines[lines.length - 1] || '';
      const params = new URLSearchParams(body);

      // Extract baseUrl
      const urlMatch = firstLine.match(/https?:\/\/([^\/]+)\//);
      if (urlMatch) {
        const host = urlMatch[1];
        const box = params.get('secretBoxCode');
        const key = params.get('secretKey');
        if (box && key && !quizMap.has(box)) {
          quizMap.set(box, { secretKey: key, baseUrl: `https://${host}` });
        }
      }

      // Track startExplore params (has userId + uuid + secretBoxCode + wxc)
      if (firstLine.includes('startExplore') || firstLine.includes('getSecretBoxFromWeChat')) {
        const uid = params.get('userId');
        const uuid = params.get('uuid');
        const wxc = params.get('wxc');
        const box = params.get('secretBoxCode');

        if (uid && uid !== '0' && uuid && !visitorMap.has(uuid)) {
          visitorMap.set(uuid, { userId: uid, uuid, wxc: wxc || '', quizBox: box });
        }
      }
    }

    // Scan response files for registerInfo + getVisitor results
    for (const file of files) {
      if (!file.endsWith('_s.txt')) continue;
      const content = await readFile(join(rawDir, file), 'utf-8');
      const parts = content.split(/\r?\n\r?\n/);
      if (parts.length < 2) continue;

      try {
        // Handle chunked transfer encoding: strip hex chunk size lines
        let bodyText = parts.slice(1).join('\n\n');
        bodyText = bodyText.replace(/^[0-9a-fA-F]+\r?\n/gm, '').replace(/\r?\n0\r?\n[\s\S]*$/m, '');
        const jsonStr = bodyText.trim().split('\n')[0];
        const json = JSON.parse(jsonStr);

        // getVisitor response
        if (json.visitorId && json.visitorId !== 0 && json.openId && !json.openId.startsWith('Error')) {
          const uid = String(json.visitorId);
          if (!visitorMap.has(json.openId)) {
            visitorMap.set(json.openId, { userId: uid, uuid: json.openId, wxc: '', quizBox: '' });
          }
        }

        // getSecretBoxFromWeChat response (has registerInfo)
        if (json.registerInfo && json.registerInfo.name) {
          const ri = json.registerInfo;
          const uid = String(ri.visitorId);
          registerMap.set(uid, {
            name: ri.name,
            phone: ri.phone || '',
            department: ri.value1 || '',
          });
        }
      } catch { /* skip non-JSON */ }
    }

    // Merge: build person list
    const people = [];
    for (const [, v] of visitorMap) {
      const reg = registerMap.get(v.userId) || {};
      const quiz = quizMap.get(v.quizBox) || {};

      people.push({
        name: reg.name || `用户${v.userId.slice(-4)}`,
        phone: reg.phone || '',
        department: reg.department || '',
        userId: v.userId,
        uuid: v.uuid,
        wxc: v.wxc || '',
        baseUrl: quiz.baseUrl || '',
        secretBoxCode: v.quizBox || '',
        secretKey: quiz.secretKey || '',
      });
    }

    return people;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Create profiles from discovered people.
 *
 * Profile naming: "{name}-{quizLabel}" if multiple quizzes,
 * or just "{name}" if single quiz.
 *
 * @param {DiscoveredPerson[]} people
 * @param {string} [quizLabel] - Optional label for the quiz (e.g. "档案日")
 * @returns {Promise<string[]>} Created profile names
 */
export async function createProfilesFromDiscover(people, quizLabel = '') {
  const quizCount = new Set(people.map(p => p.secretBoxCode)).size;
  const created = [];

  for (const person of people) {
    let profileName;
    if (quizLabel) {
      profileName = quizLabel;  // single quiz, just use label
    } else if (quizCount > 1) {
      profileName = `${person.name}-${person.secretBoxCode.slice(0, 6)}`;
    } else {
      profileName = person.name;
    }

    // If profile already exists, append userId suffix
    const existing = await listProfiles();
    if (existing.includes(profileName) && people.length > 1) {
      profileName = `${profileName}-${person.userId.slice(-4)}`;
    }

    await saveProfile(profileName, {
      baseUrl: person.baseUrl,
      secretBoxCode: person.secretBoxCode,
      secretKey: person.secretKey,
      session: {
        userId: person.userId,
        uuid: person.uuid,
        wxc: person.wxc,
      },
      kbDir: null,
      qrImage: null,
      accuracy: 1.0,
      speed: 'fast',
      llmApiKey: null,
    });

    created.push(profileName);
    console.log('  ✓ %s — %s (%s) — %s',
      profileName,
      person.name,
      person.department || person.phone || '?',
      person.secretBoxCode.slice(0, 6) + '...');
  }

  return created;
}
