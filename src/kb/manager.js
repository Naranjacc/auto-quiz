import { readFile, writeFile, unlink, readdir, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const KB_FILE_EXT = '.json';

export class KnowledgeBase {
  /** @type {Map<string, object>} */
  #entries = new Map();
  #kbDir;

  #ready = false;

  /**
   * @param {string} kbDir - Path to the knowledge base data directory
   */
  constructor(kbDir) {
    this.#kbDir = kbDir;
  }

  /**
   * Ensure the KB is loaded (idempotent — only loads once).
   */
  async #ensureReady() {
    if (this.#ready) return;
    if (!existsSync(this.#kbDir)) {
      await mkdir(this.#kbDir, { recursive: true });
    }
    await this.#loadAll();
    this.#ready = true;
  }

  // -- Private helpers --

  #filePath(id) {
    return join(this.#kbDir, `${id}${KB_FILE_EXT}`);
  }

  async #loadAll() {
    this.#entries.clear();
    const files = await readdir(this.#kbDir);
    for (const file of files) {
      if (!file.endsWith(KB_FILE_EXT)) continue;
      try {
        const raw = await readFile(join(this.#kbDir, file), 'utf-8');
        const entry = JSON.parse(raw);
        if (entry.id && entry.question) {
          this.#entries.set(entry.id, entry);
        }
      } catch {
        // Skip malformed or unreadable files
      }
    }
  }

  // -- Public API --

  /**
   * Add a Q&A pair and persist to disk.
   * @param {{ question: string, answer: string, tags?: string[], source?: string }} qa
   * @returns {Promise<string>} The generated id of the stored entry
   */
  async add(qa) {
    await this.#ensureReady();
    const entry = {
      id: randomUUID(),
      question: qa.question,
      answer: qa.answer,
      tags: qa.tags ?? [],
      source: qa.source ?? 'manual',
      createdAt: new Date().toISOString(),
      hitCount: 0,
    };
    await writeFile(this.#filePath(entry.id), JSON.stringify(entry, null, 2), 'utf-8');
    this.#entries.set(entry.id, entry);
    return entry.id;
  }

  /**
   * Remove a Q&A pair by id.
   * @param {string} id
   * @returns {boolean} true if removed, false if not found
   */
  async remove(id) {
    await this.#ensureReady();
    if (!this.#entries.has(id)) return false;
    this.#entries.delete(id);
    try {
      await unlink(this.#filePath(id));
    } catch {
      // File may already be gone — that's fine
    }
    return true;
  }

  /**
   * List all Q&A pairs, optionally filtered by tag.
   * @param {string} [filter] - Optional tag to filter by
   * @returns {object[]}
   */
  async list(filter) {
    await this.#ensureReady();
    const all = [...this.#entries.values()];
    if (!filter) return all;
    const tag = filter.toLowerCase();
    return all.filter(e => e.tags.some(t => t.toLowerCase() === tag));
  }

  /**
   * Get a single entry by id.
   * @param {string} id
   * @returns {object|undefined}
   */
  async get(id) {
    await this.#ensureReady();
    return this.#entries.get(id);
  }

  /**
   * Increment hitCount for an entry.
   * Does NOT persist to disk (hitCounts are session-volatile by default).
   * @param {string} id
   */
  async recordHit(id) {
    await this.#ensureReady();
    const entry = this.#entries.get(id);
    if (entry) entry.hitCount += 1;
  }

  /**
   * Import Q&A pairs from a Markdown file.
   * Supports three formats:
   *   1. **Q:** ... **A:** ...   (inline, possibly multi-line)
   *   2. ## 问题 / ## 答案 section pairs
   *   3. Numbered list items with "Answer:" follow-up
   *
   * @param {string} filePath - Path to the .md file
   * @param {{ source?: string, tags?: string[] }} [opts]
   * @returns {Promise<number>} Number of entries imported
   */
  async importFromMarkdown(filePath, opts = {}) {
    const raw = await readFile(filePath, 'utf-8');
    const pairs = [];

    // Strategy 1: **Q:** … **A:** … patterns (supports multiline Q/A)
    const qaPattern = /\*\*Q:\*\*\s*([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)(?=\n\*\*Q:\*\*|\n#|$)/gi;
    let match;
    while ((match = qaPattern.exec(raw)) !== null) {
      pairs.push({
        question: match[1].replace(/\s+/g, ' ').trim(),
        answer: match[2].replace(/\s+/g, ' ').trim(),
      });
    }

    // Strategy 2: ## 问题 / ## 答案 section pairs
    // Split on ## headings, look for consecutive 问题 → 答案 blocks
    const headingRegex = /^## (.+)$/gm;
    const sections = [];
    let lastIdx = 0;
    while ((match = headingRegex.exec(raw)) !== null) {
      if (sections.length > 0) {
        sections[sections.length - 1].body = raw.slice(lastIdx, match.index).trim();
      }
      sections.push({ heading: match[1].trim(), index: match.index, body: '' });
      lastIdx = match.index + match[0].length;
    }
    if (sections.length > 0) {
      sections[sections.length - 1].body = raw.slice(lastIdx).trim();
    }

    for (let i = 0; i < sections.length - 1; i++) {
      const qHeading = sections[i].heading;
      const aHeading = sections[i + 1].heading;
      if (/问题|question/i.test(qHeading) && /答案|answer/i.test(aHeading)) {
        const qText = sections[i].body || '';
        const aText = sections[i + 1].body || '';
        if (qText.trim() && aText.trim()) {
          pairs.push({
            question: qText.replace(/\s+/g, ' ').trim(),
            answer: aText.replace(/\s+/g, ' ').trim(),
          });
          i++; // skip the answer section for next iteration
        }
      }
    }

    // Strategy 3: Numbered list with "Answer:" follow-up
    // Match patterns like:
    //   1. What is X?
    //   Answer: X is Y.
    const numberedPattern = /\d+[.)]\s+(.+?)\n(?:.*\n)*?\bAnswer\s*:\s*(.+?)(?=\n\d+[.)]|\n*$)/gi;
    while ((match = numberedPattern.exec(raw)) !== null) {
      pairs.push({
        question: match[1].replace(/\s+/g, ' ').trim(),
        answer: match[2].replace(/\s+/g, ' ').trim(),
      });
    }

    // Deduplicate by normalized question text before importing
    const seen = new Set();
    const meta = {
      source: opts.source ?? 'imported',
      tags: opts.tags ?? [],
    };
    let count = 0;
    for (const pair of pairs) {
      const norm = pair.question.toLowerCase().replace(/\s+/g, '');
      if (!seen.has(norm)) {
        seen.add(norm);
        if (pair.question.length >= 3 && pair.answer.length > 0) {
          await this.add({ ...pair, ...meta });
          count++;
        }
      }
    }
    return count;
  }

  /**
   * Bulk import from a JSON file containing an array of Q&A objects.
   * Each object must have at least `question` and `answer`.
   * @param {string} filePath - Path to the JSON file
   * @param {{ source?: string, tags?: string[] }} [opts]
   * @returns {Promise<number>} Number of entries imported
   */
  async importFromJSON(filePath, opts = {}) {
    const raw = await readFile(filePath, 'utf-8');
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) {
      throw new TypeError('importFromJSON: file must contain a JSON array');
    }
    const meta = {
      source: opts.source ?? 'imported',
      tags: opts.tags ?? [],
    };
    let count = 0;
    for (const item of arr) {
      if (!item.question || !item.answer) continue;
      if (item.question.length < 3) continue;
      await this.add({
        question: item.question,
        answer: item.answer,
        tags: [...meta.tags, ...(item.tags ?? [])],
        source: item.source ?? meta.source,
      });
      count++;
    }
    return count;
  }

  /**
   * Export all Q&A pairs to a single JSON file.
   * @param {string} filePath - Destination path
   */
  async exportToJSON(filePath) {
    await this.#ensureReady();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    const all = [...this.#entries.values()];
    await writeFile(filePath, JSON.stringify(all, null, 2), 'utf-8');
    return all.length;
  }

  /**
   * Return statistics about the knowledge base.
   * @returns {{ total: number, byTag: Record<string, number> }}
   */
  async stats() {
    await this.#ensureReady();
    const byTag = {};
    for (const entry of this.#entries.values()) {
      for (const tag of entry.tags) {
        byTag[tag] = (byTag[tag] ?? 0) + 1;
      }
    }
    return { total: this.#entries.size, byTag };
  }

  /**
   * Get the raw Map iterator for use by external code (e.g., search).
   * @returns {IterableIterator<object>}
   */
  /**
   * Sync iterator — throws if not ready. Caller must ensure KB is initialized.
   */
  [Symbol.iterator]() {
    if (!this.#ready) throw new Error('KnowledgeBase not initialized — await kb.list() first');
    return this.#entries.values();
  }

  /**
   * Number of entries currently loaded. Throws if not ready.
   */
  get size() {
    if (!this.#ready) throw new Error('KnowledgeBase not initialized — await kb.list() first');
    return this.#entries.size;
  }
}
