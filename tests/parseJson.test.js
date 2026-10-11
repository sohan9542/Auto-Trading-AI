'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseModelJson } = require('../src/utils/parseJson');

describe('parseModelJson', () => {
  it('parses plain JSON', () => {
    assert.deepEqual(parseModelJson('{"bias":"LONG"}'), { bias: 'LONG' });
  });

  it('strips markdown fences', () => {
    const text = '```json\n{"decision":"SKIP"}\n```';
    assert.deepEqual(parseModelJson(text), { decision: 'SKIP' });
  });

  it('throws on invalid JSON', () => {
    assert.throws(() => parseModelJson('not-json'), SyntaxError);
  });
});
