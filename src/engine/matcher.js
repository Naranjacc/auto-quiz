/**
 * Answer matcher — KB-first: use题库 whenever possible, LLM only when desperate.
 *
 * Pipeline (optimized for KB-first):
 *   1. String match (fast, always runs) — exact/keyword/fuzzy/substring
 *   2. If string match ≥ 0.25 → use KB answer immediately (skip LLM)
 *   3. If no string match + LLM configured → hybrid semantic search
 *   4. If still no match → closest string match ≥ 0.15 (better than random)
 *   5. Last resort → random pick
 *
 * Contract: mutates the question object in-place, setting .answer and .source.
 */

import { searchKB, searchKBTopK } from '../kb/search.js';
import { hybridSearch } from '../kb/semantic-search.js';
import { callLLM, buildLLMPrompt, findMatchInOptions, pickFromAnswerString, randomChoice, isJudgmentQuestion, parseJudgment } from './llm.js';

/**
 * Match (or fabricate) an answer for a single question.
 *
 * @param {object} question   - Question object (see ../types.js). Mutated in-place.
 * @param {import('../kb/manager.js').KnowledgeBase} kb  - Initialized KnowledgeBase
 * @param {object} config     - Engine config { accuracy, llmApiKey, llmEndpoint, ... }
 * @returns {Promise<object>} The same question object with .answer and .source set
 */
export async function matchAnswer(question, kb, config) {
  const strThreshold = config.kbMatchThreshold ?? 0.25;  // string match minimum
  const hybThreshold = 0.35;   // hybrid/LLM match minimum

  // --- Tier 1: Fast string match with answer→option validation ---
  const strResult = searchKB(kb, question.text);

  if (strResult.match && strResult.score >= strThreshold) {
    const hasValidAnswer = question.options.length === 0
      || findMatchInOptions(strResult.match.answer, question.options);
    if (hasValidAnswer) {
      if (Math.random() < config.accuracy) {
        question.answer = pickFromAnswerString(strResult.match.answer, question.options);
        question.source = `kb_${strResult.method}`;
      } else {
        const correctAnswer = pickFromAnswerString(strResult.match.answer, question.options);
        const wrongOptions = question.options.filter(o => o !== correctAnswer);
        question.answer = wrongOptions.length > 0
          ? wrongOptions[Math.floor(Math.random() * wrongOptions.length)]
          : randomChoice(question.options);
        question.source = 'random';
      }
      await kb.recordHit(strResult.match.id);
      return question;
    }
    // Answer not in options → reject, fall through
  }

  // --- Tier 2: BGE vector + string hybrid search (no LLM needed) ---
  {
    const hybResult = await hybridSearch(kb, question.text, question.options, config);

    if (hybResult.match && hybResult.score > hybThreshold) {
      question.answer = pickFromAnswerString(hybResult.match.answer, question.options);
      question.source = hybResult.method?.startsWith('vector') ? 'kb_vector' : 'kb_hybrid';
      await kb.recordHit(hybResult.match.id);
      return question;
    }
  }

  // --- Tier 3: Weak string match with answer→option validation ---
  if (strResult.match && strResult.score >= 0.15) {
    const hasValidAnswer = question.options.length === 0
      || findMatchInOptions(strResult.match.answer, question.options);
    if (hasValidAnswer) {
      question.answer = pickFromAnswerString(strResult.match.answer, question.options);
      question.source = 'kb_weak';
      await kb.recordHit(strResult.match.id);
      return question;
    }
  }

  // --- Tier 4: LLM generation with RAG context (last intelligent resort) ---
  if (config.llmApiKey) {
    // Collect top-K KB entries as RAG context
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
        question.source = 'llm';
        return question;
      }
    } catch {
      // LLM call failed — fall through to random
    }
  }

  // --- Tier 5: Random (truly nothing else works) ---
  if (question.options.length > 0) {
    question.answer = randomChoice(question.options);
    question.source = 'random';
  } else {
    question.answer = null;
    question.source = 'skip';
  }

  return question;
}

