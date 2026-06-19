/**
 * Browser automation module — powered by Playwright.
 *
 * Responsibilities:
 *   - Launch a browser (headless or visible)
 *   - Navigate to a quiz URL (or QR-decoded URL)
 *   - Extract question text, options, and images from the DOM
 *   - Submit answers via click/keyboard
 *
 * Contract: Questions extracted from the page must conform to the
 * Question type defined in ../types.js.
 */

import { chromium } from 'playwright';

/**
 * @typedef {object} ScraperOptions
 * @property {boolean} [headless=true]
 * @property {number} [timeout=30000]  - Navigation / action timeout in ms
 */

/**
 * Create a browser context and return utilities for scraping a quiz page.
 *
 * @param {ScraperOptions} [options]
 * @returns {Promise<{ page: import('playwright').Page, browser: import('playwright').Browser, extractQuestion: () => Promise<object>, submitAnswer: (answer: string) => Promise<void>, close: () => Promise<void> }>}
 */
export async function createBrowser(options = {}) {
  const { headless = true, timeout = 30000 } = options;

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);

  /**
   * Navigate to a quiz URL and wait for the page to settle.
   * @param {string} url
   */
  async function goto(url) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    // Give dynamic content a moment to render
    await page.waitForTimeout(1000);
  }

  /**
   * Extract the current question from the page.
   * Uses common CSS selectors for quiz platforms; customize as needed.
   *
   * @returns {Promise<object>}  A Question-shaped object (see ../types.js)
   */
  async function extractQuestion() {
    // Default selectors — override based on the target quiz platform
    const selectors = {
      question: '.question-text, .quiz-question, [data-testid="question"], h2, h3',
      options: '.option, .answer-choice, [data-testid="answer"], .choice label, .choice',
    };

    const text = await page.textContent(selectors.question) || '';
    const optionElements = page.locator(selectors.options);
    const optionCount = await optionElements.count();
    const options = [];
    for (let i = 0; i < optionCount; i++) {
      const txt = await optionElements.nth(i).textContent();
      if (txt) options.push(txt.trim());
    }

    return {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      text: text.trim(),
      options,
      type: options.length > 0 ? (options.length === 2 ? 'tf' : 'single') : 'fill',
      imageUrl: null,
      answer: null,
      source: null,
    };
  }

  /**
   * Submit an answer on the page.
   * Strategy: try clicking a matching option text, or type into an input.
   *
   * @param {string} answer - The answer text to submit
   */
  async function submitAnswer(answer) {
    // Attempt to click an option containing the answer text
    const option = page.locator('.option, .answer-choice, .choice', { hasText: answer }).first();
    if (await option.count() > 0) {
      await option.click();
    } else {
      // Fallback: type into an input field
      const input = page.locator('input[type="text"], textarea').first();
      if (await input.count() > 0) {
        await input.fill(answer);
      }
    }

    // Click submit/next button
    const submitBtn = page.locator(
      'button[type="submit"], .submit-btn, .next-btn, button:has-text("Submit"), button:has-text("Next"), button:has-text("下一题")'
    ).first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await page.waitForTimeout(500);
    }
  }

  /**
   * Clean up browser resources.
   */
  async function close() {
    await browser.close();
  }

  return { page, browser, goto, extractQuestion, submitAnswer, close };
}
