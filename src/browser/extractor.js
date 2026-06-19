/**
 * Quiz-page extractor — pulls questions out of DOM and submits answers.
 *
 * Exports:
 *   parseQR(imagePath)        → string (decoded URL)
 *   extractQuestions(page)     → Question[]
 *   submitAnswer(page, q, ans) → void
 *   isQuizPage(page)           → boolean
 *
 * All page-facing functions set a 30 s implicit timeout via the page's
 * default timeout (set in launcher.js).
 */

import { Jimp } from 'jimp';
import jsQR from 'jsqr';

// ---------------------------------------------------------------------------
// QR decoding
// ---------------------------------------------------------------------------

/**
 * Read an image from disk, scan for a QR code, and return the decoded string.
 *
 * @param {string} imagePath  Absolute or relative path to a PNG / JPEG file
 * @returns {Promise<string>}  The decoded URL (or other payload) from the QR
 * @throws {Error} If no QR code is found or the image cannot be read
 */
export async function parseQR(imagePath) {
  console.log('[extractor] Reading QR image: %s', imagePath);

  const img = await Jimp.read(imagePath);
  // Preprocess: grayscale + contrast boost for better QR detection
  img.greyscale().contrast(0.5);
  const { width, height, data } = img.bitmap;

  // jsQR expects a Uint8ClampedArray of RGBA pixel data
  const code = jsQR(new Uint8ClampedArray(data), width, height);

  if (!code) {
    throw new Error(`No QR code found in image: ${imagePath}`);
  }

  console.log('[extractor] QR decoded → %s', code.data);
  return code.data;
}

// ---------------------------------------------------------------------------
// Quiz detection
// ---------------------------------------------------------------------------

/** Selectors that strongly suggest a quiz / exam page. */
const QUIZ_INDICATORS = [
  '.question',
  '.quiz-item',
  '.exam-question',
  '[data-question]',
  '[data-testid="question"]',
  'form fieldset',
  '.question-container',
  '.question-wrapper',
  '.qtext',          // Moodle
  '.formulation',    // Moodle
  '.que',            // Moodle question div
];

/**
 * Return `true` when the current page looks like a quiz / exam page.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
export async function isQuizPage(page) {
  for (const sel of QUIZ_INDICATORS) {
    try {
      if ((await page.locator(sel).count()) > 0) {
        console.log('[extractor] Quiz page detected via selector: %s', sel);
        return true;
      }
    } catch {
      // selector parse failure – skip
    }
  }
  console.log('[extractor] No quiz indicators found on page');
  return false;
}

// ---------------------------------------------------------------------------
// Question extraction
// ---------------------------------------------------------------------------

/** Selectors that isolate a single question block. */
const QUESTION_BLOCK_SELECTORS = [
  '.question',
  '.quiz-item',
  '.que',            // Moodle
  'form fieldset',
  '[data-question]',
  '[data-testid="question"]',
  '.question-container',
  '.question-wrapper',
  '.exam-item',
];

/** Selectors for option elements inside a question block. */
const OPTION_SELECTORS = [
  '.option',
  '.answer-choice',
  '.choice',
  '.answer',
  '[data-testid="answer"]',
  'label',
  '.r0, .r1',        // Moodle radio/tick rows
  '.flex-fill',
  'li.answer-item',
];

/** Selectors for the question text inside a block. */
const QUESTION_TEXT_SELECTORS = [
  '.question-text',
  '.qtext',           // Moodle
  '.formulation',      // Moodle
  '.quiz-question',
  '[data-testid="question-text"]',
  'h2', 'h3', 'h4',
  'p',
  '.stem',
];

/** Text patterns that indicate a multi-select question. */
const MULTI_PATTERNS = [
  /多选/i,
  /multiple\s*(choice|answer|select)/i,
  /select\s+all\s+that\s+apply/i,
  /choose\s+more\s+than/i,
];

/** Text patterns that indicate a true/false question. */
const TF_PATTERNS = [
  /^对$/,
  /^错$/,
  /^正确$/,
  /^错误$/,
  /^true$/i,
  /^false$/i,
  /^是$/,
  /^否$/,
  /^yes$/i,
  /^no$/i,
];

/**
 * Extract all quiz questions from the current page.
 *
 * Strategy (layered):
 *  1. Try to find distinct question blocks via QUESTION_BLOCK_SELECTORS.
 *  2. If none found, fall back to a single-page heuristic (one question).
 *  3. Inside each block, read question text and options.
 *  4. Detect question type: single / multi / tf / fill.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<import('../types.js').Question[]>}
 */
