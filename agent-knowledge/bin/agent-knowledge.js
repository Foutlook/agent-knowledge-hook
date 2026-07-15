#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../lib/cli.js';

export { doctor } from '../lib/doctor.js';
export {
  addRule,
  checkStale,
  listPending,
  promote,
  recordFix,
  refreshProject,
} from '../lib/lifecycle.js';
export { resolveFix } from '../lib/resolve-fix.js';
export { extractKeywords, extractQueryKeywords, searchKnowledge } from '../lib/retrieval.js';
export { syncAdapters, syncCommandDocs } from '../lib/repository-maintenance.js';
export { writeFileAtomic, writeUniqueFile } from '../lib/knowledge-files.js';

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (executedPath === modulePath) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
