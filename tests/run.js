/**
 * Quick integration smoke tests for auto-quiz modules.
 *
 * Run via: npm test
 * Or:     node tests/run.js
 */

import { strict as assert } from 'node:assert';
import { rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, loadConfig } from '../src/config.js';
import { KnowledgeBase } from '../src/kb/manager.js';
import { searchKB } from '../src/kb/search.js';
import { matchAnswer } from '../src/engine/matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_KB_DIR = join(__dirname, '..', 'data', 'kb', '_test');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

function testAsync(name, fn) {
  return fn()
    .then(() => {
      passed++;
      console.log(`  PASS  ${name}`);
    })
    .catch(err => {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${err.message}`);
    });
}

// Helper: create a fresh empty KB for each test
async function freshKB() {
  if (existsSync(TEST_KB_DIR)) {
    await rm(TEST_KB_DIR, { recursive: true, force: true });
  }
  const kb = new KnowledgeBase(TEST_KB_DIR);
  await kb.list(); // trigger lazy init
  return kb;
}

async function run() {
  console.log('\n=== auto-quiz module tests ===\n');

  // --- Config ---
  test('config: defaults have expected keys', () => {
    assert.ok(typeof defaults.accuracy === 'number');
    assert.ok(typeof defaults.speed === 'string');
    assert.ok(typeof defaults.headless === 'boolean');
    assert.ok(typeof defaults.kbDir === 'string');
    assert.ok(defaults.delayRanges.fast);
    assert.ok(defaults.delayRanges.medium);
    assert.ok(defaults.delayRanges.slow);
  });

  test('config: loadConfig merges overrides', () => {
    const cfg = loadConfig({ accuracy: 0.5, speed: 'fast' });
    assert.strictEqual(cfg.accuracy, 0.5);
    assert.strictEqual(cfg.speed, 'fast');
    assert.strictEqual(cfg.headless, true);
  });

  // --- Knowledge Base ---
  await testAsync('kb: init creates directory', async () => {
    const kb = await freshKB();
    assert.strictEqual(kb.size, 0);
    assert.ok(existsSync(TEST_KB_DIR));
  });

  await testAsync('kb: add returns id string, get fetches entry', async () => {
    const kb = await freshKB();
    const id = await kb.add({
      question: 'What is 2+2?',
      answer: '4',
      tags: ['math'],
      source: 'test',
    });
    assert.ok(typeof id === 'string' && id.length > 0);
    assert.strictEqual(kb.size, 1);

    const fetched = await kb.get(id);
    assert.ok(fetched);
    assert.strictEqual(fetched.question, 'What is 2+2?');
    assert.strictEqual(fetched.answer, '4');
  });

  await testAsync('kb: remove entry', async () => {
    const kb = await freshKB();
    const id = await kb.add({ question: 'Temp Q', answer: 'Temp A' });
    assert.strictEqual(kb.size, 1);
    const removed = await kb.remove(id);
    assert.strictEqual(removed, true);
    assert.strictEqual(kb.size, 0);
    assert.strictEqual(await kb.get(id), undefined);
  });

  await testAsync('kb: list and stats', async () => {
    const kb = await freshKB();
    await kb.add({ question: 'Q1', answer: 'A1', tags: ['math', 'easy'] });
    await kb.add({ question: 'Q2', answer: 'A2', tags: ['geo'] });

    const all = await kb.list();
    assert.strictEqual(all.length, 2);

    const stats = await kb.stats();
    assert.strictEqual(stats.total, 2);
    assert.strictEqual(stats.byTag.math, 1);
    assert.strictEqual(stats.byTag.geo, 1);
    assert.strictEqual(stats.byTag.easy, 1);
  });

  await testAsync('kb: import from JSON', async () => {
    const kb = await freshKB();
    const jsonPath = join(TEST_KB_DIR, '_import_test.json');
    await writeFile(jsonPath, JSON.stringify([
      { question: 'Capital of France?', answer: 'Paris', tags: ['geo'] },
      { question: 'Capital of Japan?', answer: 'Tokyo', tags: ['geo'] },
    ]));
    const count = await kb.importFromJSON(jsonPath, { source: 'test-import' });
    assert.strictEqual(count, 2);
    assert.strictEqual(kb.size, 2);
    await rm(jsonPath, { force: true });
  });

  // --- Search ---
  await testAsync('search: exact match', async () => {
    const kb = await freshKB();
    await kb.add({ question: 'Capital of France?', answer: 'Paris', tags: ['geo'] });

    const result = searchKB(kb, 'Capital of France?');
    assert.strictEqual(result.method, 'exact');
    assert.strictEqual(result.score, 1.0);
    assert.strictEqual(result.match.answer, 'Paris');
  });

  await testAsync('search: keyword match (was fuzzy)', async () => {
    const kb = await freshKB();
    await kb.add({ question: 'Capital of France?', answer: 'Paris', tags: ['geo'] });

    const result = searchKB(kb, 'Capital of France quiz');
    assert.ok(result.score >= 0.5);
    assert.strictEqual(result.match.answer, 'Paris');
    // Current API returns 'keyword' for high token overlap (not 'fuzzy')
    assert.ok(['keyword', 'fuzzy'].includes(result.method));
  });

  await testAsync('search: no match returns none', async () => {
    const kb = await freshKB();
    const result = searchKB(kb, 'xyzzy plugh no match possible here');
    assert.strictEqual(result.method, 'none');
    assert.strictEqual(result.match, null);
    assert.strictEqual(result.score, 0);
  });

  // --- Engine ---
  await testAsync('engine: kb match populates source', async () => {
    const kb = await freshKB();
    await kb.add({ question: 'Test engine Q', answer: 'Engine A', tags: ['test'] });

    const question = {
      id: 'test-q-1',
      text: 'Test engine Q',
      options: ['Engine A', 'Engine B', 'Engine C'],
      type: 'single',
      imageUrl: null,
      answer: null,
      source: null,
    };

    const cfg = { ...defaults, accuracy: 1.0 };
    const answered = await matchAnswer(question, kb, cfg);
    // source format: kb_exact / kb_keyword / kb_fuzzy / kb_substring
    assert.ok(answered.source.startsWith('kb_'));
    assert.ok(answered.answer);
  });

  await testAsync('engine: no KB match falls back to random', async () => {
    const kb = await freshKB();

    const question = {
      id: 'test-q-2',
      text: 'Completely unknown question nobody has ever asked before',
      options: ['Option 1', 'Option 2', 'Option 3'],
      type: 'single',
      imageUrl: null,
      answer: null,
      source: null,
    };

    const cfg = { ...defaults, llmApiKey: '' };
    const answered = await matchAnswer(question, kb, cfg);
    assert.strictEqual(answered.source, 'random');
    assert.ok(answered.answer);
  });

  // --- Cleanup ---
  await rm(TEST_KB_DIR, { recursive: true, force: true });

  // --- Summary ---
  console.log(`\n${passed} passed, ${failed} failed, ${passed + failed} total\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

run();
