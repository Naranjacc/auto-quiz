/**
 * Shared LLM helpers for answer matching.
 *
 * Extracted from duplicated code in session.js and matcher.js.
 * Provides: callLLM, buildLLMPrompt, findMatchInOptions,
 *           isJudgmentQuestion, parseJudgment, pickFromAnswerString, randomChoice
 */

// ---------------------------------------------------------------------------
// Strict answer matching
// ---------------------------------------------------------------------------

/**
 * Strict match finder — returns null if no unambiguous match found.
 * Used for validating LLM output before accepting it.
 */
export function findMatchInOptions(raw, options) {
  if (!options || options.length === 0) return null;
  const norm = (raw || '').trim();
  if (!norm) return null;

  // Direct exact match (case-insensitive)
  const exact = options.find(
    o => o.toLowerCase().trim() === norm.toLowerCase()
  );
  if (exact) return exact;

  // Letter index: A→0, B→1
  const letterIdx = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(norm.toUpperCase());
  if (letterIdx >= 0 && letterIdx < options.length) return options[letterIdx];

  // Numeric: "1" → options[0], etc.
  const numIdx = parseInt(norm, 10);
  if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= options.length) return options[numIdx - 1];

  // Fuzzy containment — only if unambiguous (exactly one match)
  const fuzzyMatches = options.filter(
    o =>
      o.toLowerCase().includes(norm.toLowerCase()) ||
      norm.toLowerCase().includes(o.toLowerCase().trim())
  );
  if (fuzzyMatches.length === 1) return fuzzyMatches[0];

  return null; // No unambiguous match
}

/**
 * Pick the best-matching option from the available choices.
 * Handles direct text match, fuzzy containment, letter mapping (A/B/C/D),
 * and numeric mapping (1/2/3...).
 */
export function pickFromAnswerString(answerText, options) {
  if (!options || options.length === 0) return answerText;

  // Direct match (case-insensitive, trimmed)
  const direct = options.find(
    o => o.toLowerCase().trim() === answerText.toLowerCase().trim()
  );
  if (direct) return direct;

  // Fuzzy containment
  const fuzzy = options.find(
    o =>
      o.toLowerCase().includes(answerText.toLowerCase()) ||
      answerText.toLowerCase().includes(o.toLowerCase())
  );
  if (fuzzy) return fuzzy;

  // Letter index: A → 0, B → 1, ...
  const letterIdx = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.indexOf(answerText.toUpperCase().trim());
  if (letterIdx >= 0 && letterIdx < options.length) {
    return options[letterIdx];
  }

  // Numeric index: "1" → options[0], "2" → options[1], ...
  const numIdx = parseInt(answerText.trim(), 10);
  if (!isNaN(numIdx) && numIdx >= 1 && numIdx <= options.length) {
    return options[numIdx - 1];
  }

  // Fallback: first option
  return options[0];
}

/**
 * Pick a random element from an array.
 */
export function randomChoice(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ---------------------------------------------------------------------------
// Judgment (true/false) question detection & parsing
// ---------------------------------------------------------------------------

/**
 * Detect whether this question is a judgment (true/false) question.
 * Checks if options are exactly [正确, 错误] or [对, 错] variants.
 */
export function isJudgmentQuestion(options) {
  if (!options || options.length !== 2) return false;
  const opts = options.map(o => o.trim());
  return (opts[0] === '正确' && opts[1] === '错误') ||
         (opts[0] === '错误' && opts[1] === '正确') ||
         (opts[0] === '对' && opts[1] === '错') ||
         (opts[0] === '错' && opts[1] === '对');
}

/**
 * Parse LLM raw output for a judgment question.
 * Forces binary output: 正确 or 错误.
 */
export function parseJudgment(raw) {
  const norm = (raw || '').toLowerCase().trim();
  // Positive indicators
  if (/正确|对|true|是|yes|✓|✔|^t$/i.test(norm)) return '正确';
  // Everything else → 错误 (safer default)
  return '错误';
}

// ---------------------------------------------------------------------------
// LLM API call with RAG context, retry & judgment support
// ---------------------------------------------------------------------------

/**
 * Build a prompt for the LLM with options labeled A, B, C...
 * Includes RAG context from top-K KB entries when available.
 */
export function buildLLMPrompt(questionText, options, kbContext = []) {
  let prompt = '';

  // ---- RAG context: inject top-K KB entries as domain reference ----
  if (kbContext && kbContext.length > 0) {
    prompt += '参考以下安全知识点：\n\n';
    for (let i = 0; i < kbContext.length; i++) {
      const entry = kbContext[i];
      const shortQ = (entry.question || '').length > 80
        ? entry.question.slice(0, 77) + '...'
        : entry.question;
      const shortA = (entry.answer || '').length > 100
        ? entry.answer.slice(0, 97) + '...'
        : entry.answer;
      prompt += `${i + 1}. 问题：${shortQ}\n   答案：${shortA}\n\n`;
    }
    prompt += '请基于以上知识点回答以下问题：\n\n';
  }

  // ---- Main question ----
  if (!options || options.length === 0) {
    prompt += `请回答以下问题：\n\n${questionText}\n\n请简洁回答。`;
    return prompt;
  }

  const optionLines = options
    .map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)
    .join('\n');

  prompt += `问题：${questionText}\n\n选项：\n${optionLines}\n\n请仅回复正确选项的字母（A/B/C/D...）或完整选项文本。`;
  return prompt;
}

/**
 * Call the LLM API for answer fallback with retry, RAG context, and judgment support.
 *
 * @param {string} questionText
 * @param {string[]} options
 * @param {object} config - Must have llmApiKey, llmEndpoint, llmSystemPrompt, retryAttempts
 * @param {object[]} [kbContext=[]] - Top-K KB entries for RAG context
 * @returns {Promise<string|null>} The matched answer text, or null if failed
 */
export async function callLLM(questionText, options, config, kbContext = []) {
  const isJudge = isJudgmentQuestion(options);
  const maxRetries = config.retryAttempts ?? 2;
  const systemPrompt = config.llmSystemPrompt || '你是安全知识竞赛答题助手。请基于安全法规和标准给出准确答案。';

  let prompt = '';

  // Build initial prompt based on question type
  if (isJudge) {
    // Judgment-specific prompt — simple binary question
    prompt = `请判断以下陈述是否正确。仅回复一个词：正确 或 错误。\n\n陈述：${questionText}`;
  } else {
    prompt = buildLLMPrompt(questionText, options, kbContext);
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(config.llmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.llmApiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        max_tokens: isJudge ? 50 : 200,
        temperature: 0,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM API returned ${res.status}`);
    }

    const data = await res.json();
    const rawAnswer = data.choices?.[0]?.message?.content?.trim();
    if (!rawAnswer) {
      if (attempt < maxRetries) continue;
      return null;
    }

    // ---- Judgment questions: binary parse ----
    if (isJudge) {
      return parseJudgment(rawAnswer);
    }

    // ---- Choice questions: validate against options ----
    const matched = findMatchInOptions(rawAnswer, options);
    if (matched) {
      return matched;
    }

    // Answer not in options — retry with stricter prompt
    if (attempt < maxRetries) {
      const optionLines = options
        .map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`)
        .join('\n');
      prompt = `你之前的回答"${rawAnswer}"不在选项中。请仅从以下选项中选择一个回复。\n\n问题：${questionText}\n\n选项：\n${optionLines}\n\n请仅回复正确选项的字母（A/B/C/D...）或完整选项文本。`;
    }
  }

  // Exhausted retries — return null (will fall through to random)
  return null;
}
