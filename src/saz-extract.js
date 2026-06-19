/**
 * SAZ (Fiddler Session Archive) credential extractor.
 *
 * Extracts userId, uuid, wxc from a Fiddler SAZ capture of a WeChat quiz session.
 *
 * Usage:
 *   import { extractFromSaz } from './saz-extract.js';
 *   const creds = await extractFromSaz('./capture.saz');
 *   // → { userId, uuid, wxc, secretBoxCode, secretKey, baseUrl }
 */

import { execSync } from 'node:child_process';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

/**
 * Extract WeChat quiz session credentials from a Fiddler SAZ file.
 *
 * @param {string} sazPath - Path to the .saz file
 * @returns {Promise<object>} { userId, uuid, wxc, secretBoxCode, secretKey, baseUrl }
 */
export async function extractFromSaz(sazPath) {
  const tmpDir = join(tmpdir(), `saz-extract-${randomUUID().slice(0, 8)}`);
  await mkdir(tmpDir, { recursive: true });

  try {
    // SAZ is a ZIP file
    execSync(`unzip -o "${sazPath}" -d "${tmpDir}"`, { stdio: 'pipe', timeout: 10000 });

    const rawDir = join(tmpDir, 'raw');
    if (!existsSync(rawDir)) {
      throw new Error('No raw/ directory in SAZ — not a valid Fiddler archive');
    }

    // Scan all client request files (*_c.txt) for credentials
    const files = await readDir(rawDir);
    const cFiles = files.filter(f => /^\d+_c\.txt$/.test(f)).sort();

    const result = {
      userId: '',
      uuid: '',
      wxc: '',
      secretBoxCode: '',
      secretKey: '',
      baseUrl: '',
    };

    for (const file of cFiles) {
      const content = await readFile(join(rawDir, file), 'utf-8');

      // Parse HTTP request
      const lines = content.split(/\r?\n/);
      const firstLine = lines[0] || '';
      const body = lines[lines.length - 1] || '';

      // Extract baseUrl from request line
      const urlMatch = firstLine.match(/^(?:GET|POST|CONNECT)\s+https?:\/\/([^\/]+)/);
      if (urlMatch && !result.baseUrl) {
        result.baseUrl = `https://${urlMatch[1]}`;
      }

      // Parse URL-encoded body
      const params = new URLSearchParams(body);

      // Look for session credentials
      if (params.has('userId') && params.get('userId') !== '0') {
        result.userId = params.get('userId');
      }
      if (params.has('uuid') && params.get('uuid') !== '0' && !params.get('uuid')?.startsWith('Error')) {
        result.uuid = params.get('uuid');
      }
      if (params.has('wxc') && params.get('wxc')) {
        result.wxc = params.get('wxc');
      }
      if (params.has('secretBoxCode')) {
        result.secretBoxCode = params.get('secretBoxCode');
      }
      if (params.has('secretKey')) {
        result.secretKey = params.get('secretKey');
      }
    }

    // Also check getVisitor GET requests for uuid/userId
    for (const file of cFiles) {
      const content = await readFile(join(rawDir, file), 'utf-8');
      const firstLine = content.split(/\r?\n/)[0] || '';

      if (firstLine.includes('getVisitor')) {
        // The response (_s.txt) has the actual userId/uuid
        const respFile = file.replace('_c.txt', '_s.txt');
        if (existsSync(join(rawDir, respFile))) {
          try {
            const respContent = await readFile(join(rawDir, respFile), 'utf-8');
            // Find the JSON body (after HTTP headers, separated by blank line)
            const parts = respContent.split(/\r?\n\r?\n/);
            if (parts.length >= 2) {
              const json = JSON.parse(parts[1].trim().split('\n')[0]);
              if (json.visitorId && json.visitorId !== 0) result.userId = String(json.visitorId);
              if (json.openId && !json.openId.startsWith('Error')) result.uuid = json.openId;
            }
          } catch { /* skip parse errors */ }
        }
      }
    }

    return result;
  } finally {
    // Cleanup
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readDir(dir) {
  try {
    const { readdir } = await import('node:fs/promises');
    return readdir(dir);
  } catch {
    return [];
  }
}
