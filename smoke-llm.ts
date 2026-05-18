import { llm } from './agents/shared.js';
// Mimic Summarizer call: long-ish system prompt + sonnet model + larger token
const out = await llm(
  [
    { role: 'system', content: 'You are CivicLens Summarizer. Write a 3-sentence neutral factual summary of the candidate. Output JSON: {"keyFacts":[],"neutralNarrative":""}' },
    { role: 'user', content: JSON.stringify({ name: 'Josh Gottheimer', bills: 186, votes: 2100, donors: 100 }) },
  ],
  { model: 'claude-sonnet-4-6', maxTokens: 1500, timeoutMs: 120_000 },
);
console.log('=== output ===');
console.log(out);
