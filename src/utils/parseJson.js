'use strict';

/**
 * Parse a model response that may be wrapped in Markdown code fences.
 * @param {string} text
 * @returns {unknown}
 */
function parseModelJson(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Expected a string response to parse as JSON');
  }
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

module.exports = { parseModelJson };
