'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { requireEnv } = require('../src/utils/env');

describe('requireEnv', () => {
  const keys = ['TEST_ENV_A', 'TEST_ENV_B'];

  beforeEach(() => {
    for (const key of keys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of keys) delete process.env[key];
  });

  it('passes when all variables are set', () => {
    process.env.TEST_ENV_A = '1';
    process.env.TEST_ENV_B = '2';
    assert.doesNotThrow(() => requireEnv(keys));
  });

  it('throws listing missing names', () => {
    process.env.TEST_ENV_A = '1';
    assert.throws(() => requireEnv(keys), /TEST_ENV_B/);
  });

  it('treats blank values as missing', () => {
    process.env.TEST_ENV_A = '   ';
    process.env.TEST_ENV_B = 'ok';
    assert.throws(() => requireEnv(keys), /TEST_ENV_A/);
  });
});
