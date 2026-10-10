#!/usr/bin/env node
import { supportsNodeVersion, SUPPORTED_NODE_RANGE } from '../plugin/shared/runtime/node-version.mjs';

if (!supportsNodeVersion(process.versions.node)) {
  console.error(`paseo-slp requires Node.js ${SUPPORTED_NODE_RANGE}; running ${process.versions.node}`);
  process.exitCode = 1;
} else {
  await import('../plugin/server/runtime/cli/cli.ts');
}
