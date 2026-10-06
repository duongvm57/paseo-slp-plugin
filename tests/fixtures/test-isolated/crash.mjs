import test from 'node:test';
test('fixture kills the test runner', () => { process.kill(process.ppid, 'SIGKILL'); });
