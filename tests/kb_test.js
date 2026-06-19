import { KnowledgeBase } from '../src/kb/manager.js';
import { searchKB } from '../src/kb/search.js';

const kb = new KnowledgeBase('./data/kb');
let passed = 0, failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS: ${label}`, detail); }
  else { failed++; console.log(`  FAIL: ${label}`, detail); }
}

// Test 1: Add
const id = await kb.add({
  question: '信息安全三要素是什么？',
  answer: '保密性、完整性、可用性',
  tags: ['security', 'basics']
});
check('Add entry', !!id, id.slice(0,8));

// Test 2: List (also triggers #ensureReady)
const all = await kb.list();
check('List', all.length === 1, `count=${all.length}`);

// Test 3: Exact match (sync — KB is now ready)
const r1 = searchKB(kb, '信息安全三要素是什么？', {});
check('Exact match', r1.method === 'exact' && r1.score > 0.9, `method=${r1.method} score=${r1.score.toFixed(2)}`);

// Test 4: Fuzzy match
const r2 = searchKB(kb, '信息安全三大要素包括哪些', {});
check('Fuzzy match', r2.method === 'fuzzy' && r2.score >= 0.6, `method=${r2.method} score=${r2.score.toFixed(2)}`);

// Test 5: No match
const r3 = searchKB(kb, '今天天气怎么样', {});
check('No match', r3.method === 'none', `method=${r3.method}`);

// Test 6: Stats
const s = await kb.stats();
check('Stats', s.total === 1, JSON.stringify(s));

// Test 7: Remove
await kb.remove(id);
const after = await kb.list();
check('Remove', after.length === 0, `remaining=${after.length}`);

console.log(`\n${passed} passed, ${failed} failed`);
