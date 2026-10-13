/** Prepare bounded chat history without altering the currently submitted question. */
const MAX_CURRENT = 6000;
const MAX_MESSAGE = 8000;
const MAX_TOTAL = 32000;
const MAX_PRIOR = 10;
const TRUNCATION_NOTE = '\n\n[Earlier assistant response truncated to fit conversation history.]';
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function assert(condition, message) { if (!condition) throw new Error(message); }
function inspectMessage(message) {
  assert(message && typeof message === 'object' && !Array.isArray(message), 'Conversation history contains an invalid message.');
  assert(message.role === 'user' || message.role === 'assistant', 'Conversation history supports user and assistant messages only.');
  assert(typeof message.content === 'string' && message.content.replace(controls, '').trim().length > 0, 'Conversation history messages must contain text.');
  return { role: message.role, content: message.content };
}
function shortenAssistant(content) {
  let end = MAX_MESSAGE - TRUNCATION_NOTE.length;
  // Keep UTF-16 surrogate pairs together while respecting the server's character limit.
  const last = content.charCodeAt(end - 1), next = content.charCodeAt(end);
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--;
  return content.slice(0, end) + TRUNCATION_NOTE;
}

/**
 * Retain a recent suffix of complete user/assistant turns where possible. Long
 * assistant answers are explicitly shortened; an oversized historical user turn
 * and all older history are omitted rather than rewriting that user's request.
 * The latest question is preserved exactly. The caller can explain truncated=true
 * in the interface; messages are compatible with validateAssistantRequest.
 */
export function prepareConversation(history, currentText) {
  assert(Array.isArray(history), 'Conversation history must be an array.');
  assert(typeof currentText === 'string' && currentText.length <= MAX_CURRENT, 'The current message must be text of at most 6000 characters.');
  assert(currentText.replace(controls, '').trim().length > 0, 'Enter a message before sending.');
  const recentTurns = [];
  let index = history.length - 1, count = 0, total = currentText.length, truncated = false;
  while (index >= 0) {
    if (count === MAX_PRIOR) { truncated = true; break; }
    const latest = inspectMessage(history[index]);
    const turn = [latest]; index--;
    if (latest.role === 'assistant' && index >= 0 && history[index]?.role === 'user') { turn.unshift(inspectMessage(history[index])); index--; }
    if (turn.some(message => message.role === 'user' && message.content.length > MAX_MESSAGE)) { truncated = true; break; }
    for (const message of turn) if (message.content.length > MAX_MESSAGE) { message.content = shortenAssistant(message.content); truncated = true; }
    const length = turn.reduce((sum, message) => sum + message.content.length, 0);
    if (count + turn.length > MAX_PRIOR || total + length > MAX_TOTAL) { truncated = true; break; }
    recentTurns.push(turn); count += turn.length; total += length;
  }
  return { messages: [...recentTurns.reverse().flat(), { role: 'user', content: currentText }], truncated };
}
