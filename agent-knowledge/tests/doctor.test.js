import assert from 'node:assert/strict';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as agentKnowledgeModule from '../bin/agent-knowledge.js';
import {
  adapterFileNames,
  createDirectoryLink,
  createExitedProcessPid,
  createTempRoot,
  execFileAsync,
  repoRoot,
  runCli,
  runCliFailure,
  writeAdapterTemplates,
  writeExternalKnowledgeFile,
  writePendingFix,
} from './test-helpers.js';

test('doctor exports a read-only knowledge health check API', () => {
  assert.equal(typeof agentKnowledgeModule.doctor, 'function');
});

test('doctor reports structural issues, strips BOM before parsing, and skips inbox README', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/bom.md',
    '\ufeff---\ntitle: BOM rule\nstatus: confirmed\n---\n\n# BOM rule\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/missing-frontmatter.md',
    '# No frontmatter\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/wrong-status.md',
    '---\ntitle: Wrong knowledge status\nstatus: draft\n---\n\n# Wrong knowledge status\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/wrong-status.md',
    '---\ntitle: Wrong inbox status\nstatus: confirmed\n---\n\n# Wrong inbox status\n',
  );
  await writeExternalKnowledgeFile(knowledgeRoot, 'inbox/README.md', '# Inbox documentation\n');

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.checkedFiles, 4);
  assert.deepEqual(
    result.issues.filter((issue) => issue.file === 'knowledge/rules/bom.md').map((issue) => issue.code),
    ['utf8_bom'],
  );
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.file === 'knowledge/rules/missing-frontmatter.md')
      .map((issue) => issue.code),
    ['missing_frontmatter'],
  );
  assert.deepEqual(
    result.issues.filter((issue) => issue.code === 'invalid_status').map((issue) => issue.file),
    ['inbox/rules/wrong-status.md', 'knowledge/rules/wrong-status.md'],
  );
  assert.equal(result.issues.some((issue) => issue.file === 'inbox/README.md'), false);
  assert.ok(result.issues.every((issue) => issue.severity === 'error'));
});

test('doctor detects normalized duplicate titles globally and warnings do not make the result fail', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/first.md',
    '---\ntitle: Ａ   B\nstatus: confirmed\n---\n\n# This heading must not win\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/second.md',
    '---\nstatus: draft\n---\n\n# a b\n',
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });
  const duplicates = result.issues.filter((issue) => issue.code === 'duplicate_title');

  assert.equal(result.ok, true);
  assert.equal(result.checkedFiles, 2);
  assert.deepEqual(duplicates.map((issue) => issue.file), [
    'inbox/rules/second.md',
    'knowledge/rules/first.md',
  ]);
  assert.ok(duplicates.every((issue) => issue.severity === 'warning'));
});

test('doctor reports targets outside the knowledge root, missing targets, and non-Markdown targets', async () => {
  const knowledgeRoot = await createTempRoot();
  const outsideFile = path.join(path.dirname(knowledgeRoot), `${path.basename(knowledgeRoot)}-outside.md`);
  await writeFile(outsideFile, '# Outside\n', 'utf8');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/valid-target.md',
    '---\ntitle: Valid target\nstatus: confirmed\n---\n\n# Valid target\n',
  );
  await writeExternalKnowledgeFile(knowledgeRoot, 'knowledge/rules/not-markdown.txt', 'not markdown\n');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/missing.md',
    '---\ntitle: Missing target\nstatus: pending\ntarget: knowledge/rules/missing.md\n---\n\n# Missing target\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/outside.md',
    `---\ntitle: Outside target\nstatus: pending\ntarget: ../${path.basename(outsideFile)}\n---\n\n# Outside target\n`,
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/not-markdown.md',
    '---\ntitle: Text target\nstatus: pending\ntarget: knowledge/rules/not-markdown.txt\n---\n\n# Text target\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/valid.md',
    '---\ntitle: Valid reference\nstatus: pending\ntarget: knowledge/rules/valid-target.md\n---\n\n# Valid reference\n',
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });
  const brokenTargets = result.issues.filter((issue) => issue.code === 'broken_target');

  assert.deepEqual(brokenTargets.map((issue) => issue.file), [
    'inbox/fixes/missing.md',
    'inbox/fixes/not-markdown.md',
    'inbox/fixes/outside.md',
  ]);
  assert.ok(brokenTargets.every((issue) => issue.severity === 'error'));
  assert.equal(result.issues.some((issue) => issue.file === 'inbox/fixes/valid.md'
    && issue.code === 'broken_target'), false);
});

