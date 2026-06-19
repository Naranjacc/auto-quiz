/**
 * Extract Q&A pairs from 安全答题题库.docx and import into KB.
 * Pattern: red-colored text in docx = correct answer.
 * Question text = black text before + after the answer, joined.
 */
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { KnowledgeBase } from '../src/kb/manager.js';

// Step 1: Extract document.xml from docx
const xml = execSync(
  `unzip -p "data/安全答题题库.docx" word/document.xml`,
  { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
);

// Step 2: Parse paragraphs
// Each <w:p>...</w:p> is one paragraph
const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
const paragraphs = xml.match(paraRegex) || [];
console.log(`Found ${paragraphs.length} paragraphs`);

// Step 3: Extract Q&A from each paragraph
const pairs = [];

for (const para of paragraphs) {
  // Extract runs <w:r>...</w:r> within paragraph
  const runRegex = /<w:r[\s>][\s\S]*?<\/w:r>/g;
  const runs = para.match(runRegex) || [];

  let questionParts = [];
  let answerParts = [];

  for (const run of runs) {
    // Check if this run has red color
    const isRed = /<w:color[^>]*w:val="FF0000"/.test(run);
    // Extract text from <w:t> tags
    const textRegex = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let textMatch;
    const texts = [];
    while ((textMatch = textRegex.exec(run)) !== null) {
      texts.push(textMatch[1]);
    }
    const text = texts.join('');

    if (isRed) {
      answerParts.push(text);
    } else {
      questionParts.push(text);
    }
  }

  const question = questionParts.join('').trim();
  const answer = answerParts.join('').trim();

  // Skip empty / non-question paragraphs
  if (!question || question.length < 5) continue;
  // Title line
  if (question.includes('安全答题题库') && !answer) continue;

  pairs.push({ question, answer });
}

console.log(`Extracted ${pairs.length} Q&A pairs`);

// Step 4: Show sample
for (let i = 0; i < Math.min(3, pairs.length); i++) {
  console.log(`\n[${i + 1}] Q: ${pairs[i].question.substring(0, 80)}...`);
  console.log(`    A: ${pairs[i].answer}`);
}

// Step 5: Import into KB
const kb = new KnowledgeBase('./data/kb');
let count = 0;
for (const pair of pairs) {
  if (pair.answer) {
    await kb.add({
      question: pair.question,
      answer: pair.answer,
      tags: ['安全答题', '2026'],
    });
    count++;
  }
}
console.log(`\nImported ${count} entries into KB`);

// Verify
const all = await kb.list();
console.log(`KB total: ${all.length} entries`);
