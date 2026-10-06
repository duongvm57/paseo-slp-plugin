import test from 'node:test';
import { existsSync } from 'node:fs';
import assert from 'node:assert/strict';
test('kept failure', () => assert.fail('always'));
test('gone failure', () => assert.ok(!existsSync('gone')));
test('fresh failure', () => assert.ok(!existsSync('fresh')));
