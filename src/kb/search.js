/**
 * Knowledge Base search engine.
 *
 * Multi-tier matching:
 *   1. Exact  – normalized string equality
 *   2. Keyword – overlapping key terms (threshold: 0.5)
 *   3. Fuzzy  – Jaccard similarity on bigram tokens (threshold: 0.25)
 *   4. Substring – containment check
 *
 * Preprocessing:
 *   - Strips number prefixes (e.g. "23、" → "") from both query and KB entries
 */

// ---------------------------------------------------------------------------
// Preprocessing — clean question text
// ---------------------------------------------------------------------------

/**
 * Strip numeric enumeration prefixes from Chinese quiz questions.
 *
 * Examples:
 *   "23、空气中含氧为..."  → "空气中含氧为..."
 *   "4、《中华人民共和国..." → "《中华人民共和国..."
 *   "1. What is X?"        → "What is X?"
 *   "(1) 安全生产..."       → "安全生产..."
 *   "（23）职业病..."        → "职业病..."
 */
export function cleanQuestion(text) {
  if (!text) return '';
  return text
    .replace(/^\s*\(\s*\d+\s*\)\s*/, '')     // (1), (23), ( 1 )
    .replace(/^\s*\d+\s*[、.．)\s]\s*/, '')    // 23、 1. 4) 1．
    .replace(/^\s*[（(]\s*\d+\s*[)）]\s*/, '') // （1） (23)
    .trim();
}

// ---------------------------------------------------------------------------
// Normalization & tokenization
// ---------------------------------------------------------------------------

/**
 * Normalize a string for comparison: lowercase, strip punctuation & extra whitespace.
 */
