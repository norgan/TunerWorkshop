import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareConversation } from '../chat-history.mjs';
import { validateAssistantRequest } from '../assistant.mjs';

const pair = (question, answer) => [{ role: 'user', content: question }, { role: 'assistant', content: answer }];
function valid(result, current) {
  assert.doesNotThrow(() => validateAssistantRequest({ messages: result.messages }));
  assert.ok(result.messages.length <= 11);
  assert.ok(result.messages.every(message => message.content.length <= 8000));
  assert.ok(result.messages.reduce((sum, message) => sum + message.content.length, 0) <= 32000);
  assert.deepEqual(result.messages.at(-1), { role: 'user', content: current });
}

test('empty and short conversations preserve the current question and history', () => {
  const current = '  Keep my question exactly as entered.  ';
  const first = prepareConversation([], current);
  assert.equal(first.truncated, false); valid(first, current);
  const history = pair('What is MAP?', 'Manifold absolute pressure.');
  const next = prepareConversation(history, current);
  assert.deepEqual(next.messages, [...history, { role: 'user', content: current }]);
  assert.equal(next.truncated, false); valid(next, current);
});

test('a maximum-size valid assistant reply can be followed up without exceeding message limits', () => {
  const history = pair('Explain the recorded sensors.', 'A'.repeat(32000));
  const original = structuredClone(history), current = 'Which readings are stale?';
  const result = prepareConversation(history, current);
  assert.equal(result.truncated, true);
  assert.equal(result.messages[1].content.length, 8000);
  assert.match(result.messages[1].content, /\[Earlier assistant response truncated to fit conversation history\.\]$/);
  assert.deepEqual(history, original); valid(result, current);
});

test('multiple medium replies are trimmed by whole oldest turns to fit the total budget', () => {
  const history = Array.from({ length: 6 }, (_, i) => pair(`Question ${i} ${'Q'.repeat(5989)}`, `Answer ${i} ${'A'.repeat(6989)}`)).flat();
  const current = 'N'.repeat(6000), result = prepareConversation(history, current);
  assert.equal(result.truncated, true); valid(result, current);
  assert.equal(result.messages.length, 5);
  assert.match(result.messages[0].content, /^Question 4 /);
  assert.deepEqual(result.messages.slice(0, -1).map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
});

test('no more than ten prior messages are retained and the newest pairs win', () => {
  const history = Array.from({ length: 12 }, (_, i) => pair(`Question ${i}`, `Answer ${i}`)).flat();
  const current = 'Follow up', result = prepareConversation(history, current);
  assert.equal(result.truncated, true); assert.equal(result.messages.length, 11);
  assert.equal(result.messages[0].content, 'Question 7');
  assert.equal(result.messages[9].content, 'Answer 11'); valid(result, current);
});

test('a historical user request is omitted with its response instead of silently shortened', () => {
  const history = [...pair('Older', 'Older reply'), ...pair('U'.repeat(8001), 'Response to the oversized request'), ...pair('Recent question', 'Recent response')];
  const current = 'Current', result = prepareConversation(history, current);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.messages, [...pair('Recent question', 'Recent response'), { role: 'user', content: current }]);
  valid(result, current);
});

test('pair retention does not fill an odd remaining slot by separating a question and reply', () => {
  const history = [...Array.from({ length: 6 }, (_, i) => pair(`Q${i}`, `A${i}`)).flat(), { role: 'user', content: 'A pending prior question' }];
  const current = 'Additional detail', result = prepareConversation(history, current);
  assert.equal(result.truncated, true); assert.equal(result.messages.length, 10);
  assert.equal(result.messages[0].content, 'Q2');
  assert.equal(result.messages.at(-2).content, 'A pending prior question'); valid(result, current);
});

test('assistant truncation does not split Unicode surrogate pairs', () => {
  const current = 'Continue', result = prepareConversation(pair('Question', '😀'.repeat(16000)), current);
  const shortened = result.messages[1].content;
  assert.equal(shortened.isWellFormed(), true); assert.equal(result.truncated, true); valid(result, current);
});

test('current question is never shortened and invalid input fails explicitly', () => {
  for (const current of ['', '   ', '\u0000\u0001', 'U'.repeat(6001), null, 42]) assert.throws(() => prepareConversation([], current));
  assert.throws(() => prepareConversation(null, 'Question'));
  assert.throws(() => prepareConversation([{ role: 'system', content: 'Unsupported' }], 'Question'));
  assert.throws(() => prepareConversation([{ role: 'assistant', content: '\u0000' }], 'Question'));
  valid(prepareConversation([], 'U'.repeat(6000)), 'U'.repeat(6000));
});

test('repeated long exchanges continue satisfying the real backend validator', () => {
  let history = [];
  for (let turn = 0; turn < 30; turn++) {
    const current = `Question ${turn}: ${'q'.repeat(5900)}`;
    const prepared = prepareConversation(history, current); valid(prepared, current);
    history = [...prepared.messages, { role: 'assistant', content: `Answer ${turn}: ${'a'.repeat(turn % 2 ? 31500 : 7500)}` }];
  }
});