test('doctor rejects a target that escapes the real knowledge root through a directory link', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  await writeFile(path.join(outsideRoot, 'target.md'), '# Outside target\n', 'utf8');
  if (!await createDirectoryLink(t, outsideRoot, path.join(knowledgeRoot, 'linked-targets'))) {
    return;
  }
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/linked-target.md',
    '---\ntitle: Linked target\nstatus: pending\ntarget: linked-targets/target.md\n---\n\n# Linked target\n',
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.deepEqual(
    result.issues.filter((issue) => issue.file === 'inbox/fixes/linked-target.md').map((issue) => issue.code),
    ['broken_target', 'missing_target_hash'],
  );
});

test('doctor reports targeted pending fix metadata and ignores archive and work without writing', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/doctor-target.md',
    '---\ntitle: Doctor target\nstatus: confirmed\n---\n\n# Doctor target\n',
  );
  const validHash = 'a'.repeat(64);
  await writePendingFix(knowledgeRoot, 'inbox/fixes/missing-hash.md', {
    omitFixId: true,
    target: 'knowledge/rules/doctor-target.md',
  });
  await writePendingFix(knowledgeRoot, 'inbox/fixes/invalid-hash.md', {
    target: 'knowledge/rules/doctor-target.md',
    targetHash: 'not-a-sha256',
  });
  await writePendingFix(knowledgeRoot, 'inbox/fixes/invalid-id.md', {
    fixId: 'not-a-uuid',
    target: 'knowledge/rules/doctor-target.md',
    targetHash: validHash,
  });
  await writePendingFix(knowledgeRoot, 'inbox/fixes/empty-hash.md', {
    target: 'knowledge/rules/doctor-target.md',
    targetHash: '',
  });
  await writePendingFix(knowledgeRoot, 'inbox/fixes/empty-id.md', {
    fixId: '',
    target: 'knowledge/rules/doctor-target.md',
    targetHash: validHash,
  });
  await writePendingFix(knowledgeRoot, 'inbox/fixes/valid-metadata.md', {
    target: 'knowledge/rules/doctor-target.md',
    targetHash: validHash.toUpperCase(),
  });
  const archivedPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'archive/resolved/fixes/ignored.md',
    '# malformed archive must stay ignored\n',
  );
  const workPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'work/resolving/fixes/ignored.md',
    '# malformed work state must stay ignored\n',
  );
  const ignoredBefore = await Promise.all([
    readFile(archivedPath, 'utf8'),
    readFile(workPath, 'utf8'),
  ]);

  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });

  assert.equal(result.checkedFiles, 7);
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.code === 'missing_target_hash')
      .map(({ file, severity }) => ({ file, severity })),
    [{ file: 'inbox/fixes/missing-hash.md', severity: 'warning' }],
  );
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.code === 'invalid_target_hash')
      .map(({ file, severity }) => ({ file, severity })),
    [
      { file: 'inbox/fixes/empty-hash.md', severity: 'error' },
      { file: 'inbox/fixes/invalid-hash.md', severity: 'error' },
    ],
  );
  assert.deepEqual(
    result.issues
      .filter((issue) => issue.code === 'invalid_fix_id')
      .map(({ file, severity }) => ({ file, severity })),
    [
      { file: 'inbox/fixes/empty-id.md', severity: 'error' },
      { file: 'inbox/fixes/invalid-id.md', severity: 'error' },
    ],
  );
  assert.equal(result.issues.some((issue) => issue.file === 'inbox/fixes/valid-metadata.md'
    && ['missing_target_hash', 'invalid_target_hash', 'invalid_fix_id'].includes(issue.code)), false);
  assert.equal(result.issues.some((issue) => issue.file.startsWith('archive/')), false);
  assert.equal(result.issues.some((issue) => issue.file.startsWith('work/')), false);
  assert.deepEqual(await Promise.all([
    readFile(archivedPath, 'utf8'),
    readFile(workPath, 'utf8'),
  ]), ignoredBefore);
});

test('doctor treats a blank target as independent metadata', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/blank-target.md',
    '---\ntitle: Blank target\nstatus: pending\ntarget:   \n---\n\n# Blank target\n',
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.issues.some((issue) => [
    'missing_target_hash',
    'invalid_target_hash',
    'invalid_fix_id',
  ].includes(issue.code)), false);
});

