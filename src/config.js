// Default configuration — override via CLI flags or config.json
export const defaults = {
  accuracy: 0.85,           // 0–1, probability of correct answer when KB has it
  speed: 'medium',          // 'fast' | 'medium' | 'slow'
  headless: true,           // run browser headless
  kbDir: './data/kb',       // knowledge base directory
  llmApiKey: '',            // DeepSeek API key for fallback answering
  llmEndpoint: 'https://api.deepseek.com/chat/completions',
  delayRanges: {            // milliseconds between questions
    fast:   [500, 2000],
    medium: [2000, 5000],
    slow:   [5000, 12000],
  },

  // ---- LLM optimization settings ----
  /** Number of LLM retries when answer doesn't match any option (0 to disable). */
  retryAttempts: 2,
  /** Number of top-KB entries to inject as RAG context when KB has no exact match. */
  kbTopK: 5,
  /** Minimum KB match score to skip LLM (0-1). Below this, RAG context is added. */
  kbMatchThreshold: 0.6,
  /** System prompt for the LLM — domain-specific guidance for safety quiz context. */
  llmSystemPrompt:
    '你是安全知识竞赛答题助手。请基于安全法规和标准给出准确答案。',
};

export function loadConfig(overrides = {}) {
  return { ...defaults, ...overrides };
}
