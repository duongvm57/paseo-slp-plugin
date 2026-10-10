import test from 'node:test';
import { writeFileSync } from 'node:fs';
test('fixture changes the candidate while running', () => { writeFileSync('drift.txt', 'changed during the run\n'); });