export async function extractQuestions(page) {
  const questions = [];

  // --- Step 1: locate question blocks ---
  let blocks = [];
  for (const sel of QUESTION_BLOCK_SELECTORS) {
    try {
      const count = await page.locator(sel).count();
      if (count > 0) {
        console.log('[extractor] Found %d question block(s) via "%s"', count, sel);
        blocks = { selector: sel, count };
        break;
      }
    } catch {
      // selector parse failure
    }
  }

  if (!blocks.selector) {
    // --- Fallback: treat the whole page as one question ---
    console.log('[extractor] No question blocks found – trying whole-page fallback');
    const q = await extractSingleQuestion(page, page.locator('body'));
    if (q && q.text.length > 0) {
      questions.push(q);
    }
    return questions;
  }

  // --- Step 2: iterate each block ---
  for (let i = 0; i < blocks.count; i++) {
    const block = page.locator(blocks.selector).nth(i);
    const q = await extractSingleQuestion(page, block, i);
    if (q && q.text.length > 0) {
      questions.push(q);
    }
  }

  console.log('[extractor] Extracted %d question(s) total', questions.length);
  return questions;
}

/**
 * Scrape one question block into a Question object.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} container  The block locator
 * @param {number} [idx=0]  Index for generating a stable-ish id
 * @returns {Promise<object|null>}
 */