function normalize(str) {
  return str
    .toLowerCase()
    .replace(/[，。！？；：、""''（）【】《》…—\-.+*=/\()\[\]{}<>"',;:!?#|&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize a string into a set of unique word tokens.
 * Splits on whitespace; for CJK text, uses character bigrams.
 */
const CJK = /[一-鿿㐀-䶿]/;

function tokenize(str) {
  const normalized = normalize(str);
  if (!normalized) return new Set();
  if (CJK.test(normalized)) {
    const bigrams = new Set();
    for (let i = 0; i < normalized.length - 1; i++) {
      bigrams.add(normalized.substring(i, i + 2));
    }
    return bigrams;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter(t => t.length >= 2);
  return new Set(filtered.length > 0 ? filtered : tokens);
}

/**
 * Compute Jaccard similarity between two sets.
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Extract meaningful keywords from a question.
 * For Chinese: sliding window of 2-6 character chunks, filtering stop words.
 */
function extractKeywords(str) {
  const cleaned = str
    .replace(/[（(]\s*[）)]/g, ' ')
    .replace(/[，。！？；：、""''（）【】《》…—\-.+*=/\()\[\]{}<>"',;:!?#|&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const stopWords = new Set([
    '的', '是', '在', '了', '和', '与', '或', '对', '等', '不', '也', '就', '都',
    '要', '会', '可以', '应当', '必须', '根据', '按照', '下列', '以下', '属于',
    '进行', '使用', '规定', '单位', '人员', '安全', '生产', '经营'
  ]);

  const terms = [];
  for (let len = 6; len >= 2; len--) {
    for (let i = 0; i <= cleaned.length - len; i++) {
      const term = cleaned.substring(i, i + len);
      if (!stopWords.has(term) && !terms.some(t => t.includes(term))) {
        terms.push(term);
      }
    }
  }

  const unique = [...new Set(terms)];
  return unique.filter(t =>
    !unique.some(other => other !== t && other.includes(t) && other.length > t.length)
  ).slice(0, 30);
}

/**
 * Search the knowledge base for a matching Q&A entry.
 */
export function searchKB(kb, questionText, options = {}) {
  const NO_MATCH = { match: null, score: 0, method: 'none' };

  if (!kb || kb.size === 0) return NO_MATCH;
  if (!questionText || typeof questionText !== 'string') return NO_MATCH;
  if (questionText.trim().length < 3) return NO_MATCH;

  const cleanedQuery = cleanQuestion(questionText);
  const normQuery = normalize(cleanedQuery);
  if (normQuery.length === 0) return NO_MATCH;

  // --- Tier 1: Exact match ---
  for (const entry of kb) {
    const cleanedEntry = cleanQuestion(entry.question);
    const normEntry = normalize(cleanedEntry);
    if (normEntry === normQuery) {
      return { match: entry, score: 1.0, method: 'exact' };
    }
  }

  // --- Tier 2: Keyword overlap ---
  const queryKeywords = extractKeywords(cleanedQuery);
  let bestMatch = null;
  let bestScore = 0;
  let bestMethod = 'none';

  if (queryKeywords.length > 0) {
    for (const entry of kb) {
      if (!entry.question || entry.question.trim().length < 3) continue;
      const cleanedEntry = cleanQuestion(entry.question);
      const entryKeywords = extractKeywords(cleanedEntry);
      if (entryKeywords.length === 0) continue;
      const overlap = queryKeywords.filter(k => entryKeywords.includes(k));
      const score = overlap.length / queryKeywords.length;
      if (score >= 0.5 && score > bestScore) {
        bestScore = score;
        bestMatch = entry;
        bestMethod = 'keyword';
      }
    }
  }

  // --- Tier 3: Fuzzy (Jaccard, threshold 0.25) ---
  if (!bestMatch) {
    const queryTokens = tokenize(cleanedQuery);
    if (queryTokens.size > 0) {
      for (const entry of kb) {
        if (!entry.question || entry.question.trim().length < 3) continue;
        const cleanedEntry = cleanQuestion(entry.question);
        const entryTokens = tokenize(cleanedEntry);
        if (entryTokens.size === 0) continue;
        const score = jaccard(queryTokens, entryTokens);
        if (score >= 0.25 && score > bestScore) {
          bestScore = score;
          bestMatch = entry;
          bestMethod = 'fuzzy';
        }
      }
    }
  }

  // --- Tier 4: Substring containment ---
  if (!bestMatch) {
    const shortQ = cleanedQuery.replace(/[（(]\s*[）)]/g, '').replace(/\s+/g, '');
    for (const entry of kb) {
      if (!entry.question || entry.question.trim().length < 3) continue;
      const cleanedEntry = cleanQuestion(entry.question);
      const entryClean = cleanedEntry.replace(/[（(]\s*[）)]/g, '').replace(/\s+/g, '');
      if (shortQ.length > 8 && entryClean.includes(shortQ.slice(0, Math.floor(shortQ.length * 0.7)))) {
        bestMatch = entry;
        bestScore = 0.7;
        bestMethod = 'substring';
        break;
      }
      if (entryClean.length > 8 && shortQ.includes(entryClean.slice(0, Math.floor(entryClean.length * 0.7)))) {
        bestMatch = entry;
        bestScore = 0.7;
        bestMethod = 'substring';
        break;
      }
    }
  }

  if (bestMatch && bestScore >= 0.25) {
    return { match: bestMatch, score: round(bestScore), method: bestMethod };
  }

  return NO_MATCH;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Top-K retrieval — for RAG context when no exact KB match
// ---------------------------------------------------------------------------

/**
 * Retrieve the top-K most similar KB entries for a question.
 * Uses the same multi-tier matching as searchKB but collects all scores
 * and returns the best K results sorted by score descending.
 *
 * @param {import('../kb/manager.js').KnowledgeBase} kb
 * @param {string} questionText
 * @param {number} [k=5]
 * @returns {Array<{entry: object, score: number, method: string}>}
 */
export function searchKBTopK(kb, questionText, k = 5) {
  if (!kb || kb.size === 0) return [];
  if (!questionText || typeof questionText !== 'string') return [];
  if (questionText.trim().length < 3) return [];

  const cleanedQuery = cleanQuestion(questionText);
  const normQuery = normalize(cleanedQuery);
  if (normQuery.length === 0) return [];

  const queryKeywords = extractKeywords(cleanedQuery);
  const queryTokens = tokenize(cleanedQuery);

  const scored = [];

  for (const entry of kb) {
    if (!entry.question || entry.question.trim().length < 3) continue;

    const cleanedEntry = cleanQuestion(entry.question);
    const normEntry = normalize(cleanedEntry);

    // Exact match — score 1.0
    if (normEntry === normQuery) {
      scored.push({ entry, score: 1.0, method: 'exact' });
      continue;
    }

    let bestScore = 0;
    let bestMethod = 'none';

    // Keyword overlap
    if (queryKeywords.length > 0) {
      const entryKeywords = extractKeywords(cleanedEntry);
      if (entryKeywords.length > 0) {
        const overlap = queryKeywords.filter(k => entryKeywords.includes(k));
        const kwScore = overlap.length / queryKeywords.length;
        if (kwScore > bestScore) {
          bestScore = kwScore;
          bestMethod = 'keyword';
        }
      }
    }

    // Fuzzy Jaccard
    if (queryTokens.size > 0) {
      const entryTokens = tokenize(cleanedEntry);
      if (entryTokens.size > 0) {
        const jacScore = jaccard(queryTokens, entryTokens);
        if (jacScore > bestScore) {
          bestScore = jacScore;
          bestMethod = 'fuzzy';
        }
      }
    }

    // Substring containment
    if (bestScore < 0.25) {
      const shortQ = cleanedQuery.replace(/[（(]\s*[）)]/g, '').replace(/\s+/g, '');
      const entryClean = cleanedEntry.replace(/[（(]\s*[）)]/g, '').replace(/\s+/g, '');
      if (shortQ.length > 8 && entryClean.includes(shortQ.slice(0, Math.floor(shortQ.length * 0.7)))) {
        bestScore = 0.7;
        bestMethod = 'substring';
      } else if (entryClean.length > 8 && shortQ.includes(entryClean.slice(0, Math.floor(entryClean.length * 0.7)))) {
        bestScore = 0.7;
        bestMethod = 'substring';
      }
    }

    if (bestScore > 0) {
      scored.push({ entry, score: round(bestScore), method: bestMethod });
    }
  }

  // Sort by score descending, then by method priority (exact > keyword > fuzzy > substring)
  const methodPriority = { exact: 0, keyword: 1, fuzzy: 2, substring: 3, none: 4 };
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (methodPriority[a.method] ?? 4) - (methodPriority[b.method] ?? 4);
  });

  return scored.slice(0, k);
}
