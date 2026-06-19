/**
 * E2E test: visit real quiz page, extract questions, match against KB
 */
import { launchBrowser } from '../src/browser/launcher.js';
import { extractQuestions, isQuizPage, parseQR } from '../src/browser/extractor.js';
import { KnowledgeBase } from '../src/kb/manager.js';
import { searchKB } from '../src/kb/search.js';

// Step 1: Decode QR to get URL
console.log('=== Step 1: Parse QR ===');
const quizUrl = await parseQR('./data/安全答题链接.jpg');
console.log('Quiz URL:', quizUrl);

// Step 2: Load KB
console.log('\n=== Step 2: Load KB ===');
const kb = new KnowledgeBase('./data/kb');
await kb.list();
console.log('KB entries:', kb.size);

// Step 3: Launch browser
console.log('\n=== Step 3: Launch browser ===');
const { browser, page } = await launchBrowser({ headless: true, timeout: 60000 });

try {
  // Step 4: Navigate to quiz — intercept OAuth redirect
  console.log('\n=== Step 4: Navigate to quiz ===');

  // Block navigation to WeChat OAuth
  await page.route('**/*', (route, request) => {
    if (request.url().includes('open.weixin.qq.com')) {
      console.log('BLOCKED OAuth redirect:', request.url().substring(0, 80));
      route.abort('blockedbyclient');
    } else {
      route.continue();
    }
  });

  await page.goto(quizUrl, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);
  console.log('Final URL:', page.url());
  console.log('Page title:', await page.title());

  const html = await page.content();
  console.log('HTML (first 800 chars):', html?.substring(0, 800));

  await page.screenshot({ path: './data/quiz_page.png', fullPage: true });
  console.log('Screenshot saved');

  // Step 5: Check if quiz page
  console.log('\n=== Step 5: Detect quiz ===');
  const isQuiz = await isQuizPage(page);
  console.log('Is quiz page:', isQuiz);

  // Step 6: Extract questions
  console.log('\n=== Step 6: Extract questions ===');
  const questions = await extractQuestions(page);
  console.log('Questions found:', questions.length);

  // Step 7: Match each question against KB
  console.log('\n=== Step 7: Match against KB ===');
  let matched = 0, unmatched = 0;
  for (const q of questions) {
    console.log(`\nQ: ${q.text.substring(0, 100)}...`);
    console.log(`   Options: ${q.options.slice(0, 5).join(' | ')}`);
    const result = searchKB(kb, q.text);
    console.log(`   → ${result.method} (${result.score.toFixed(2)}) ${result.match ? result.match.answer : ''}`);
    if (result.method !== 'none') matched++;
    else unmatched++;
  }
  console.log(`\nMatched: ${matched}, Unmatched: ${unmatched}`);

} finally {
  await browser.close();
  console.log('\nBrowser closed.');
}