test('doctor skips knowledge and inbox scan roots that are directory links escaping the knowledge root', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideKnowledgeRoot = await createTempRoot();
  const outsideInboxRoot = await createTempRoot();
  const outsideKnowledgeFile = path.join(outsideKnowledgeRoot, 'outside-knowledge.md');
  const outsideInboxFile = path.join(outsideInboxRoot, 'outside-inbox.md');
  const knowledgeSentinel = path.join(outsideKnowledgeRoot, 'sentinel.txt');
  const inboxSentinel = path.join(outsideInboxRoot, 'sentinel.txt');
  await writeFile(outsideKnowledgeFile, '# malformed external knowledge\n', 'utf8');
  await writeFile(outsideInboxFile, '# malformed external inbox\n', 'utf8');
  await writeFile(knowledgeSentinel, 'knowledge sentinel\n', 'utf8');
  await writeFile(inboxSentinel, 'inbox sentinel\n', 'utf8');
  if (!await createDirectoryLink(
    t,
    outsideKnowledgeRoot,
    path.join(knowledgeRoot, 'knowledge'),
  )) {
    return;
  }
  if (!await createDirectoryLink(
    t,
    outsideInboxRoot,
    path.join(knowledgeRoot, 'inbox'),
  )) {
    return;
  }
  const externalBefore = await Promise.all([
    readFile(outsideKnowledgeFile, 'utf8'),
    readFile(outsideInboxFile, 'utf8'),
    readFile(knowledgeSentinel, 'utf8'),
    readFile(inboxSentinel, 'utf8'),
  ]);

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.equal(result.checkedFiles, 0);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(await Promise.all([
    readFile(outsideKnowledgeFile, 'utf8'),
    readFile(outsideInboxFile, 'utf8'),
    readFile(knowledgeSentinel, 'utf8'),
    readFile(inboxSentinel, 'utf8'),
  ]), externalBefore);
  assert.deepEqual((await readdir(knowledgeRoot)).sort(), ['inbox', 'knowledge']);
  assert.deepEqual((await readdir(outsideKnowledgeRoot)).sort(), ['outside-knowledge.md', 'sentinel.txt']);
  assert.deepEqual((await readdir(outsideInboxRoot)).sort(), ['outside-inbox.md', 'sentinel.txt']);
});

test('doctor validates comma-separated evidence files against a local project root', async () => {
  const knowledgeRoot = await createTempRoot();
  const projectRoot = await createTempRoot();
  const existingEvidence = path.join(projectRoot, 'src', 'exists.js');
  await mkdir(path.dirname(existingEvidence), { recursive: true });
  await writeFile(existingEvidence, 'export {};\n', 'utf8');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/missing-project-root.md',
    '---\ntitle: Missing project root\nstatus: confirmed\nevidence_files: src/exists.js\n---\n\n# Missing project root\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/nonexistent-project-root.md',
    `---\ntitle: Nonexistent project root\nstatus: confirmed\nproject_root: ${path.join(projectRoot, 'missing')}\nevidence_files: src/exists.js\n---\n\n# Nonexistent project root\n`,
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/invalid-evidence.md',
    `---\ntitle: Invalid evidence\nstatus: confirmed\nproject_root: ${projectRoot}\nevidence_files: src/missing.js, ../outside.js, ${existingEvidence}\n---\n\n# Invalid evidence\n`,
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/valid-evidence.md',
    `---\ntitle: Valid evidence\nstatus: confirmed\nproject_root: ${projectRoot}\nevidence_files: src/exists.js\n---\n\n# Valid evidence\n`,
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.deepEqual(
    result.issues.filter((issue) => issue.code === 'missing_project_root').map((issue) => issue.file),
    ['knowledge/domain/missing-project-root.md'],
  );
  assert.equal(
    result.issues.filter((issue) => issue.code === 'missing_evidence_file'
      && issue.file === 'knowledge/domain/nonexistent-project-root.md').length,
    1,
  );
  assert.equal(
    result.issues.filter((issue) => issue.code === 'missing_evidence_file'
      && issue.file === 'knowledge/domain/invalid-evidence.md').length,
    3,
  );
  assert.equal(result.issues.some((issue) => issue.file === 'knowledge/domain/valid-evidence.md'), false);
  assert.ok(result.issues.every((issue) => issue.severity === 'warning'));
  assert.equal(result.ok, true);
});

