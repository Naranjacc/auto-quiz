// Contract: Question object flowing through the pipeline
// {
//   id: string,            // unique per question in session
//   text: string,          // full question text
//   options: string[],     // array of answer choices
//   type: 'single'|'multi'|'tf'|'fill',  // single choice, multi, true/false, fill-blank
//   imageUrl: string|null, // inline image in question, if any
//   answer: string|null,   // populated by engine after matching
//   source: 'kb'|'llm'|'random'|'skip', // how answer was determined
// }
