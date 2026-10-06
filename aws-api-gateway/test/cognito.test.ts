import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { randomPassword } from '../scripts/lib/cognito.js';

test('random passwords satisfy the user pool policy', () => {
  for (let i = 0; i < 50; i++) {
    const pw = randomPassword();
    assert.ok(pw.length >= 12);
    for (const re of [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]) assert.match(pw, re);
  }
  assert.notEqual(randomPassword(), randomPassword());
});