test('doctor rejects evidence that escapes the real project root through a directory link', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const projectRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  await writeFile(path.join(outsideRoot, 'evidence.js'), 'export {};\n', 'utf8');
  if (!await createDirectoryLink(t, outsideRoot, path.join(projectRoot, 'linked-evidence'))) {
    return;
  }
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/linked-evidence.md',
    `---\ntitle: Linked evidence\nstatus: confirmed\nproject_root: ${projectRoot}\nevidence_files: linked-evidence/evidence.js\n---\n\n# Linked evidence\n`,
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.deepEqual(
    result.issues.filter((issue) => issue.file === 'knowledge/domain/linked-evidence.md').map((issue) => issue.code),
    ['missing_evidence_file'],
  );
  assert.equal(result.ok, true);
});

test('doctor allows directory links whose real targets remain inside their configured roots', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const internalTargetRoot = path.join(knowledgeRoot, 'internal-targets');
  await mkdir(internalTargetRoot, { recursive: true });
  await writeFile(path.join(internalTargetRoot, 'target.md'), '# Internal target\n', 'utf8');
  if (!await createDirectoryLink(t, internalTargetRoot, path.join(knowledgeRoot, 'linked-targets'))) {
    return;
  }
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/internal-link.md',
    '---\ntitle: Internal link\nstatus: pending\ntarget: linked-targets/target.md\n---\n\n# Internal link\n',
  );

  const projectRoot = await createTempRoot();
  const internalEvidenceRoot = path.join(projectRoot, 'internal-evidence');
  await mkdir(internalEvidenceRoot, { recursive: true });
  await writeFile(path.join(internalEvidenceRoot, 'evidence.js'), 'export {};\n', 'utf8');
  if (!await createDirectoryLink(t, internalEvidenceRoot, path.join(projectRoot, 'linked-evidence'))) {
    return;
  }
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/internal-link.md',
    `---\ntitle: Internal evidence link\nstatus: confirmed\nproject_root: ${projectRoot}\nevidence_files: linked-evidence/evidence.js\n---\n\n# Internal evidence link\n`,
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });

  assert.equal(result.issues.some((issue) => ['broken_target', 'missing_evidence_file'].includes(issue.code)), false);
});

test('doctor sorts issues by file, code, and message', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/z.md',
    '---\ntitle: Z\nstatus: draft\n---\n\n# Z\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/a.md',
    '---\ntitle: A\nstatus: draft\n---\n\n# A\n',
  );

  const result = await agentKnowledgeModule.doctor({
    knowledgeRoot,
    repositoryRoot: await createTempRoot(),
  });
  const issueKeys = result.issues.map((issue) => `${issue.file}\u0000${issue.code}\u0000${issue.message}`);

  assert.deepEqual(issueKeys, issueKeys.slice().sort());
});

