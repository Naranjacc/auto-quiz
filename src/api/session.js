/**
 * API-based quiz session runner.
 *
 * Uses the fengchuanba.com API directly (no browser needed).
 * Flows: parse URL → getBaseConfig → startExplore → answer loop → summary.
 *
 * @module api/session
 */

import { createApiClient, parseQuizUrl } from './client.js';
import { searchKB, searchKBTopK } from '../kb/search.js';
import { hybridSearch } from '../kb/semantic-search.js';
import {
  callLLM,
  buildLLMPrompt,
  findMatchInOptions,
  pickFromAnswerString,
  randomChoice,
  isJudgmentQuestion,
  parseJudgment,
} from '../engine/llm.js';

// ---------------------------------------------------------------------------
// Question format conversion (API → internal Question shape)
// ---------------------------------------------------------------------------

/**
 * Convert an API question object to the internal Question format.
 *
 * API shape:
 *   { content, choiceList: [{tag, content}], pattern, ... }
 *
 * Internal shape:
 *   { id, text, options, type, imageUrl, answer, source }
 */
function apiQuestionToInternal(apiQ, index = 0) {
  // For judge (pattern=3) questions, inject 正确/错误 options
  let options = (apiQ.choiceList || []).map(c => c.content);
  if (apiQ.pattern === 3 && options.length === 0) {
    options = ['正确', '错误'];
  }

  let type = 'single';
  if (apiQ.pattern === 1) type = 'fill';
  if (apiQ.pattern === 2) type = 'single';
  if (apiQ.pattern === 3) type = 'tf';

  return {
    id: `api-q-${index}-${Date.now().toString(36)}`,
    text: apiQ.content || '',
    options,
    type,
    imageUrl: apiQ.contentImage || null,
    answer: null,
    source: null,
    _choiceList: apiQ.choiceList || [],
    _apiPattern: apiQ.pattern,
    _apiQuestion: apiQ,
  };
}

// ---------------------------------------------------------------------------
// Answer picker — maps internal answer to API tag
// ---------------------------------------------------------------------------

/**
 * Given an answer text and the API choiceList, find the matching `tag` value.
 *
 * @param {string} answerText  - The answer text from KB/LLM/Random
 * @param {object[]} choiceList - API choiceList: [{tag, content}, ...]
 * @param {string} secretBoxCode - For logging
 * @returns {number} The tag value to submit (1-indexed, defaults to 1)
 */
/**
 * Map answer text to API tag, handling judge questions (pattern=3).
 * For judge: "正确/对/true/是/yes" → 1, "错误/错/false/否/no" → 2
 * For choice-based: match text to choiceList content
 */
function pickTag(answerText, choiceList, pattern) {
  if (!choiceList || choiceList.length === 0) {
    // Judge question (pattern=3): map 正确/错误 to tag 1/2
    if (pattern === 3) {
      const norm = (answerText || '').toLowerCase().trim();
      if (/正确|对|true|是|yes|✓|✔/.test(norm)) return 1;
      if (/错误|错|false|否|no|✗|✘/.test(norm)) return 2;
      return 2; // default to 错误 for safety
    }
    return 0;
  }

  const norm = (answerText || '').toLowerCase().trim();

  // Direct match on option content
  const exact = choiceList.find(
    c => c.content.toLowerCase().trim() === norm
  );
  if (exact) return exact.tag;

  // Fuzzy containment
  const fuzzy = choiceList.find(
    c =>
      c.content.toLowerCase().includes(norm) ||
      norm.includes(c.content.toLowerCase().trim())
  );
  if (fuzzy) return fuzzy.tag;

  // Letter index: A→1, B→2, ...
  const letterIdx = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(norm.toUpperCase());
  if (letterIdx >= 0 && letterIdx < choiceList.length) {
    return choiceList[letterIdx].tag;
  }

  // Numeric: "1" → first choice's tag, "2" → second, etc.
  const numIdx = parseInt(norm, 10);
  if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= choiceList.length) {
    return choiceList[numIdx - 1].tag;
  }

  // Fallback: first option's tag
  return choiceList[0].tag;
}

// ---------------------------------------------------------------------------
// Session runner
// ---------------------------------------------------------------------------

