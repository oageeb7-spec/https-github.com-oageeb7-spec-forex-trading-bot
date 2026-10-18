import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Brain } from '../server/engine/brain.js';
import { Assistant, answerLocal, context } from '../server/engine/assistant.js';

const brain = new Brain({});
for (let i = 0; i < 120; i++) brain.tick(Date.now() + i * 1000);
const s = brain.snapshot();

test('live questions are answered from the state without Claude', () => {
  assert.match(answerLocal('what is gold at', s), /^Gold is at \d/);
  assert.match(answerLocal("what's the bitcoin price?", s), /Bitcoin is at/);
  assert.match(answerLocal('which strategy is best', s), /best is|No strategy/);
  assert.match(answerLocal('how much have we spent', s), /thinking budget used/);
  assert.match(answerLocal('is the exchange connected', s), /No exchange is connected/);
  assert.equal(answerLocal('why do breakouts fail in ranges', s), null);
});

test('open questions go to Claude with the state, and are charged', async () => {
  let req;
  const client = { beta: { messages: { create: async (r) => { req = r; return { model: 'claude-opus-5-5', stop_reason: 'end_turn', usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: 'text', text: 'Because **ranges** fake out.' }] }; } } } };
  const r = await new Assistant({ client }).ask('why do breakouts fail in ranges', s);
  assert.equal(r.by, 'claude');
  assert.equal(r.answer, 'Because ranges fake out.');
  assert.ok(r.cost > 0);
  assert.match(req.messages[0].content, /<state>[\s\S]*"prices"[\s\S]*Question: why do breakouts/);
  assert.ok(JSON.parse(context(s)).topStrategies);
});

test('without a key, open questions get a helpful fallback', async () => {
  const r = await new Assistant({}).ask('why do breakouts fail', s);
  if (process.env.ANTHROPIC_API_KEY) return;
  assert.equal(r.by, 'local');
  assert.match(r.answer, /Add an Anthropic key/);
});