test('doctor reports orphan lock and invalid lock warnings only in known safe lock ranges', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const exitedPid = await createExitedProcessPid();
  const orphanToken = `${exitedPid}:11111111-1111-4111-8111-111111111111\n`;
  const liveToken = `${process.pid}:22222222-2222-4222-8222-222222222222\n`;
  const invalidToken = 'not-a-lock-token\n';

  const orphanAdjacentLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/orphan.md.lock',
    orphanToken,
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/orphan.md',
    '---\ntitle: Orphan lock target\nstatus: confirmed\n---\n\n# Orphan lock target\n',
  );
  const invalidAdjacentGuard = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/invalid.md.lock.reclaim',
    invalidToken,
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/invalid.md',
    '---\ntitle: Invalid lock target\nstatus: draft\n---\n\n# Invalid lock target\n',
  );
  const pidOnlyAdjacentLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/pid-only.md.lock',
    `${exitedPid}\n`,
  );
  const badTokenAdjacentLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/bad-token.md.lock',
    `${exitedPid}:bad-token\n`,
  );
  const extraContentAdjacentLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/extra-content.md.lock',
    `${exitedPid}:55555555-5555-4555-8555-555555555555\nextra\n`,
  );
  const bomAdjacentLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/bom.md.lock',
    `\ufeff${exitedPid}:66666666-6666-4666-8666-666666666666\n`,
  );
  const duplicateLineEndingLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/double-newline.md.lock',
    `${exitedPid}:12121212-1212-4121-8121-121212121212\n\n`,
  );
  const noLineEndingLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/no-eol.md.lock',
    `${exitedPid}:13131313-1313-4131-8131-131313131313`,
  );
  const crlfLineEndingLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/crlf.md.lock',
    `${exitedPid}:14141414-1414-4141-8141-141414141414\r\n`,
  );
  const liveAdjacentLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/live.md.lock',
    liveToken,
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/live.md',
    '---\ntitle: Live lock target\nstatus: confirmed\n---\n\n# Live lock target\n',
  );
  const orphanResolveLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    `work/locks/resolve/${'a'.repeat(64)}.lock`,
    orphanToken,
  );
  const invalidResolveGuard = await writeExternalKnowledgeFile(
    knowledgeRoot,
    `work/locks/resolve/${'b'.repeat(64)}.lock.reclaim`,
    invalidToken,
  );
  const liveResolveLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    `work/locks/resolve/${'c'.repeat(64)}.lock`,
    liveToken,
  );
  const overflowResolveLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    `work/locks/resolve/${'d'.repeat(64)}.lock`,
    '999999999999999999999999:77777777-7777-4777-8777-777777777777\n',
  );
  const resolveSentinel = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'work/locks/resolve/sentinel.txt',
    orphanToken,
  );
  const adjacentNotesLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/notes.lock',
    orphanToken,
  );
  const adjacentBackupLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/foo.md.lock.bak',
    invalidToken,
  );
  const nonHashResolveLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'work/locks/resolve/not-a-hash.lock',
    orphanToken,
  );
  const uppercaseHashResolveLock = await writeExternalKnowledgeFile(
    knowledgeRoot,
    `work/locks/resolve/${'E'.repeat(64)}.lock`,
    orphanToken,
  );
  const outsideLock = await writeExternalKnowledgeFile(
    outsideRoot,
    'knowledge/rules/outside.md.lock',
    orphanToken,
  );
  const inspectedLocks = [
    orphanAdjacentLock,
    invalidAdjacentGuard,
    pidOnlyAdjacentLock,
    badTokenAdjacentLock,
    extraContentAdjacentLock,
    bomAdjacentLock,
    duplicateLineEndingLock,
    noLineEndingLock,
    crlfLineEndingLock,
    liveAdjacentLock,
    orphanResolveLock,
    invalidResolveGuard,
    liveResolveLock,
    overflowResolveLock,
    resolveSentinel,
    adjacentNotesLock,
    adjacentBackupLock,
    nonHashResolveLock,
    uppercaseHashResolveLock,
    outsideLock,
  ];
  const before = await Promise.all(inspectedLocks.map((filePath) => readFile(filePath, 'utf8')));

  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });
  const lockIssues = result.issues.filter((issue) => ['orphan_lock', 'invalid_lock'].includes(issue.code));

  assert.equal(result.ok, true);
  assert.deepEqual(
    lockIssues.map(({ severity, code, file }) => ({ severity, code, file })),
    [
      { severity: 'warning', code: 'invalid_lock', file: 'inbox/rules/invalid.md.lock.reclaim' },
      { severity: 'warning', code: 'invalid_lock', file: 'knowledge/rules/bad-token.md.lock' },
      { severity: 'warning', code: 'invalid_lock', file: 'knowledge/rules/bom.md.lock' },
      { severity: 'warning', code: 'orphan_lock', file: 'knowledge/rules/crlf.md.lock' },
      { severity: 'warning', code: 'invalid_lock', file: 'knowledge/rules/double-newline.md.lock' },
      { severity: 'warning', code: 'invalid_lock', file: 'knowledge/rules/extra-content.md.lock' },
      { severity: 'warning', code: 'orphan_lock', file: 'knowledge/rules/no-eol.md.lock' },
      { severity: 'warning', code: 'orphan_lock', file: 'knowledge/rules/orphan.md.lock' },
      { severity: 'warning', code: 'invalid_lock', file: 'knowledge/rules/pid-only.md.lock' },
      { severity: 'warning', code: 'orphan_lock', file: `work/locks/resolve/${'a'.repeat(64)}.lock` },
      { severity: 'warning', code: 'invalid_lock', file: `work/locks/resolve/${'b'.repeat(64)}.lock.reclaim` },
      { severity: 'warning', code: 'invalid_lock', file: `work/locks/resolve/${'d'.repeat(64)}.lock` },
    ],
  );
  assert.ok(lockIssues.filter((issue) => issue.code === 'orphan_lock')
    .every((issue) => issue.message.includes(String(exitedPid)) && issue.message.includes('人工')));
  assert.deepEqual(
    lockIssues.map((issue) => `${issue.file}\u0000${issue.code}\u0000${issue.message}`),
    lockIssues.map((issue) => `${issue.file}\u0000${issue.code}\u0000${issue.message}`).slice().sort(),
  );
  assert.deepEqual(
    await Promise.all(inspectedLocks.map((filePath) => readFile(filePath, 'utf8'))),
    before,
  );
});

