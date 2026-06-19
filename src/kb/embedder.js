/**
 * BGE Vector Embedding + Semantic Search Engine.
 *
 * Uses BAAI's bge-small-zh-v1.5 (via Xenova/Transformers.js ONNX) for
 * Chinese text embeddings. Replaces LLM-based semantic matching with
 * proper vector similarity — much faster and more accurate for KB lookup.
 *
 * Architecture:
 *   1. Build: embed all KB questions → cache vectors to ~/.auto-quiz/kb-vectors.json
 *   2. Search: embed exam question → cosine similarity against cached vectors → top-K
 *   3. Validate: KB answer must match one exam option (via findMatchInOptions)
 *
 * Dependencies: @xenova/transformers (HuggingFace ONNX runtime, pure Node.js)
 * Model: Xenova/bge-small-zh-v1.5 (512-dim, ~80MB download, quantized)
 *
 * @module kb/embedder
 */

import { pipeline } from '@xenova/transformers';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---- Config ----
const VECTOR_CACHE = join(homedir(), '.auto-quiz', 'kb-vectors.json');
const MODEL_NAME = 'Xenova/bge-small-zh-v1.5';

// ---- Singleton model (lazy loaded, failure memoized) ----
let _model = null;
let _modelFailed = false; // memoize failure — don't retry forever

async function getModel() {
  if (_model) return _model;
  if (_modelFailed) throw new Error('Model unavailable (download failed)');
  console.log('[embedder] Loading BGE model: %s', MODEL_NAME);
  console.log('[embedder] (First run downloads ~80MB — one-time only)');

  if (!process.env.HF_ENDPOINT) {
    process.env.HF_ENDPOINT = 'https://hf-mirror.com';
  }

  try {
    _model = await pipeline('feature-extraction', MODEL_NAME, { quantized: true });
    console.log('[embedder] Model loaded.');
    return _model;
  } catch (e) {
    _modelFailed = true;
    console.log('[embedder] Model download failed (network blocked). Will use offline fallback.');
    throw e;
  }
}

// ---- Cosine similarity (vectors already L2-normalized by BGE) ----
// With normalized vectors, cosine = dot product
function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // [-1, 1], higher = more similar
}

// ---- Batch embed ----
async function embedTexts(texts) {
  const model = await getModel();
  const results = [];
  // Process in batches of 32 to avoid memory spikes
  const BATCH = 32;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const output = await model(batch, { pooling: 'mean', normalize: true });
    // output is a Tensor or array of Tensors
    for (let j = 0; j < batch.length; j++) {
      results.push(Array.from(output[j]?.data || output.data));
    }
  }
  return results;
}

// ---- Build KB vector index ----
export async function buildIndex(kb) {
  const entries = [];
  const questions = [];
  for (const entry of kb) {
    if (!entry.question || entry.question.trim().length < 3) continue;
    entries.push(entry);
    // BGE models benefit from instruction prefix for retrieval
    questions.push(entry.question);
  }

  if (questions.length === 0) return [];

  console.log('[embedder] Building index for %d KB entries...', questions.length);
  const vectors = await embedTexts(questions);

  const index = entries.map((entry, i) => ({
    id: entry.id,
    vector: vectors[i],
    question: entry.question,
    answer: entry.answer,
  }));

  // Cache to disk
  await mkdir(join(homedir(), '.auto-quiz'), { recursive: true });
  await writeFile(VECTOR_CACHE, JSON.stringify(index), 'utf-8');
  console.log('[embedder] Index saved: %s (%d entries)', VECTOR_CACHE, index.length);

  return index;
}

// ---- Load cached index ----
export async function loadIndex() {
  if (!existsSync(VECTOR_CACHE)) return null;
  const raw = await readFile(VECTOR_CACHE, 'utf-8');
  const index = JSON.parse(raw);
  console.log('[embedder] Loaded cached index: %d entries', index.length);
  return index;
}

// ---- Search ----
export async function search(queryText, index, topK = 3) {
  if (!index || index.length === 0) return [];
  if (!queryText || queryText.trim().length < 3) return [];

  const [queryVec] = await embedTexts([queryText]);

  const scored = index.map((entry) => ({
    ...entry,
    score: cosineSimilarity(queryVec, entry.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---- Convenience: build or load ----
export async function ensureIndex(kb) {
  const cached = await loadIndex();
  if (cached) return cached;
  return buildIndex(kb);
}
