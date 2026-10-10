#!/usr/bin/env node
// The validate job's named gate on the test-shard dependency result: success
// continues; failure, cancellation, skip, or anything unexpected fails the
// required check by name (exit 1) instead of disappearing as a skip. Scope:
// this covers shard/dependency cancellation while the workflow itself is
// still running — a workflow-wide Human cancellation is GitHub's own
// cancellation and may skip or cancel this job; that is documented and never
// claimed as a guaranteed named failure.
const result = process.argv[2];
if (result === 'success') {
  console.log('test-shard result: success — coverage gate continues');
  process.exit(0);
}
console.error(`test-shard result: ${result ?? 'missing'} — required check fails closed`);
process.exit(1);