test('doctor lock diagnosis skips external directory links for adjacent and resolve lock parents', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  const outsideAdjacentRoot = await createTempRoot();
  const outsideResolveRoot = await createTempRoot();
  const exitedPid = await createExitedProcessPid();
  const orphanToken = `${exitedPid}:33333333-3333-4333-8333-333333333333\n`;
  const outsideAdjacentLock = path.join(outsideAdjacentRoot, 'external.md.lock');
  const outsideResolveLock = path.join(outsideResolveRoot, `${'d'.repeat(64)}.lock`);
  const outsideAdjacentSentinel = path.join(outsideAdjacentRoot, 'sentinel.txt');
  const outsideResolveSentinel = path.join(outsideResolveRoot, 'sentinel.txt');
  await writeFile(outsideAdjacentLock, orphanToken, 'utf8');
  await writeFile(outsideResolveLock, orphanToken, 'utf8');
  await writeFile(outsideAdjacentSentinel, 'adjacent sentinel\n', 'utf8');
  await writeFile(outsideResolveSentinel, 'resolve sentinel\n', 'utf8');
  await mkdir(path.join(knowledgeRoot, 'knowledge'), { recursive: true });
  const lockNamedLink = path.join(knowledgeRoot, 'knowledge', 'external.md.lock');
  if (!await createDirectoryLink(t, outsideAdjacentRoot, lockNamedLink)) {
    return;
  }
  await mkdir(path.join(knowledgeRoot, 'work', 'locks'), { recursive: true });
  if (!await createDirectoryLink(
    t,
    outsideAdjacentRoot,
    path.join(knowledgeRoot, 'knowledge', 'linked-parent'),
  )) {
    return;
  }
  if (!await createDirectoryLink(
    t,
    outsideResolveRoot,
    path.join(knowledgeRoot, 'work', 'locks', 'resolve'),
  )) {
    return;
  }
  const externalBefore = await Promise.all([
    readFile(outsideAdjacentLock, 'utf8'),
    readFile(outsideResolveLock, 'utf8'),
    readFile(outsideAdjacentSentinel, 'utf8'),
    readFile(outsideResolveSentinel, 'utf8'),
  ]);

  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });

  assert.equal(result.issues.some((issue) => ['orphan_lock', 'invalid_lock'].includes(issue.code)), false);
  assert.deepEqual(await Promise.all([
    readFile(outsideAdjacentLock, 'utf8'),
    readFile(outsideResolveLock, 'utf8'),
    readFile(outsideAdjacentSentinel, 'utf8'),
    readFile(outsideResolveSentinel, 'utf8'),
  ]), externalBefore);
  assert.equal((await lstat(lockNamedLink)).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(knowledgeRoot, 'knowledge', 'linked-parent'))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(knowledgeRoot, 'work', 'locks', 'resolve'))).isSymbolicLink(), true);
});

test('doctor skips adapter checks when the OpenCode target directory is absent', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/valid.md',
    '---\ntitle: Valid\nstatus: confirmed\n---\n\n# Valid\n',
  );

  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });

  assert.equal(result.ok, true);
  assert.equal(result.issues.some((issue) => issue.code === 'adapter_drift'), false);
  assert.equal(existsSync(path.join(repositoryRoot, '.opencode', 'command')), false);
});

test('doctor reports missing and drifted adapter targets without modifying them', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  const targetDir = path.join(repositoryRoot, '.opencode', 'command');
  const driftedTarget = path.join(targetDir, adapterFileNames[0]);
  const missingTarget = path.join(targetDir, adapterFileNames[1]);
  await writeAdapterTemplates(repositoryRoot);
  await mkdir(targetDir, { recursive: true });
  await writeFile(driftedTarget, 'outdated\n', 'utf8');

  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });
  const adapterIssues = result.issues.filter((issue) => issue.code === 'adapter_drift');

  assert.equal(result.ok, false);
  assert.equal(adapterIssues.length, 2);
  assert.ok(adapterIssues.every((issue) => issue.severity === 'error'));
  assert.equal(await readFile(driftedTarget, 'utf8'), 'outdated\n');
  assert.equal(existsSync(missingTarget), false);
});

