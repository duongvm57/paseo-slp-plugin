import test from 'node:test';
import assert from 'node:assert/strict';
test('fixture passes', () => {});
test('fixture fails on purpose', () => assert.equal(1, 2));