/**
 * Run a full quiz session via the API.
 *
 * @param {object} opts
 * @param {string} opts.url           - Quiz URL (with hash)
 * @param {object} opts.session       - Cached session { userId, uuid, wxc }
 * @param {object} opts.kb            - Initialized KnowledgeBase instance
 * @param {object} opts.config        - Merged config { accuracy, speed, delayRanges }
 * @returns {Promise<object>} Session summary
 */
export async function runApiSession(opts) {
  const { url, session: sessParams, kb, config } = opts;

  // ---- 1. Parse URL ----
  const parsed = parseQuizUrl(url, sessParams);
  if (!parsed.userId || !parsed.uuid) {
    throw new Error(
      'Missing session credentials (userId/uuid). ' +
      'Provide them via --session or capture them from WeChat first.'
    );
  }

  console.log('[api] Quiz: %s/%s  |  user: %s',
    parsed.baseUrl, parsed.secretBoxCode, parsed.userId);

  // ---- 2. Create API client ----
  const api = createApiClient(parsed);

  // ---- 3. Start quiz ----
  console.log('[api] Starting quiz...');
  let data;
  try {
    data = await api.startExplore();
  } catch (err) {
    throw new Error(`startExplore failed: ${err.message}`);
  }

  if (!data.question || !data.exploreDetail) {
    throw new Error('startExplore returned no question — quiz may be finished or unavailable');
  }

  // Warn if continuing a previous session
  if (data.continueExplore) {
    console.log('[api] ⚠️  Resuming previous session from checkpoint %d (wrong: %d, time left: %ds)',
      data.exploreDetail.checkPointSeq, data.wrongNum || 0, data.restTotalTime || 0);
  }

  console.log('[api] Quiz started. exploreId=%s  playChance=%d',
    data.exploreDetail.exploreId, data.playChance);

  // ---- 4. Answer loop ----
  const startTime = Date.now();
  const results = [];
  let exploreDetail = data.exploreDetail;
  let questionCount = data.exploreDetail.checkPointSeq - 1; // account for continued sessions
  const maxQuestions = 100; // safety cap

  while (questionCount < maxQuestions) {
    const qData = data.question;
    questionCount++;

    // Convert to internal Question format
    const question = apiQuestionToInternal(qData, questionCount);

    // Match answer using KB/LLM/Random
    const matched = await matchAnswerApi(question, qData, kb, config);

    // Determine submission mode
    const isJudge = qData.pattern === 3 && (!qData.choiceList || qData.choiceList.length === 0);
    const isFill = qData.pattern === 1 && (!qData.choiceList || qData.choiceList.length === 0);
    const tag = isFill ? 0 : pickTag(matched.answer, qData.choiceList, qData.pattern);
    const answerValue = isFill ? (matched.answer || '') : '';
    const choiceText = isFill
      ? truncate(matched.answer || '(empty)', 40)
      : isJudge
        ? (tag === 1 ? '正确' : '错误')
        : ((qData.choiceList || []).find(c => c.tag === tag)?.content || '?');

    const qStart = Date.now();

    // Human-like delay (skip before first question)
    if (questionCount > 1) {
      const range = config.delayRanges?.[config.speed] || [2000, 5000];
      const delayMs = range[0] + Math.random() * (range[1] - range[0]);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    // Submit answer and get next
    try {
      data = await api.nextCheckPoint(exploreDetail, tag, { answerValue });
    } catch (err) {
      console.warn('[api] Submit error: %s', err.message);
      break;
    }

    const qDuration = ((Date.now() - qStart) / 1000).toFixed(1);
    const idx = questionCount;
    const src = (matched.source || '?').toUpperCase().padEnd(6);
    const correct = data.result === 1;
    const mark = correct ? '✓' : '✗';

    console.log(`Q ${idx}  ${mark} ${src}  [${qDuration}s]  → ${truncate(choiceText, 40)}`);

    results.push({
      question: truncate(qData.content, 80),
      answer: choiceText,
      source: matched.source,
      tag,
      duration: qDuration,
      correct,
    });

    // Check if quiz is over
    // status=3: completed (serial/next-level), status=4: finished
    // status=0: may be transient, but if no question, treat as end
    if (data.status === 3 || data.status === 4) {
      console.log('[api] Quiz completed (status=%s) — all questions done', data.status);
      break;
    }
    if (data.status !== 1 || !data.question) {
      console.log('[api] Quiz ended (status=%s, hasQuestion=%s)', data.status, !!data.question);
      break;
    }

    exploreDetail = data.exploreDetail;
  }

  // ---- 5. Summary ----
  const totalDuration = ((Date.now() - startTime) / 1000).toFixed(1);
  const correctCount = results.filter(r => r.correct).length;
  const wrongCount = results.length - correctCount;
  const accuracy = results.length > 0 ? ((correctCount / results.length) * 100).toFixed(1) : '0.0';

  return {
    url,
    baseUrl: parsed.baseUrl,
    secretBoxCode: parsed.secretBoxCode,
    totalDuration: `${totalDuration}s`,
    totalQuestions: results.length,
    correctCount,
    wrongCount,
    accuracy: `${accuracy}%`,
    results,
    sourceCounts: countSources(results),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

    /**
     * Answer matching - KB-first pipeline:
     *   Tier 1: Fast string match -> use KB immediately if score >= 0.25
     *   Tier 2: LLM hybrid search if string match fails
     *   Tier 3: Weak string match >= 0.15 (near-duplicates)
     *   Tier 4: LLM generation with RAG context
     *   Tier 5: Random guess
     */
    async function matchAnswerApi(question, apiQ, kb, config) {
      const strThreshold = config.kbMatchThreshold ?? 0.25;

      // Tier 1: Fast string match - KB-first, with answer→option validation
      if (kb && kb.size > 0) {
        const strResult = searchKB(kb, question.text);
        if (strResult.match && strResult.score >= strThreshold) {
          // 🔒 Validation gate: KB answer must match an exam option
          const hasValidAnswer = question.options.length === 0
            || findMatchInOptions(strResult.match.answer, question.options);
          if (hasValidAnswer) {
            if (Math.random() < (config.accuracy ?? 1.0)) {
              question.answer = pickFromAnswerString(strResult.match.answer, question.options);
              question.source = `kb_${strResult.method}`;
            } else {
              const correct = pickFromAnswerString(strResult.match.answer, question.options);
              const wrongs = question.options.filter(o => o !== correct);
              question.answer = wrongs.length > 0
                ? wrongs[Math.floor(Math.random() * wrongs.length)]
                : randomChoice(question.options);
              question.source = "random";
            }
            await kb.recordHit(strResult.match.id);
            return question;
          }
          // Answer not in options — reject this match, continue to next tier
        }
      }

      // Tier 2: BGE vector + string hybrid search (no LLM needed)
      if (kb && kb.size > 0) {
        const hybResult = await hybridSearch(kb, question.text, question.options, config);
        if (hybResult.match && hybResult.score > 0.35) {
          question.answer = pickFromAnswerString(hybResult.match.answer, question.options);
          question.source = hybResult.method?.startsWith('vector')
            ? 'kb_vector'
            : 'kb_hybrid';
          await kb.recordHit(hybResult.match.id);
          return question;
        }
      }

      // Tier 3: Weak string match - with answer→option validation
      if (kb && kb.size > 0) {
        const strResult = searchKB(kb, question.text);
        if (strResult.match && strResult.score >= 0.15) {
          const hasValidAnswer = question.options.length === 0
            || findMatchInOptions(strResult.match.answer, question.options);
          if (hasValidAnswer) {
            question.answer = pickFromAnswerString(strResult.match.answer, question.options);
            question.source = "kb_weak";
            await kb.recordHit(strResult.match.id);
            return question;
          }
        }
      }

      // Tier 4: LLM generation with RAG context
      if (config.llmApiKey) {
        let kbContext = [];
        if (kb && kb.size > 0) {
          const k = config.kbTopK ?? 5;
          const topK = searchKBTopK(kb, question.text, k);
          kbContext = topK.map(r => r.entry);
        }
        try {
          const llmAnswer = await callLLM(question.text, question.options, config, kbContext);
          if (llmAnswer) {
            question.answer = llmAnswer;
            question.source = "llm";
            return question;
          }
        } catch {
          // fall through to random
        }
      }

      // Tier 5: Random guess
      if (question.options.length > 0) {
        question.answer = randomChoice(question.options);
        question.source = "random";
      } else {
        question.answer = "";
        question.source = "skip";
      }
      return question;
    }

function countSources(results) {
  const counts = { kb: 0, llm: 0, random: 0, skip: 0 };
  for (const r of results) {
    counts[r.source] = (counts[r.source] ?? 0) + 1;
  }
  return counts;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