async function extractSingleQuestion(page, container, idx = 0) {
  // --- Question text ---
  let text = '';
  for (const sel of QUESTION_TEXT_SELECTORS) {
    try {
      const el = container.locator(sel).first();
      if ((await el.count()) > 0) {
        const t = await el.textContent();
        if (t && t.trim().length > 0) {
          text = t.trim();
          break;
        }
      }
    } catch { /* next */ }
  }
  // If no dedicated text element found, grab container's own text (minus options)
  if (!text) {
    try {
      text = (await container.textContent() || '').trim();
    } catch { text = ''; }
  }

  // --- Options ---
  const options = [];
  for (const sel of OPTION_SELECTORS) {
    try {
      const els = container.locator(sel);
      const count = await els.count();
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const optText = (await els.nth(i).textContent() || '').trim();
          // Deduplicate & skip very short fragments
          if (optText.length >= 1 && !options.includes(optText)) {
            options.push(optText);
          }
        }
        if (options.length > 0) break; // found options with this selector
      }
    } catch { /* next */ }
  }

  // --- Detect type ---
  const type = detectType(text, options);

  // --- Check for embedded image ---
  let imageUrl = null;
  try {
    const img = container.locator('img').first();
    if ((await img.count()) > 0) {
      imageUrl = await img.getAttribute('src');
    }
  } catch { /* no image */ }

  return {
    id: `q-${idx}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    text: cleanText(text),
    options: options.map(cleanText),
    type,
    imageUrl,
    answer: null,
    source: null,
  };
}

/**
 * Detect whether a question is single / multi / tf / fill.
 */
function detectType(text, options) {
  if (options.length === 0) return 'fill';

  // Check for multi-select keywords in the question text
  if (MULTI_PATTERNS.some(p => p.test(text))) return 'multi';

  // Check if options look like true/false
  if (options.length === 2) {
    const allTF = options.every(o => TF_PATTERNS.some(p => p.test(o)));
    if (allTF) return 'tf';
  }

  // Check for checkbox inputs (multi-select) vs radio (single-select) is done
  // heuristically here – real determination would need DOM input type inspection.
  // For now, default everything with options to 'single'.
  return 'single';
}

/** Normalize whitespace and strip excessive control chars. */
function cleanText(s) {
  return s.replace(/\\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Answer submission
// ---------------------------------------------------------------------------

/** Selectors that match a submit / next / confirm button. */
const SUBMIT_BUTTON_SELECTORS = [
  'button[type="submit"]',
  '.submit-btn',
  '.next-btn',
  '.confirm-btn',
  'button:has-text("Submit")',
  'button:has-text("Next")',
  'button:has-text("提交")',
  'button:has-text("下一题")',
  'button:has-text("确定")',
  'button:has-text("Confirm")',
  'input[type="submit"]',
];

/**
 * Submit an answer for one question on the page.
 *
 * Strategy:
 *  1. For single / tf questions: click the radio button or label matching
 *     the answer text.
 *  2. For multi questions: click each matching checkbox label.
 *  3. For fill questions: type into the first visible text input / textarea.
 *  4. Click a submit / next button if one is visible.
 *
 * @param {import('playwright').Page}    page      The Playwright page
 * @param {import('../types.js').Question} question  The question object
 * @param {string} answer   The answer text to select
 * @returns {Promise<void>}
 */
export async function submitAnswer(page, question, answer) {
  console.log('[extractor] Submitting answer for q.id=%s: "%s"', question.id, answer);

  if (question.type === 'fill') {
    // Type into the first text-like input
    const input = page.locator('input[type="text"], input:not([type]), textarea').first();
    if ((await input.count()) > 0) {
      await input.click();
      await input.fill(answer);
      console.log('[extractor] Filled text input with answer');
    } else {
      console.log('[extractor] No text input found for fill-type question');
    }
  } else {
    // Click-based answer: try to click a label or input matching the answer
    await clickOption(page, answer);
  }

  // Small delay to let UI settle
  await page.waitForTimeout(300);

  // Click submit / next if present
  for (const sel of SUBMIT_BUTTON_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if ((await btn.count()) > 0 && (await btn.isVisible())) {
        await btn.click();
        console.log('[extractor] Clicked submit/next button: %s', sel);
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* next selector */ }
  }

  console.log('[extractor] No submit button found – answer selected but not advanced');
}

/**
 * Click an option whose visible text matches (or contains) `answer`.
 * Tries label clicks first, then falls back to input clicks.
 */
async function clickOption(page, answer) {
  const normAnswer = answer.toLowerCase().trim();

  // Common option locators
  const optionLocators = [
    page.locator('label'),
    page.locator('.option'),
    page.locator('.choice'),
    page.locator('.answer-choice'),
    page.locator('.answer'),
    page.locator('[data-testid="answer"]'),
  ];

  for (const locator of optionLocators) {
    try {
      const count = await locator.count();
      for (let i = 0; i < count; i++) {
        const el = locator.nth(i);
        const visible = await el.isVisible().catch(() => false);
        if (!visible) continue;

        const text = ((await el.textContent()) || '').toLowerCase().trim();
        if (text.includes(normAnswer) || normAnswer.includes(text)) {
          await el.click({ timeout: 5000 });
          console.log('[extractor] Clicked matching option: "%s"', text.slice(0, 50));
          return;
        }
      }
    } catch { /* next locator */ }
  }

  // Fallback: try clicking an input element whose associated label matches
  try {
    const inputs = page.locator('input[type="radio"], input[type="checkbox"]');
    const inputCount = await inputs.count();
    for (let i = 0; i < inputCount; i++) {
      const inp = inputs.nth(i);
      const value = (await inp.getAttribute('value') || '').toLowerCase().trim();
      const idAttr = (await inp.getAttribute('id') || '').toLowerCase().trim();

      // Check associated label
      let labelText = '';
      if (idAttr) {
        try {
          const label = page.locator(`label[for="${idAttr}"]`);
          if ((await label.count()) > 0) {
            labelText = ((await label.textContent()) || '').toLowerCase().trim();
          }
        } catch { /* ignore */ }
      }
      // Also check parent label
      if (!labelText) {
        try {
          const parentLabel = inp.locator('..').locator('label');
          // Actually let's check if the input is inside a label
        } catch { /* ignore */ }
      }

      if (
        value.includes(normAnswer) ||
        normAnswer.includes(value) ||
        labelText.includes(normAnswer) ||
        normAnswer.includes(labelText)
      ) {
        await inp.check({ timeout: 5000 });
        console.log('[extractor] Checked input: value="%s"', value);
        return;
      }
    }
  } catch { /* fallback exhausted */ }

  // Desperate fallback: just click whatever option best matches
  try {
    const exact = page.getByText(answer, { exact: true }).first();
    if ((await exact.count()) > 0) {
      await exact.click({ timeout: 5000 });
      console.log('[extractor] Fallback click on exact text match');
      return;
    }

    const partial = page.getByText(answer).first();
    if ((await partial.count()) > 0) {
      await partial.click({ timeout: 5000 });
      console.log('[extractor] Fallback click on partial text match');
      return;
    }
  } catch { /* exhausted */ }

  console.log('[extractor] Could not locate an option matching: "%s"', answer);
}
