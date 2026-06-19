/**
 * Semantic search engine — LLM-powered KB matching.
 *
 * Solves the core problem: exam questions are phrased differently from KB entries,
 * so pure string matching misses most matches (~21%). This module uses DeepSeek
 * to understand semantic meaning and match questions to the right KB entry.
 *
 * Pipeline:
 *   1. Preprocess  – clean question text (strip number prefixes, normalize)
 *   2. Candidate   – fast keyword-based filtering to top-20 entries
 *   3. LLM match   – send candidates + question + options to DeepSeek
 *   4. Fusion      – combine string score (0.3) + LLM score (0.7)
 *
 * @module kb/semantic-search
 */

import { searchKB, searchKBTopK, cleanQuestion } from './search.js';
import { findMatchInOptions } from '../engine/llm.js';

// Lazy load vector embedder (may fail if model can't download from HuggingFace)
let _vectorSearch = null;
let _ensureIndex = null;
async function tryLoadEmbedder() {
  if (_vectorSearch === null) {
    try {
      const mod = await import('./embedder.js');
      _vectorSearch = mod.search;
      _ensureIndex = mod.ensureIndex;
    } catch {
      _vectorSearch = false;
      _ensureIndex = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate filtering — fast keyword-based pre-screening
// ---------------------------------------------------------------------------

/**
 * Preprocess a KB entry: clean the question text, extract tokens for fast matching.
 *
 * @param {object} entry - KB entry { id, question, answer, ... }
 * @returns {object} Augmented entry with .cleaned and .tokens
 */
function preprocessEntry(entry) {
  const cleaned = cleanQuestion(entry.question);
  // Simple character-bigram token set for fast Chinese overlap scoring
  const tokens = new Set();
  for (let i = 0; i < cleaned.length - 1; i++) {
    tokens.add(cleaned.substring(i, i + 2));
  }
  return { ...entry, _cleaned: cleaned, _tokens: tokens };
}

/**
 * Compute fast bigram overlap score between query and entry.
 * This is simpler and faster than Jaccard — just intersection / query_size.
 *
 * @param {Set<string>} queryTokens
 * @param {Set<string>} entryTokens
 * @returns {number} 0-1 overlap ratio
 */
function bigramOverlap(queryTokens, entryTokens) {
  if (queryTokens.size === 0 || entryTokens.size === 0) return 0;
  let intersection = 0;
  for (const t of queryTokens) {
    if (entryTokens.has(t)) intersection++;
  }
  return intersection / queryTokens.size;
}

/**
 * Build bigram tokens from a string.
 */
function buildBigrams(str) {
  const tokens = new Set();
  for (let i = 0; i < str.length - 1; i++) {
    tokens.add(str.substring(i, i + 2));
  }
  return tokens;
}

/**
 * Filter KB entries to top-K candidates using fast bigram overlap.
 * Also boosts entries whose keywords appear in the question text.
 *
 * @param {Iterable<object>} kb - KB entries (iterable from KnowledgeBase)
 * @param {string} questionText - The exam question text
 * @param {number} [topK=20] - Number of candidates to return
 * @returns {Array<object>} Top-K entries with scores
 */
export function filterCandidates(kb, questionText, topK = 20) {
  const cleanedQuery = cleanQuestion(questionText);
  const queryTokens = buildBigrams(cleanedQuery);
  if (queryTokens.size === 0) return [];

  const scored = [];
  for (const entry of kb) {
    if (!entry.question || entry.question.trim().length < 3) continue;
    const e = preprocessEntry(entry);
    const score = bigramOverlap(queryTokens, e._tokens);
    if (score > 0) {
      scored.push({ entry: e, score });
    }
  }

  // Sort by score descending, take top-K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// LLM semantic matching
// ---------------------------------------------------------------------------

/**
 * Build the prompt for LLM semantic matching.
 *
 * The prompt presents:
 *   1. The exam question + options
 *   2. A list of KB entries (ID + question + answer)
 *   3. Instructions to pick the best match
 *
 * @param {string} questionText - The exam question
 * @param {string[]} options - Answer options
 * @param {Array<{entry: object, score: number}>} candidates - Filtered KB entries
 * @returns {string} The prompt text
 */
function buildSemanticPrompt(questionText, options, candidates) {
  const parts = [];

  parts.push('你是一个题库匹配助手。下面是用户正在作答的题目，以及知识库中可能相关的条目。');
  parts.push('请找出知识库中与题目**语义最匹配**的一个条目，返回其 ID。');
  parts.push('');
  parts.push('## 当前题目');
  parts.push(`题目：${questionText}`);

  if (options && options.length > 0) {
    parts.push('选项：');
    options.forEach((o, i) => {
      parts.push(`  ${String.fromCharCode(65 + i)}. ${o}`);
    });
  }

  parts.push('');
  parts.push('## 知识库候选条目（共' + candidates.length + '条）');
  parts.push('');

  candidates.forEach((c, idx) => {
    parts.push(`---`);
    parts.push(`ID: ${c.entry.id}`);
    parts.push(`题目: ${c.entry._cleaned || cleanQuestion(c.entry.question)}`);
    parts.push(`答案: ${c.entry.answer}`);
  });

  parts.push('');
  parts.push('## 任务');
  parts.push('请分析题目语义，从上述候选条目中找出最匹配的一个。');
  parts.push('');
  parts.push('回复格式（严格遵守）：');
  parts.push('ID: <匹配的条目ID>');
  parts.push('置信度: <0.0-1.0 之间的小数>');
  parts.push('理由: <一句话说明为什么匹配>');

  return parts.join('\n');
}

/**
 * Parse the LLM response to extract the matched entry ID and confidence.
 *
 * @param {string} llmResponse - Raw LLM response text
 * @returns {{ id: string|null, confidence: number }}
 */
function parseLLMResponse(llmResponse) {
  const text = llmResponse || '';

  // Extract ID: look for "ID:" or "ID：" line
  const idMatch = text.match(/ID[：:]\s*([a-f0-9-]{36})/i);
  const id = idMatch ? idMatch[1] : null;

  // Extract confidence
  const confMatch = text.match(/置信度[：:]\s*([\d.]+)/);
  let confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;
  // Clamp to 0-1
  confidence = Math.max(0, Math.min(1, confidence));

  return { id, confidence };
}

/**
 * Call the DeepSeek LLM to semantically match a question to a KB entry.
 *
 * @param {Array<{entry: object, score: number}>} candidates - Pre-filtered KB entries
 * @param {string} questionText - The exam question
 * @param {string[]} options - Answer options
 * @param {object} config - { llmApiKey, llmEndpoint }
 * @returns {Promise<{match: object|null, score: number, method: string}>}
 */
export async function semanticSearchLLM(candidates, questionText, options, config) {
  if (!candidates || candidates.length === 0) {
    return { match: null, score: 0, method: 'llm_none' };
  }
  if (!config.llmApiKey) {
    return { match: null, score: 0, method: 'llm_nokey' };
  }

  const prompt = buildSemanticPrompt(questionText, options, candidates);

  try {
    const res = await fetch(config.llmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: '你是一个精准的题库语义匹配系统。只返回匹配结果，格式严格为：ID: <uuid>\\n置信度: <0.0-1.0>\\n理由: <简述>',
          },
          { role: 'user', content: prompt },
        ],
        max_tokens: 200,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM API returned ${res.status}`);
    }

    const data = await res.json();
    const rawAnswer = data.choices?.[0]?.message?.content?.trim();
    if (!rawAnswer) {
      return { match: null, score: 0, method: 'llm_empty' };
    }

    const { id, confidence } = parseLLMResponse(rawAnswer);
    if (!id) {
      return { match: null, score: 0, method: 'llm_parsefail' };
    }

    // Find the matching entry in candidates
    const candidate = candidates.find(c => c.entry.id === id);
    if (!candidate) {
      return { match: null, score: 0, method: 'llm_nomatch' };
    }

    return {
      match: candidate.entry,
      score: confidence,
      method: 'llm_semantic',
    };
  } catch (err) {
    return { match: null, score: 0, method: `llm_error:${err.message.slice(0, 40)}` };
  }
}

// ---------------------------------------------------------------------------
// Hybrid fusion search
// ---------------------------------------------------------------------------

/**
 * Hybrid search: string match + BGE vector similarity.
 *
 * Phase 1: String matching (fast, always runs) — exact/keyword/fuzzy/substring
 * Phase 2: BGE vector similarity — embed question, cosine vs cached KB vectors
 * Phase 3: Answer validation — KB answer must match an exam option
 * Fallback: return best available result
 *
 * @param {import('../kb/manager.js').KnowledgeBase} kb
 * @param {string} questionText - The exam question
 * @param {string[]} options - Answer options (can be empty array)
 * @param {object} config - { llmApiKey?, llmEndpoint?, accuracy? }
 * @returns {Promise<{match: object|null, score: number, method: string}>}
 */
export async function hybridSearch(kb, questionText, options = [], config = {}) {
  const NO_MATCH = { match: null, score: 0, method: 'none' };

  if (!kb || kb.size === 0) return NO_MATCH;
  if (!questionText || typeof questionText !== 'string') return NO_MATCH;
  if (questionText.trim().length < 3) return NO_MATCH;

  // --- Phase 1: String matching (fast, always runs) ---
  const stringResult = searchKB(kb, questionText);

  // If exact match (score >= 0.95), return immediately
  if (stringResult.match && stringResult.score >= 0.95) {
    return stringResult;
  }

  // --- Phase 2: Semantic matching (vector → KB top-K fallback) ---
  let semanticResult = null;

  // 2a: Try BGE vector search first (if model available)
  await tryLoadEmbedder();
  if (_vectorSearch) {
    try {
      const index = await _ensureIndex(kb);
      if (index && index.length > 0) {
        const topK = await _vectorSearch(questionText, index, 3);
        for (const hit of topK) {
          if (hit.score < 0.55) continue;
          if (options.length > 0 && !findMatchInOptions(hit.answer, options)) continue;
          const kbEntry = kb.get?.(hit.id) || { id: hit.id, question: hit.question, answer: hit.answer };
          semanticResult = { match: kbEntry, score: Math.round(hit.score * 100) / 100, method: 'vector' };
          break;
        }
      }
    } catch { /* model download failed — fall through */ }
  }

  // 2b: Fallback — KB top-K with answer validation (pure JS, no network)
  if (!semanticResult && kb && kb.size > 0 && options.length > 0) {
    const topK = searchKBTopK(kb, questionText, 10);
    for (const r of topK) {
      if (r.score < 0.15) continue;                    // too dissimilar
      const matched = findMatchInOptions(r.entry.answer, options);
      if (!matched) continue;                           // answer not in options → reject
      // Only accept if the answer uniquely matches (not just falling back to options[0])
      if (r.score >= 0.45 || matched !== options[0]) {
        semanticResult = { match: r.entry, score: r.score, method: `fallback_${r.method}` };
        break;
      }
    }
  }

  // --- Phase 3: Accept semantic match ---
  if (semanticResult && semanticResult.match) {
    const sScore = stringResult.match ? stringResult.score : 0;
    const vScore = semanticResult.score;
    // String match confirms semantic match, boosting confidence
    const fusedScore = sScore >= 0.25 ? sScore * 0.3 + vScore * 0.7 : vScore;

    if (fusedScore >= 0.30) {
      return {
        match: semanticResult.match,
        score: Math.round(fusedScore * 100) / 100,
        method: `hybrid(${stringResult.method}+${semanticResult.method})`,
      };
    }
  }

  // --- Fallback: return string match result ---
  return stringResult;
}

// ---------------------------------------------------------------------------
// Batch semantic search — for testing/evaluation
// ---------------------------------------------------------------------------

/**
 * Batch test: run semantic search on multiple questions and compute match rate.
 * Each question has a known KB entry ID (the ground truth).
 *
 * @param {import('../kb/manager.js').KnowledgeBase} kb
 * @param {Array<{id: string, question: string, options?: string[], expectedId: string}>} testCases
 * @param {object} config
 * @param {boolean} [useLLM=true] - Whether to use LLM (set false for string-only baseline)
 * @returns {Promise<object>} { results, stats }
 */
export async function batchEvaluate(kb, testCases, config, useLLM = true) {
  const results = [];
  let matched = 0;
  let total = 0;

  for (const tc of testCases) {
    total++;
    let result;
    if (useLLM && config.llmApiKey) {
      result = await hybridSearch(kb, tc.question, tc.options || [], config);
    } else {
      result = searchKB(kb, tc.question);
    }

    const correct = result.match && result.match.id === tc.expectedId;
    if (correct) matched++;

    results.push({
      question: tc.question.slice(0, 60),
      expectedId: tc.expectedId,
      matchedId: result.match?.id || null,
      score: result.score,
      method: result.method,
      correct,
    });
  }

  return {
    results,
    stats: {
      total,
      matched,
      matchRate: total > 0 ? (matched / total * 100).toFixed(1) + '%' : '0%',
      methodBreakdown: countMethods(results),
    },
  };
}

function countMethods(results) {
  const counts = {};
  for (const r of results) {
    const m = r.method || 'none';
    counts[m] = (counts[m] || 0) + 1;
  }
  return counts;
}