test('doctor converts adapter template read failures into adapter_drift issues', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  await mkdir(path.join(repositoryRoot, '.opencode', 'command'), { recursive: true });

  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });
  const adapterIssues = result.issues.filter((issue) => issue.code === 'adapter_drift');

  assert.equal(result.ok, false);
  assert.equal(adapterIssues.length, adapterFileNames.length);
  assert.ok(adapterIssues.every((issue) => issue.message.length > 0));
});

test('CLI doctor --json emits one JSON object and exits zero for warnings only', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/warning.md',
    '---\ntitle: Warning only\nstatus: confirmed\nevidence_files: src/missing.js\n---\n\n# Warning only\n',
  );

  const { stdout, stderr } = await runCli([
    'doctor',
    '--json',
    '--knowledge-root',
    knowledgeRoot,
    '--repository-root',
    repositoryRoot,
  ]);
  const parsed = JSON.parse(stdout);

  assert.equal(stderr, '');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.issues[0].severity, 'warning');
});

test('CLI doctor --json emits one JSON object and exits one for errors', async () => {
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  await writeExternalKnowledgeFile(knowledgeRoot, 'knowledge/broken.md', '# Missing frontmatter\n');

  const error = await runCliFailure([
    'doctor',
    '--json',
    '--knowledge-root',
    knowledgeRoot,
    '--repository-root',
    repositoryRoot,
  ]);
  const parsed = JSON.parse(error.stdout);

  assert.equal(error.code, 1);
  assert.equal(error.stderr, '');
  assert.equal(parsed.ok, false);
  assert.equal(parsed.issues[0].code, 'missing_frontmatter');
});

test('CLI doctor rejects non-global positional arguments', async () => {
  const error = await runCliFailure(['doctor', 'unexpected']);

  assert.equal(error.code, 1);
  assert.match(`${error.stderr}${error.stdout}`, /doctor/);
});

test('CLI doctor rejects --knowledge-root when the next token is another option', async () => {
  const error = await runCliFailure(['doctor', '--knowledge-root', '--json']);

  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /--knowledge-root/);
});

test('CLI doctor rejects an empty --knowledge-root assignment', async () => {
  const error = await runCliFailure(['doctor', '--knowledge-root=']);

  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /--knowledge-root/);
});

test('CLI doctor rejects --knowledge-root without a value', async () => {
  const error = await runCliFailure(['doctor', '--knowledge-root']);

  assert.equal(error.code, 1);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /--knowledge-root/);
});

test('ak.ps1 doctor --json forwards the tool repository root and JSON mode', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const fakeBin = await createTempRoot();
  const arbitraryCwd = await createTempRoot();
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
  };
  await writeFile(path.join(fakeBin, 'node.cmd'), '@echo off\r\necho %*\r\n', 'utf8');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'doctor',
    '--json',
  ], {
    cwd: arbitraryCwd,
    encoding: 'utf8',
    env,
  });

  assert.match(stdout, /doctor/);
  assert.match(stdout, /--json/);
  assert.ok(stdout.includes(`--repository-root ${repoRoot}`), stdout);
  assert.match(stdout, /--knowledge-root/);
});

test('ak.ps1 doctor rejects invalid arguments without invoking node', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const fakeBin = await createTempRoot();
  const arbitraryCwd = await createTempRoot();
  const markerPath = path.join(fakeBin, 'node-called.txt');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    AK_NODE_MARKER: markerPath,
    [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
  };
  await writeFile(
    path.join(fakeBin, 'node.cmd'),
    '@echo off\r\ntype nul > "%AK_NODE_MARKER%"\r\nexit /b 0\r\n',
    'utf8',
  );

  let result;
  try {
    result = { code: 0, ...await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      'doctor',
      '--json',
      '--json',
    ], {
      cwd: arbitraryCwd,
      encoding: 'utf8',
      env,
    }) };
  } catch (error) {
    result = error;
  }

  assert.notEqual(result.code, 0);
  assert.match(`${result.stderr}${result.stdout}`, /ak doctor accepts/i);
  assert.equal(existsSync(markerPath), false);
});
