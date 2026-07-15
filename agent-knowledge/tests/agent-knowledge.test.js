import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdtemp, mkdir, readdir, readFile, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  addRule,
  checkStale,
  extractKeywords,
  extractQueryKeywords,
  listPending,
  promote,
  recordFix,
  refreshProject,
  searchKnowledge,
} from '../bin/agent-knowledge.js';
import * as agentKnowledgeModule from '../bin/agent-knowledge.js';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, '..', 'bin', 'agent-knowledge.js');
const repoRoot = path.resolve(testDir, '..', '..');
const adapterFileNames = [
  'knowledge.before-task.md',
  'knowledge.record-fix.md',
];

async function createTempRoot() {
  return mkdtemp(path.join(tmpdir(), 'agent-knowledge-test-'));
}

async function createDirectoryLink(t, targetPath, linkPath) {
  try {
    await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      t.skip(`directory links are unavailable on this platform: ${error.code}`);
      return false;
    }
    throw error;
  }
}

async function writeKnowledgeFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, 'agent-knowledge', relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function writeExternalKnowledgeFile(knowledgeRoot, relativePath, content) {
  const filePath = path.join(knowledgeRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

async function listMarkdownFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => path.join(dir, entry.name));
}

async function readOnlyMarkdownFile(dir) {
  const files = await listMarkdownFiles(dir);
  assert.equal(files.length, 1);
  return {
    filePath: files[0],
    content: await readFile(files[0], 'utf8'),
  };
}

async function assertNoBom(filePath) {
  const bytes = await readFile(filePath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
}

async function writeAdapterTemplates(repositoryRoot) {
  const templateDir = path.join(repositoryRoot, 'agent-knowledge', 'templates', 'opencode');
  await mkdir(templateDir, { recursive: true });
  for (const fileName of adapterFileNames) {
    await writeFile(path.join(templateDir, fileName), `template: ${fileName}\n`, 'utf8');
  }
}

async function writeAdapterTargets(repositoryRoot, content = 'installed target\n') {
  const targetDir = path.join(repositoryRoot, '.opencode', 'command');
  await mkdir(targetDir, { recursive: true });
  for (const fileName of adapterFileNames) {
    await writeFile(path.join(targetDir, fileName), content, 'utf8');
  }
}

async function snapshotAdapterTargets(repositoryRoot) {
  return Promise.all(adapterFileNames.map(async (fileName) => {
    const filePath = path.join(repositoryRoot, '.opencode', 'command', fileName);
    return {
      content: await readFile(filePath, 'utf8'),
      mtimeMs: (await stat(filePath)).mtimeMs,
    };
  }));
}

async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

async function runCliFailure(args, options = {}) {
  try {
    await runCli(args, options);
  } catch (error) {
    return error;
  }

  assert.fail(`Expected CLI to fail for args: ${args.join(' ')}`);
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

async function createGitProject() {
  const projectRoot = await createTempRoot();
  await runGit(['init'], projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), '# demo\n', 'utf8');
  await runGit(['add', 'README.md'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '初始化',
  ], projectRoot);
  return projectRoot;
}

async function createExitedProcessPid() {
  const child = execFile(process.execPath, ['-e', '']);
  const childPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return childPid;
}

function resultPath(result) {
  if (typeof result === 'string') {
    return result;
  }

  return result.path ?? result.filePath ?? result.file;
}

async function createResolvableFix(knowledgeRoot, { type = 'bug', title = 'resolve lifecycle' } = {}) {
  const originalTargetContent = [
    '---',
    'title: resolve target',
    'status: confirmed',
    '---',
    '',
    '# resolve target',
    '',
    'original target body',
    '',
  ].join('\n');
  const targetPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/resolve-target.md',
    originalTargetContent,
  );
  const fix = await recordFix({
    knowledgeRoot,
    type,
    title,
    target: 'knowledge/rules/resolve-target.md',
  });

  return {
    sourcePath: fix.path,
    sourceRelative: path.relative(knowledgeRoot, fix.path).replaceAll('\\', '/'),
    targetPath,
    originalTargetContent,
  };
}

async function writePendingFix(knowledgeRoot, relativePath, fields = {}) {
  const content = [
    '---',
    `title: ${fields.title ?? 'manual fix'}`,
    'type: bug',
    `status: ${fields.status ?? 'pending'}`,
    'updated: 2026-07-13',
    ...(fields.omitFixId ? [] : [`fix_id: ${fields.fixId ?? '11111111-1111-4111-8111-111111111111'}`]),
    ...(fields.target === undefined ? [] : [`target: ${fields.target}`]),
    ...(fields.targetHash === undefined ? [] : [`target_hash: ${fields.targetHash}`]),
    '---',
    '',
    '# manual fix',
    '',
    'fix body must survive resolution',
    '',
  ].join('\n');
  return writeExternalKnowledgeFile(knowledgeRoot, relativePath, content);
}

function resolveFix(options) {
  return agentKnowledgeModule.resolveFix(options);
}

function resolutionArtifactPaths(knowledgeRoot, sourcePath) {
  const category = path.basename(path.dirname(sourcePath));
  const fileName = path.basename(sourcePath);
  const claimContainer = path.join(knowledgeRoot, 'work', 'resolving', category, `${fileName}.claim`);
  return {
    claimContainer,
    claim: path.join(claimContainer, 'source.md'),
    survivor: path.join(knowledgeRoot, 'archive', 'source-survivors', category, fileName),
    snapshot: path.join(knowledgeRoot, 'archive', 'resolved-sources', category, fileName),
    resolved: path.join(knowledgeRoot, 'archive', 'resolved', category, fileName),
  };
}

function windowsSourceCaseVariant(relativeSource) {
  const parts = relativeSource.split('/');
  const fileName = parts.at(-1);
  parts[parts.length - 1] = fileName.toUpperCase();
  return parts.join('/');
}

function assertNoResolutionArtifacts(knowledgeRoot, sourcePath) {
  for (const artifactPath of Object.values(resolutionArtifactPaths(knowledgeRoot, sourcePath))) {
    assert.ok(!existsSync(artifactPath), `unexpected resolve artifact: ${artifactPath}`);
  }
}

async function assertResolveLockReleased(knowledgeRoot) {
  const lockDir = path.join(knowledgeRoot, 'work', 'locks', 'resolve');
  if (existsSync(lockDir)) {
    assert.deepEqual(await readdir(lockDir), []);
  }
}

async function swapDirectoryForExternalLink(t, directory, outsideRoot) {
  const backupDirectory = `${directory}.safe-backup`;
  await rename(directory, backupDirectory);
  const linked = await createDirectoryLink(t, outsideRoot, directory);
  return { backupDirectory, linked };
}

async function changeResolvableTarget(fix, body = 'human reviewed target body') {
  const content = [
    '---',
    'title: resolve target',
    'status: confirmed',
    '---',
    '',
    '# resolve target',
    '',
    body,
    '',
  ].join('\n');
  await writeFile(fix.targetPath, content, 'utf8');
  return Buffer.from(content, 'utf8');
}

async function interruptResolveAt(knowledgeRoot, fix, stage) {
  const interruption = new Error(`interrupt at ${stage}`);
  const hooks = stage === 'after-claim'
    ? { afterClaimRename: async () => { throw interruption; } }
    : {
        beforeArchiveWrite: async ({ stage: currentStage }) => {
          if (currentStage === stage) {
            throw interruption;
          }
        },
      };
  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative, hooks }),
    (error) => error === interruption,
  );
}

async function writeLegacyTargetedFix(knowledgeRoot, relativePath, { fixId = '' } = {}) {
  const targetContent = [
    '---',
    'title: legacy target',
    'status: confirmed',
    '---',
    '',
    '# legacy target',
    '',
    'legacy target already reviewed',
    '',
  ].join('\n');
  await writeExternalKnowledgeFile(knowledgeRoot, 'knowledge/rules/legacy-target.md', targetContent);
  const content = [
    '---',
    'title: legacy correction',
    'type: bug',
    'status: pending',
    'updated: 2026-07-13',
    ...(fixId ? [`fix_id: ${fixId}`] : []),
    'target: knowledge/rules/legacy-target.md',
    '---',
    '',
    '# legacy correction',
    '',
    'legacy source body',
    '',
  ].join('\n');
  const sourcePath = await writeExternalKnowledgeFile(knowledgeRoot, relativePath, content);
  return {
    sourcePath,
    sourceRelative: relativePath,
    sourceBytes: Buffer.from(content, 'utf8'),
  };
}

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

test('syncAdapters check reports drift without writing targets', async () => {
  const repositoryRoot = await createTempRoot();
  const templateDir = path.join(repositoryRoot, 'agent-knowledge', 'templates', 'opencode');
  const targetDir = path.join(repositoryRoot, '.opencode', 'command');
  const beforeTarget = path.join(targetDir, 'knowledge.before-task.md');
  const fixTarget = path.join(targetDir, 'knowledge.record-fix.md');
  await mkdir(templateDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  await writeFile(path.join(templateDir, 'knowledge.before-task.md'), 'before template\n', 'utf8');
  await writeFile(path.join(templateDir, 'knowledge.record-fix.md'), 'fix template\n', 'utf8');
  await writeFile(beforeTarget, 'outdated target\n', 'utf8');

  assert.equal(typeof agentKnowledgeModule.syncAdapters, 'function');
  const result = await agentKnowledgeModule.syncAdapters({ repositoryRoot, check: true });

  assert.equal(result.ok, false);
  assert.ok(result.issues.length > 0);
  assert.ok(result.issues.every((issue) => issue.code === 'adapter_drift'));
  assert.deepEqual(result.synced, []);
  assert.equal(await readFile(beforeTarget, 'utf8'), 'outdated target\n');
  assert.equal(existsSync(fixTarget), false);
});

test('syncAdapters writes fixed OpenCode targets and a later check is clean', async () => {
  const repositoryRoot = await createTempRoot();
  await writeAdapterTemplates(repositoryRoot);

  assert.equal(typeof agentKnowledgeModule.syncAdapters, 'function');
  const syncResult = await agentKnowledgeModule.syncAdapters({ repositoryRoot });

  assert.equal(syncResult.ok, true);
  assert.deepEqual(syncResult.issues, []);
  assert.equal(syncResult.synced.length, adapterFileNames.length);
  for (const fileName of adapterFileNames) {
    const templatePath = path.join(repositoryRoot, 'agent-knowledge', 'templates', 'opencode', fileName);
    const targetPath = path.join(repositoryRoot, '.opencode', 'command', fileName);
    assert.equal(await readFile(targetPath, 'utf8'), await readFile(templatePath, 'utf8'));
    await assertNoBom(targetPath);
  }

  const checkResult = await agentKnowledgeModule.syncAdapters({ repositoryRoot, check: true });
  assert.equal(checkResult.ok, true);
  assert.deepEqual(checkResult.issues, []);
  assert.deepEqual(checkResult.synced, []);
});

test('correction lifecycle documentation keeps every agent entry on the same contract', async (t) => {
  const templatePath = path.join(
    repoRoot,
    'agent-knowledge',
    'templates',
    'opencode',
    'knowledge.record-fix.md',
  );
  const installedOpenCodePath = path.join(
    repoRoot,
    '.opencode',
    'command',
    'knowledge.record-fix.md',
  );
  const entries = [
    { label: 'tool AGENT.md', filePath: path.join(repoRoot, 'AGENT.md'), language: 'zh' },
    { label: 'README', filePath: path.join(repoRoot, 'agent-knowledge', 'README.md'), language: 'zh' },
    { label: 'ak Chinese help', filePath: path.join(repoRoot, 'agent-knowledge', 'help', 'ak.zh-CN.txt'), language: 'zh' },
    { label: 'AGENTS adapter', filePath: path.join(repoRoot, 'agent-knowledge', 'tool-adapters', 'AGENTS.md'), language: 'zh' },
    { label: 'Claude adapter', filePath: path.join(repoRoot, 'agent-knowledge', 'tool-adapters', 'CLAUDE.md'), language: 'zh' },
    { label: 'OpenCode adapter guide', filePath: path.join(repoRoot, 'agent-knowledge', 'tool-adapters', 'opencode.md'), language: 'zh' },
    { label: 'OpenCode template', filePath: templatePath, language: 'en' },
    { label: 'installed OpenCode command', filePath: installedOpenCodePath, language: 'en' },
  ];
  const workspaceAgentsPath = path.resolve(repoRoot, '..', 'AGENTS.md');
  // The parent AGENTS.md belongs to this shared workspace and is absent in a standalone clone/CI checkout.
  // Keep every repository-owned entry mandatory, while treating only that integration file as optional.
  if (existsSync(workspaceAgentsPath)) {
    entries.unshift({ label: 'workspace AGENTS.md', filePath: workspaceAgentsPath, language: 'zh' });
  } else {
    t.diagnostic('workspace ../AGENTS.md is absent in this standalone checkout; repository entries remain mandatory');
  }

  const contracts = {
    zh: [
      ['draft or pending correction edits the original', /(?:未确认[\s\S]{0,120}(?:inbox\/|草稿)[\s\S]{0,120}(?:直接修改|修改原)|inbox\/[\s\S]{0,120}(?:draft|pending|草稿)[\s\S]{0,120}(?:直接修改|修改原))/i],
      ['targeted fixes use an explicit target', /targeted fix/i],
      ['targeted fixes use --target', /--target/i],
      ['target is edited and reviewed before resolve', /修改[\s\S]{0,500}审核[\s\S]{0,500}(?:resolve-fix|ak resolve|`resolve`)/i],
      ['targeted fixes never promote', /targeted fix[\s\S]{0,180}(?:绝不能|不能|禁止|拒绝)[\s\S]{0,100}(?:ak )?`?promote`?/i],
      ['only independent fixes promote', /独立 fix[\s\S]{0,220}(?:才能|才|可|沿用)[\s\S]{0,100}(?:ak )?`?promote`?/i],
      ['legacy confirmation is tied to a missing target hash', /(?:target_hash[\s\S]{0,350}--confirm-legacy|--confirm-legacy[\s\S]{0,350}target_hash)/i],
      ['legacy confirmation remains human-confirmed', /--confirm-legacy[\s\S]{0,300}(?:人工|确认)/i],
      ['failures and conflicts preserve artifacts', /(?:(?:失败|冲突|中断)[\s\S]{0,350}保留|保留[\s\S]{0,350}(?:失败|冲突|中断))/i],
      ['recovery retries the same source path', /(?:同一(?:个)? source 路径[\s\S]{0,100}重试|重试[\s\S]{0,100}同一(?:个)? source 路径)/i],
      ['conflicts require human review', /(?:冲突[\s\S]{0,300}人工审核|人工审核[\s\S]{0,300}冲突)/i],
      ['source survivor is documented', /source survivor/i],
      ['source snapshot is documented', /source snapshot/i],
      ['resolved audit is documented', /resolved (?:审计|audit|记录)/i],
      ['archive and work stay outside retrieval', /archive\/[\s\S]{0,220}work\/[\s\S]{0,300}(?:不参与|不进入|不会进入)[\s\S]{0,160}(?:检索|待确认)/i],
      ['hash change is not semantic proof', /哈希变化[\s\S]{0,140}(?:不等于|不证明|不能证明)[\s\S]{0,100}语义/i],
    ],
    en: [
      ['draft or pending correction edits the original', /inbox\/[\s\S]{0,120}(?:draft|pending)[\s\S]{0,160}edit[\s\S]{0,60}directly/i],
      ['targeted fixes use an explicit target', /targeted fix/i],
      ['targeted fixes use --target', /--target/i],
      ['target is edited and reviewed before resolve', /edit[\s\S]{0,400}review[\s\S]{0,300}resolve-fix/i],
      ['targeted fixes never promote', /targeted fix[^\n]*(?:never|must not)[^\n]*promote/i],
      ['only independent fixes promote', /independent fix[^\n]*(?:may|can)[^\n]*promote[^\n]*only/i],
      ['legacy confirmation is tied to a missing target hash', /--confirm-legacy[^\n]*target_hash/i],
      ['legacy confirmation remains human-confirmed', /--confirm-legacy[^\n]*only after[^\n]*(?:confirm|review)/i],
      ['failures and conflicts preserve artifacts', /(?:failure|conflict|recovery)[^\n]*preserve/i],
      ['recovery retries the same source path', /rerun the same source path/i],
      ['conflicts require human review', /conflict[^\n]*human review|human review[^\n]*conflict/i],
      ['source survivor is documented', /source survivor/i],
      ['source snapshot is documented', /source snapshot/i],
      ['resolved audit is documented', /resolved audit/i],
      ['archive and work stay outside retrieval', /archive\/[^\n]*work\/[^\n]*(?:not searchable|not part of)/i],
      ['hash change is not semantic proof', /changed target hash[^\n]*does not prove[^\n]*semantic/i],
    ],
  };

  for (const entry of entries) {
    const content = await readFile(entry.filePath, 'utf8');
    for (const [contract, pattern] of contracts[entry.language]) {
      assert.match(content, pattern, `${entry.label}: missing lifecycle contract: ${contract}`);
    }
  }

  const templateBytes = await readFile(templatePath);
  const installedBytes = await readFile(installedOpenCodePath);
  assert.equal(
    Buffer.compare(templateBytes, installedBytes),
    0,
    'installed OpenCode command must be byte-for-byte identical to its only template source',
  );
});

test('CLI sync-adapters check is read-only and sync uses repository templates only', async () => {
  const repositoryRoot = await createTempRoot();
  const knowledgeRoot = await createTempRoot();
  const targetDir = path.join(repositoryRoot, '.opencode', 'command');
  await writeAdapterTemplates(repositoryRoot);
  await writeAdapterTemplates(knowledgeRoot);
  await writeFile(
    path.join(knowledgeRoot, 'agent-knowledge', 'templates', 'opencode', 'knowledge.before-task.md'),
    'wrong knowledge-root template\n',
    'utf8',
  );

  const drift = await runCliFailure([
    'sync-adapters',
    '--check',
    '--repository-root',
    repositoryRoot,
    '--knowledge-root',
    knowledgeRoot,
  ]);
  assert.equal(drift.code, 1);
  assert.equal(existsSync(targetDir), false);

  await runCli([
    'sync-adapters',
    '--repository-root',
    repositoryRoot,
    '--knowledge-root',
    knowledgeRoot,
  ]);
  await runCli([
    'sync-adapters',
    '--check',
    '--repository-root',
    repositoryRoot,
    '--knowledge-root',
    knowledgeRoot,
  ]);

  for (const fileName of adapterFileNames) {
    const templatePath = path.join(repositoryRoot, 'agent-knowledge', 'templates', 'opencode', fileName);
    const targetPath = path.join(targetDir, fileName);
    assert.equal(await readFile(targetPath, 'utf8'), await readFile(templatePath, 'utf8'));
  }
});

test('CLI sync-adapters rejects an unknown argument without writing targets', async () => {
  const repositoryRoot = await createTempRoot();
  await writeAdapterTemplates(repositoryRoot);
  await writeAdapterTargets(repositoryRoot);
  const before = await snapshotAdapterTargets(repositoryRoot);

  const error = await runCliFailure([
    'sync-adapters',
    '--chek',
    '--repository-root',
    repositoryRoot,
  ]);

  assert.equal(error.code, 1);
  assert.match(`${error.stderr}${error.stdout}`, /sync-adapters.*--check/);
  assert.deepEqual(await snapshotAdapterTargets(repositoryRoot), before);
});

test('CLI sync-adapters rejects --repository-root when it would consume --check', async () => {
  const repositoryRoot = await createTempRoot();
  await writeAdapterTemplates(repositoryRoot);
  await writeAdapterTargets(repositoryRoot);
  const before = await snapshotAdapterTargets(repositoryRoot);

  const error = await runCliFailure([
    'sync-adapters',
    '--repository-root',
    '--check',
  ], { cwd: repositoryRoot });

  assert.equal(error.code, 1);
  assert.match(`${error.stderr}${error.stdout}`, /--repository-root.*(路径|path|值)/i);
  assert.deepEqual(await snapshotAdapterTargets(repositoryRoot), before);
});

test('ak.ps1 adapters --check forwards check mode without writing targets', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const targetPaths = adapterFileNames.map((fileName) => path.join(repoRoot, '.opencode', 'command', fileName));
  const before = await Promise.all(targetPaths.map(async (filePath) => ({
    content: await readFile(filePath, 'utf8'),
    mtimeMs: (await stat(filePath)).mtimeMs,
  })));

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'adapters',
    '--check',
  ], { encoding: 'utf8' });

  assert.match(stdout, /check|drift|同步|漂移/i);
  const after = await Promise.all(targetPaths.map(async (filePath) => ({
    content: await readFile(filePath, 'utf8'),
    mtimeMs: (await stat(filePath)).mtimeMs,
  })));
  assert.deepEqual(after, before);
});

test('ak.ps1 adapters passes the explicit tool repository root from any cwd', {
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
    'adapters',
    '--check',
  ], {
    cwd: arbitraryCwd,
    encoding: 'utf8',
    env,
  });

  assert.match(stdout, /sync-adapters/);
  assert.match(stdout, /--check/);
  assert.ok(stdout.includes(`--repository-root ${repoRoot}`), stdout);
});

test('ak.ps1 adapters rejects an unknown argument without invoking node', {
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
      'adapters',
      '--chek',
    ], {
      cwd: arbitraryCwd,
      encoding: 'utf8',
      env,
    }) };
  } catch (error) {
    result = error;
  }

  assert.notEqual(result.code, 0);
  assert.match(`${result.stderr}${result.stdout}`, /adapters.*--check/i);
  assert.equal(existsSync(markerPath), false);
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

test('ak.ps1 resolve forwards exactly one file and optional legacy confirmation', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const fakeBin = await createTempRoot();
  const arbitraryCwd = await createTempRoot();
  const knowledgeRoot = path.join(arbitraryCwd, 'knowledge root');
  const source = 'inbox/tech-solution-corrections/fix with spaces.md';
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    AGENT_KNOWLEDGE_ROOT: knowledgeRoot,
    [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
  };
  await writeFile(path.join(fakeBin, 'node.cmd'), '@echo off\r\necho %*\r\n', 'utf8');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'resolve',
    source,
    '--confirm-legacy',
  ], {
    cwd: arbitraryCwd,
    encoding: 'utf8',
    env,
  });

  assert.match(stdout, /resolve-fix/);
  assert.match(stdout, /--file/);
  assert.ok(stdout.includes(source), stdout);
  assert.equal((stdout.match(/--confirm-legacy/g) ?? []).length, 1);
  assert.ok(stdout.includes(knowledgeRoot), stdout);

  const withoutLegacy = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'resolve',
    source,
  ], {
    cwd: arbitraryCwd,
    encoding: 'utf8',
    env,
  });
  assert.equal((withoutLegacy.stdout.match(/--confirm-legacy/g) ?? []).length, 0);
});

test('ak.ps1 resolve rejects missing, empty, duplicate, and unknown arguments before invoking node', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const fakeBin = await createTempRoot();
  const arbitraryCwd = await createTempRoot();
  const knowledgeRoot = path.join(arbitraryCwd, 'knowledge-root');
  const markerPath = path.join(fakeBin, 'node-called.txt');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    AK_NODE_MARKER: markerPath,
    AGENT_KNOWLEDGE_ROOT: knowledgeRoot,
    [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
  };
  await writeFile(
    path.join(fakeBin, 'node.cmd'),
    '@echo off\r\ntype nul > "%AK_NODE_MARKER%"\r\nexit /b 0\r\n',
    'utf8',
  );
  const invalidArguments = [
    [],
    [''],
    ['--confirm-legacy'],
    ['inbox/fixes/one.md', 'inbox/fixes/two.md'],
    ['inbox/fixes/one.md', '--confirm-legacy', '--confirm-legacy'],
    ['inbox/fixes/one.md', '--unknown'],
    ['--confirm-legacy', 'inbox/fixes/one.md'],
  ];

  for (const rest of invalidArguments) {
    let result;
    try {
      result = { code: 0, ...await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        'resolve',
        ...rest,
      ], {
        cwd: arbitraryCwd,
        encoding: 'utf8',
        env,
      }) };
    } catch (error) {
      result = error;
    }

    assert.notEqual(result.code, 0, `expected rejection for: ${rest.join(' ')}`);
    const output = `${result.stderr}${result.stdout}`;
    assert.match(output, /ak resolve/i);
    assert.doesNotMatch(output, /Unknown ak command/i);
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'archive')), false);
  }
});

test('extractKeywords extracts mixed Chinese, symbol, and Java identifier keywords', () => {
  const keywords = extractKeywords('修复 queryEntityGraph 实体图谱 ownerId 为空的问题，涉及 EntityGraphService.java');

  for (const expected of [
    'queryEntityGraph',
    '实体图谱',
    'ownerId',
    'EntityGraphService',
    'Entity',
    'Graph',
    'Service',
  ]) {
    assert.ok(keywords.includes(expected), `missing keyword: ${expected}`);
  }
});

test('extractKeywords keeps first occurrence order across Chinese and identifiers', () => {
  assert.deepEqual(extractKeywords('foo 中文 bar fooBaz'), [
    'foo',
    '中文',
    'bar',
    'fooBaz',
    'Baz',
  ]);
});

test('searchKnowledge ranks tag frontmatter matches before body matches and excludes unrelated files', async () => {
  const rootDir = await createTempRoot();

  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/tag-hit.md',
    [
      '---',
      'title: 聚合数据源规则',
      'tags: [aggregation, datasource]',
      'status: confirmed',
      '---',
      '',
      '这里没有正文关键词。',
      '',
    ].join('\n'),
  );
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/body-hit.md',
    [
      '---',
      'title: 正文命中规则',
      'tags: [owner]',
      'status: confirmed',
      '---',
      '',
      'aggregation datasource 出现在正文中。',
      '',
    ].join('\n'),
  );
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/unrelated.md',
    [
      '---',
      'title: 无关规则',
      'tags: [owner]',
      'status: confirmed',
      '---',
      '',
      '这个文件不包含搜索词。',
      '',
    ].join('\n'),
  );

  const results = await searchKnowledge({ rootDir, query: 'aggregation datasource' });
  const resultNames = results.map((result) => path.basename(resultPath(result)));

  assert.deepEqual(resultNames, ['tag-hit.md', 'body-hit.md']);
});

test('CLI search resolves repository root from script path when cwd is outside repository', async () => {
  const cwd = await createTempRoot();

  const { stdout } = await runCli(['search', 'aggregation datasource'], { cwd });

  const expectedPath = 'agent-knowledge/knowledge/rules/aggregation-data-source-consistency.md';
  assert.match(stdout, new RegExp(expectedPath.replaceAll('/', '\\/')));
  await readFile(path.join(repoRoot, ...expectedPath.split('/')), 'utf8');
  assert.doesNotMatch(stdout, /命中文件：\r?\n- 无/);
});

test('searchKnowledge reads a separated private knowledge repository root', async () => {
  const knowledgeRoot = await createTempRoot();
  const filePath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/service-map/workspace-projects.md',
    [
      '---',
      'title: 本地工作区项目索引',
      'tags: [workspace, projects]',
      'status: confirmed',
      '---',
      '',
      '# 本地工作区项目索引',
      '',
      'workspace projects ownership map',
      '',
    ].join('\n'),
  );

  const results = await searchKnowledge({ knowledgeRoot, query: 'workspace ownership' });

  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, 'knowledge/service-map/workspace-projects.md');
  assert.equal(results[0].filePath, filePath);
});

test('searchKnowledge keeps explicit rootDir isolated from AGENT_KNOWLEDGE_ROOT', async () => {
  const rootDir = await createTempRoot();
  const envKnowledgeRoot = await createTempRoot();
  const originalEnv = process.env.AGENT_KNOWLEDGE_ROOT;

  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/root-dir-hit.md',
    [
      '---',
      'title: root-dir 命中',
      'tags: [root-dir-hit]',
      'status: confirmed',
      '---',
      '',
      'root-dir-only',
      '',
    ].join('\n'),
  );
  await writeExternalKnowledgeFile(
    envKnowledgeRoot,
    'knowledge/rules/env-hit.md',
    [
      '---',
      'title: env 命中',
      'tags: [env-hit]',
      'status: confirmed',
      '---',
      '',
      'env-only',
      '',
    ].join('\n'),
  );

  try {
    process.env.AGENT_KNOWLEDGE_ROOT = envKnowledgeRoot;
    const results = await searchKnowledge({ rootDir, query: 'root-dir-only env-only' });
    const resultNames = results.map((result) => path.basename(resultPath(result)));

    assert.deepEqual(resultNames, ['root-dir-hit.md']);
  } finally {
    if (originalEnv === undefined) {
      delete process.env.AGENT_KNOWLEDGE_ROOT;
    } else {
      process.env.AGENT_KNOWLEDGE_ROOT = originalEnv;
    }
  }
});

test('CLI search supports --knowledge-root for separated private knowledge repositories', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-graph-service.md',
    [
      '---',
      'title: graph-service 项目说明',
      'tags: [graph-service]',
      'status: confirmed',
      '---',
      '',
      '# graph-service 项目说明',
      '',
      'graph-service handles entity graph ownership.',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli([
    'search',
    'graph-service ownership',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(stdout, /knowledge\/domain\/project-graph-service\.md/);
  assert.doesNotMatch(stdout, /agent-knowledge\/knowledge\/rules\/aggregation-data-source-consistency\.md/);
});

test('CLI search supports AGENT_KNOWLEDGE_ROOT for separated private knowledge repositories', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-catalog-service.md',
    [
      '---',
      'title: catalog-service 项目说明',
      'tags: [catalog-service]',
      'status: confirmed',
      '---',
      '',
      '# catalog-service 项目说明',
      '',
      'catalog-service owns catalog status rules.',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli(['search', 'catalog-service status'], {
    env: {
      ...process.env,
      AGENT_KNOWLEDGE_ROOT: knowledgeRoot,
    },
  });

  assert.match(stdout, /knowledge\/domain\/project-catalog-service\.md/);
  assert.doesNotMatch(stdout, /agent-knowledge\/knowledge\/rules\/aggregation-data-source-consistency\.md/);
});

test('CLI check-stale reports knowledge file when scanned commit differs from project HEAD', async () => {
  const projectRoot = await createGitProject();
  const oldCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), '# demo\n\nchanged\n', 'utf8');
  await runGit(['add', 'README.md'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '更新',
  ], projectRoot);
  const currentCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-demo.md',
    [
      '---',
      'title: demo 项目说明',
      'status: confirmed',
      `project_root: ${projectRoot}`,
      `last_scanned_commit: ${oldCommit}`,
      '---',
      '',
      '# demo 项目说明',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli([
    'check-stale',
    '--project-root',
    projectRoot,
    '--knowledge-file',
    'knowledge/domain/project-demo.md',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(stdout, /可能过期/);
  assert.match(stdout, /knowledge\/domain\/project-demo\.md/);
  assert.match(stdout, new RegExp(oldCommit.slice(0, 12)));
  assert.match(stdout, new RegExp(currentCommit.slice(0, 12)));
});

test('CLI refresh-project updates project metadata and appends a refresh record without replacing body', async () => {
  const projectRoot = await createGitProject();
  const oldCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), '# demo\n\nchanged\n', 'utf8');
  await runGit(['add', 'README.md'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '更新',
  ], projectRoot);
  const currentCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-demo.md',
    [
      '---',
      'title: demo 项目说明',
      'status: confirmed',
      `project_root: ${projectRoot}`,
      `last_scanned_commit: ${oldCommit}`,
      'updated: 2026-01-01',
      '---',
      '',
      '# demo 项目说明',
      '',
      '人工沉淀的业务规则必须保留。',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli([
    'refresh-project',
    '--project-root',
    projectRoot,
    '--knowledge-file',
    'knowledge/domain/project-demo.md',
    '--summary',
    '同步 README 变化',
    '--knowledge-root',
    knowledgeRoot,
  ]);
  const content = await readFile(knowledgeFile, 'utf8');

  assert.match(stdout, /已刷新/);
  assert.match(stdout, /knowledge\/domain\/project-demo\.md/);
  assert.match(content, new RegExp(`last_scanned_commit: ${currentCommit}`));
  assert.match(content, new RegExp(`project_root: ${projectRoot.replaceAll('\\', '\\\\')}`));
  assert.match(content, /^updated: \d{4}-\d{2}-\d{2}$/m);
  assert.match(content, /人工沉淀的业务规则必须保留。/);
  assert.match(content, /## 刷新记录/);
  assert.match(content, new RegExp(currentCommit.slice(0, 12)));
  assert.match(content, /同步 README 变化/);
  await assertNoBom(knowledgeFile);
});

test('knowledge path boundary rejects check-stale outside the configured knowledge root', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const externalRoot = await createTempRoot();
  const externalFile = await writeExternalKnowledgeFile(
    externalRoot,
    'knowledge/domain/external.md',
    ['---', 'title: external', 'status: confirmed', '---', '', '# external', ''].join('\n'),
  );

  await assert.rejects(
    checkStale({ knowledgeRoot, projectRoot, knowledgeFile: externalFile }),
    /check-stale.*当前知识库|知识库.*越界/,
  );
});

test('knowledge path boundary rejects refresh-project outside the configured knowledge root without modifying it', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const externalRoot = await createTempRoot();
  const externalFile = await writeExternalKnowledgeFile(
    externalRoot,
    'knowledge/domain/external-refresh.md',
    ['---', 'title: external refresh', 'status: confirmed', '---', '', '# external refresh', ''].join('\n'),
  );
  const before = await readFile(externalFile, 'utf8');

  await assert.rejects(
    refreshProject({ knowledgeRoot, projectRoot, knowledgeFile: externalFile }),
    /refresh-project.*当前知识库|知识库.*越界/,
  );
  assert.equal(await readFile(externalFile, 'utf8'), before);
  assert.ok(!existsSync(`${externalFile}.lock`));
});

test('knowledge path boundary requires confirmed knowledge files for check and refresh', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const draft = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/domain/project-draft.md',
    ['---', 'title: draft', 'status: draft', '---', '', '# draft', ''].join('\n'),
  );
  const pendingKnowledge = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-pending.md',
    ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
  );
  const pendingBefore = await readFile(pendingKnowledge, 'utf8');

  await assert.rejects(
    checkStale({ knowledgeRoot, projectRoot, knowledgeFile: draft }),
    /check-stale.*knowledge\//,
  );
  await assert.rejects(
    refreshProject({ knowledgeRoot, projectRoot, knowledgeFile: pendingKnowledge }),
    /refresh-project.*confirmed/,
  );
  assert.equal(await readFile(pendingKnowledge, 'utf8'), pendingBefore);
});

test('knowledge path boundary rejects a knowledge directory link escaping the real root', async (t) => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const externalDir = await createTempRoot();
  await writeFile(
    path.join(externalDir, 'escaped.md'),
    ['---', 'title: escaped', 'status: confirmed', '---', '', '# escaped', ''].join('\n'),
    'utf8',
  );
  await mkdir(path.join(knowledgeRoot, 'knowledge'), { recursive: true });
  if (!await createDirectoryLink(t, externalDir, path.join(knowledgeRoot, 'knowledge', 'domain'))) {
    return;
  }

  await assert.rejects(
    checkStale({
      knowledgeRoot,
      projectRoot,
      knowledgeFile: 'knowledge/domain/escaped.md',
    }),
    /check-stale.*真实路径|知识库.*越界/,
  );
});

test('knowledge path boundary locks an internal directory-link alias by the real knowledge file', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const domainRoot = path.join(knowledgeRoot, 'knowledge', 'domain');
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/internal-lock.md',
    '---\ntitle: Internal lock\nstatus: confirmed\n---\n\n# Internal lock\n',
  );
  const linkedDomainRoot = path.join(knowledgeRoot, 'knowledge', 'linked-domain');
  if (!await createDirectoryLink(t, domainRoot, linkedDomainRoot)) {
    return;
  }
  const before = await readFile(knowledgeFile, 'utf8');
  await writeFile(
    `${knowledgeFile}.lock`,
    `${process.pid}:00000000-0000-4000-8000-000000000001`,
    'utf8',
  );

  await assert.rejects(
    refreshProject({
      knowledgeRoot,
      projectRoot: await createTempRoot(),
      knowledgeFile: 'knowledge/linked-domain/internal-lock.md',
      summary: 'must not bypass the canonical lock',
      lockTimeoutMs: 80,
      lockRetryDelayMs: 10,
    }),
    /等待文件锁超时/,
  );
  assert.equal(await readFile(knowledgeFile, 'utf8'), before);
  assert.equal(
    await readFile(path.join(linkedDomainRoot, 'internal-lock.md.lock'), 'utf8'),
    `${process.pid}:00000000-0000-4000-8000-000000000001`,
  );
});

test('knowledge path boundary rejects promote through an inbox directory link without touching external source', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const externalDir = await createTempRoot();
  const externalSource = path.join(externalDir, 'external-draft.md');
  const sourceContent = ['---', 'title: external draft', 'status: draft', '---', '', '# external draft', ''].join('\n');
  await writeFile(externalSource, sourceContent, 'utf8');
  await mkdir(path.join(knowledgeRoot, 'inbox'), { recursive: true });
  if (!await createDirectoryLink(t, externalDir, path.join(knowledgeRoot, 'inbox', 'rules'))) {
    return;
  }

  await assert.rejects(
    promote({ knowledgeRoot, file: 'inbox/rules/external-draft.md' }),
    /promote.*真实路径|知识库.*越界/,
  );
  assert.equal(await readFile(externalSource, 'utf8'), sourceContent);
  assert.ok(!existsSync(path.join(knowledgeRoot, 'knowledge')));
});

test('knowledge path boundary rejects an external promote target before creating directories there', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const externalTargetRoot = await createTempRoot();
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/safe-source.md',
    ['---', 'title: safe source', 'status: draft', '---', '', '# safe source', ''].join('\n'),
  );
  if (!await createDirectoryLink(t, externalTargetRoot, path.join(knowledgeRoot, 'knowledge'))) {
    return;
  }

  await assert.rejects(
    promote({ knowledgeRoot, file: 'inbox/rules/safe-source.md' }),
    /promote.*目录链接|promote.*真实路径/,
  );
  assert.ok(existsSync(source));
  assert.ok(!existsSync(path.join(externalTargetRoot, 'rules')));
});

test('knowledge path boundary rejects a promoted file symlink', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const actualSource = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/actual-draft.md',
    ['---', 'title: actual draft', 'status: draft', '---', '', '# actual draft', ''].join('\n'),
  );
  const linkedSource = path.join(knowledgeRoot, 'inbox', 'rules', 'linked-draft.md');
  try {
    await symlink(actualSource, linkedSource, 'file');
  } catch (error) {
    if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      t.skip(`file links are unavailable on this platform: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(
    promote({ knowledgeRoot, file: 'inbox/rules/linked-draft.md' }),
    /promote.*符号链接/,
  );
  assert.ok(existsSync(actualSource));
  assert.ok(existsSync(linkedSource));
  assert.ok(!existsSync(path.join(knowledgeRoot, 'knowledge')));
});

test('recordFix writes a complete fix_id without target fields for a standalone fix', async () => {
  const knowledgeRoot = await createTempRoot();

  const result = await recordFix({
    knowledgeRoot,
    type: 'bug',
    title: 'standalone readable fix',
  });

  const fixDir = path.join(knowledgeRoot, 'inbox', 'fixes');
  const { filePath, content } = await readOnlyMarkdownFile(fixDir);
  const fixIdPattern = /^fix_id: ([0-9a-f-]+)$/m;

  assert.match(content, fixIdPattern);
  const fixId = content.match(fixIdPattern)[1];
  assert.match(fixId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(filePath, result.path);
  assert.match(path.basename(filePath), new RegExp(`^\\d{8}-${fixId.replaceAll('-', '').slice(0, 12)}-standalone-readable-fix\\.md$`));
  assert.match(content, /standalone readable fix/);
  assert.match(content, /证据链/);
  assert.doesNotMatch(content, /^target(?:_hash)?:/m);
  await assertNoBom(filePath);
});

test('recordFix fix_id removes stale target fields from a standalone custom template', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'templates/fix-record.md',
    [
      '---',
      'title:',
      'type: bug',
      'status: pending',
      'updated:',
      'target: knowledge/rules/stale.md',
      `target_hash: ${'a'.repeat(64)}`,
      '---',
      '',
      '# {{title}}',
      '',
    ].join('\n'),
  );

  const result = await recordFix({ knowledgeRoot, type: 'bug', title: 'standalone-custom-template' });
  const content = await readFile(result.path, 'utf8');

  assert.match(content, /^fix_id: [0-9a-f-]{36}$/m);
  assert.doesNotMatch(content, /^target(?:_hash)?:/m);
});

test('recordFix fix_id prefixes Chinese and untitled filenames without collisions', async () => {
  const knowledgeRoot = await createTempRoot();
  const results = await Promise.all([
    recordFix({ knowledgeRoot, type: 'bug', title: '中文纠偏' }),
    recordFix({ knowledgeRoot, type: 'bug', title: '中文纠偏' }),
    recordFix({ knowledgeRoot, type: 'bug' }),
  ]);

  const identities = [];
  for (const result of results) {
    const content = await readFile(result.path, 'utf8');
    const fixIdPattern = /^fix_id: ([0-9a-f-]+)$/m;
    assert.match(content, fixIdPattern);
    const fixId = content.match(fixIdPattern)[1];
    assert.match(fixId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(path.basename(result.path), new RegExp(`^\\d{8}-${fixId.replaceAll('-', '').slice(0, 12)}\\.md$`));
    identities.push(fixId);
  }

  assert.equal(new Set(identities).size, results.length);
  assert.equal(new Set(results.map((result) => result.path)).size, results.length);
});

test('addRule keeps sequential and concurrent writes with the same title', async () => {
  const knowledgeRoot = await createTempRoot();
  const first = await addRule({ knowledgeRoot, title: 'same-rule' });
  const concurrent = await Promise.all([
    addRule({ knowledgeRoot, title: 'same-rule' }),
    addRule({ knowledgeRoot, title: 'same-rule' }),
  ]);

  const names = [first, ...concurrent]
    .map((result) => path.basename(result.path))
    .sort();
  const datePrefix = names[0].slice(0, 8);

  assert.deepEqual(names, [
    `${datePrefix}-same-rule-2.md`,
    `${datePrefix}-same-rule-3.md`,
    `${datePrefix}-same-rule.md`,
  ]);
});

test('recordFix fix_id keeps sequential and concurrent English titles readable and unique', async () => {
  const knowledgeRoot = await createTempRoot();
  const first = await recordFix({ knowledgeRoot, type: 'bug', title: 'same-fix' });
  const concurrent = await Promise.all([
    recordFix({ knowledgeRoot, type: 'bug', title: 'same-fix' }),
    recordFix({ knowledgeRoot, type: 'bug', title: 'same-fix' }),
  ]);

  const results = [first, ...concurrent];
  for (const result of results) {
    const content = await readFile(result.path, 'utf8');
    const fixIdPattern = /^fix_id: ([0-9a-f-]+)$/m;
    assert.match(content, fixIdPattern);
    const fixId = content.match(fixIdPattern)[1];
    assert.match(path.basename(result.path), new RegExp(`^\\d{8}-${fixId.replaceAll('-', '').slice(0, 12)}-same-fix\\.md$`));
  }

  assert.equal(new Set(results.map((result) => result.path)).size, results.length);
});

test('writeFileAtomic keeps the old file and removes its temp file when rename fails', async () => {
  const rootDir = await createTempRoot();
  const filePath = path.join(rootDir, 'atomic.md');
  const renameError = new Error('rename failed');
  await writeFile(filePath, 'old content', 'utf8');

  assert.equal(typeof agentKnowledgeModule.writeFileAtomic, 'function');
  await assert.rejects(
    agentKnowledgeModule.writeFileAtomic(filePath, 'new content', {
      renameFile: async () => {
        throw renameError;
      },
    }),
    (error) => error === renameError,
  );

  assert.equal(await readFile(filePath, 'utf8'), 'old content');
  assert.deepEqual(await readdir(rootDir), ['atomic.md']);
});

test('refreshProject serializes concurrent updates and preserves both refresh records', async () => {
  const projectRoot = await createGitProject();
  const currentCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/concurrent-refresh.md',
    [
      '---',
      'title: concurrent refresh',
      'status: confirmed',
      `project_root: ${projectRoot}`,
      `last_scanned_commit: ${currentCommit}`,
      '---',
      '',
      '# concurrent refresh',
      '',
    ].join('\n'),
  );

  await Promise.all([
    refreshProject({
      knowledgeRoot,
      projectRoot,
      knowledgeFile: 'knowledge/domain/concurrent-refresh.md',
      summary: '并发刷新一',
    }),
    refreshProject({
      knowledgeRoot,
      projectRoot,
      knowledgeFile: 'knowledge/domain/concurrent-refresh.md',
      summary: '并发刷新二',
    }),
  ]);

  const content = await readFile(knowledgeFile, 'utf8');
  assert.match(content, /并发刷新一/);
  assert.match(content, /并发刷新二/);
  assert.ok(!existsSync(`${knowledgeFile}.lock`));
});

test('refreshProject times out without removing a lock owned by a live process', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/live-lock.md',
    ['---', 'title: live lock', 'status: confirmed', '---', '', '# live lock', ''].join('\n'),
  );
  const lockPath = `${knowledgeFile}.lock`;
  const liveLock = `${process.pid}:88888888-8888-4888-8888-888888888888\n`;
  await writeFile(lockPath, liveLock, 'utf8');

  await assert.rejects(
    refreshProject({
      knowledgeRoot,
      projectRoot,
      knowledgeFile: 'knowledge/domain/live-lock.md',
      summary: '不应写入',
      lockTimeoutMs: 30,
      lockRetryDelayMs: 5,
    }),
    /等待文件锁超时/,
  );

  assert.equal(await readFile(lockPath, 'utf8'), liveLock);
  assert.doesNotMatch(await readFile(knowledgeFile, 'utf8'), /不应写入/);
});

test('refreshProject removes a leftover lock only after its owner process exits', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/stale-lock.md',
    ['---', 'title: stale lock', 'status: confirmed', '---', '', '# stale lock', ''].join('\n'),
  );
  const child = execFile(process.execPath, ['-e', '']);
  const stalePid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  await writeFile(
    `${knowledgeFile}.lock`,
    `${stalePid}:99999999-9999-4999-8999-999999999999\n`,
    'utf8',
  );

  await refreshProject({
    knowledgeRoot,
    projectRoot,
    knowledgeFile: 'knowledge/domain/stale-lock.md',
    summary: '清理遗留锁后刷新',
    lockTimeoutMs: 200,
    lockRetryDelayMs: 5,
  });

  assert.match(await readFile(knowledgeFile, 'utf8'), /清理遗留锁后刷新/);
  assert.ok(!existsSync(`${knowledgeFile}.lock`));
});

test('refreshProject keeps an invalid dead-PID main lock unchanged and times out', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/invalid-dead-lock.md',
    ['---', 'title: invalid dead lock', 'status: confirmed', '---', '', '# invalid dead lock', ''].join('\n'),
  );
  const exitedPid = await createExitedProcessPid();
  const lockPath = `${knowledgeFile}.lock`;
  const invalidLock = `${exitedPid}:not-an-rfc4122-uuid\n`;
  await writeFile(lockPath, invalidLock, 'utf8');

  await assert.rejects(
    refreshProject({
      knowledgeRoot,
      projectRoot,
      knowledgeFile: 'knowledge/domain/invalid-dead-lock.md',
      summary: '非法锁不得被回收',
      lockTimeoutMs: 30,
      lockRetryDelayMs: 5,
    }),
    (error) => error?.code === 'LOCK_TIMEOUT',
  );

  assert.equal(await readFile(lockPath, 'utf8'), invalidLock);
  assert.equal(existsSync(`${lockPath}.reclaim`), false);
  assert.doesNotMatch(await readFile(knowledgeFile, 'utf8'), /非法锁不得被回收/);
});

test('refreshProject does not reclaim a dead lock while the reclaim guard is held', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/guarded-stale-lock.md',
    ['---', 'title: guarded stale lock', 'status: confirmed', '---', '', '# guarded stale lock', ''].join('\n'),
  );
  const child = execFile(process.execPath, ['-e', '']);
  const stalePid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  const lockPath = `${knowledgeFile}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const staleLock = `${stalePid}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\n`;
  const liveReclaimGuard = `${process.pid}:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb\n`;
  await writeFile(lockPath, staleLock, 'utf8');
  await writeFile(reclaimPath, liveReclaimGuard, 'utf8');

  await assert.rejects(
    refreshProject({
      knowledgeRoot,
      projectRoot,
      knowledgeFile: 'knowledge/domain/guarded-stale-lock.md',
      summary: '不应越过回收保护锁',
      lockTimeoutMs: 30,
      lockRetryDelayMs: 5,
    }),
    /等待文件锁超时/,
  );

  assert.equal(await readFile(lockPath, 'utf8'), staleLock);
  assert.equal(await readFile(reclaimPath, 'utf8'), liveReclaimGuard);
  assert.doesNotMatch(await readFile(knowledgeFile, 'utf8'), /不应越过回收保护锁/);
});

test('reclaim guard diagnosis keeps an orphan guard unchanged while three processes time out', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const repositoryRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/orphan-reclaim-guard.md',
    ['---', 'title: orphan reclaim guard', 'status: confirmed', '---', '', '# orphan reclaim guard', ''].join('\n'),
  );
  const exitedPid = await createExitedProcessPid();
  const lockPath = `${knowledgeFile}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const orphanGuard = `${exitedPid}:44444444-4444-4444-8444-444444444444\n`;
  await writeFile(reclaimPath, orphanGuard, 'utf8');
  const guardBefore = await stat(reclaimPath);
  const childScript = [
    "import { pathToFileURL } from 'node:url';",
    'const [knowledgeRoot, projectRoot] = process.argv.slice(1);',
    'const { refreshProject } = await import(pathToFileURL(process.env.AGENT_KNOWLEDGE_MODULE).href);',
    'try {',
    '  await refreshProject({',
    '    knowledgeRoot,',
    '    projectRoot,',
    "    knowledgeFile: 'knowledge/domain/orphan-reclaim-guard.md',",
    "    summary: '并发进程不得写入',",
    '    lockTimeoutMs: 80,',
    '    lockRetryDelayMs: 5,',
    '  });',
    "  throw new Error('expected LOCK_TIMEOUT');",
    '} catch (error) {',
    "  if (error?.code !== 'LOCK_TIMEOUT') throw error;",
    "  process.stdout.write('LOCK_TIMEOUT\\n');",
    '}',
  ].join('\n');

  const attempts = await Promise.all(Array.from({ length: 3 }, () => execFileAsync(
    process.execPath,
    ['--input-type=module', '-e', childScript, knowledgeRoot, projectRoot],
    {
      encoding: 'utf8',
      env: { ...process.env, AGENT_KNOWLEDGE_MODULE: cliPath },
    },
  )));
  const guardAfter = await stat(reclaimPath);
  const result = await agentKnowledgeModule.doctor({ knowledgeRoot, repositoryRoot });
  const orphanIssues = result.issues.filter((issue) => issue.code === 'orphan_lock');

  assert.deepEqual(attempts.map(({ stdout, stderr }) => ({ stdout, stderr })), [
    { stdout: 'LOCK_TIMEOUT\n', stderr: '' },
    { stdout: 'LOCK_TIMEOUT\n', stderr: '' },
    { stdout: 'LOCK_TIMEOUT\n', stderr: '' },
  ]);
  assert.equal(await readFile(reclaimPath, 'utf8'), orphanGuard);
  assert.equal(guardAfter.size, guardBefore.size);
  assert.equal(guardAfter.mtimeMs, guardBefore.mtimeMs);
  assert.equal(existsSync(lockPath), false);
  assert.doesNotMatch(await readFile(knowledgeFile, 'utf8'), /并发进程不得写入/);
  assert.deepEqual(orphanIssues.map(({ severity, file }) => ({ severity, file })), [{
    severity: 'warning',
    file: 'knowledge/domain/orphan-reclaim-guard.md.lock.reclaim',
  }]);
  assert.match(orphanIssues[0].message, new RegExp(`PID ${exitedPid}`));
});

test('recordFix rejects a correction targeting an unconfirmed inbox draft', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/draft-rule.md',
    [
      '---',
      'title: 待确认规则',
      'status: draft',
      '---',
      '',
      '# 待确认规则',
      '',
    ].join('\n'),
  );

  await assert.rejects(
    recordFix({
      knowledgeRoot,
      type: 'tech',
      title: '不应重复创建的纠偏',
      target: 'inbox/rules/draft-rule.md',
    }),
    /未确认草稿.*直接修改原草稿/,
  );

  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections')));
});

test('recordFix target_hash links a correction to the exact confirmed knowledge bytes', async () => {
  const knowledgeRoot = await createTempRoot();
  const targetContent = [
    '---',
    'title: 正式规则',
    'status: confirmed',
    '---',
    '',
    '# 正式规则',
    '',
    '哈希必须覆盖这些 UTF-8 原始字节。',
    '',
  ].join('\n');
  const targetPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/confirmed-rule.md',
    targetContent,
  );

  await recordFix({
    knowledgeRoot,
    type: 'tech',
    title: '正式规则纠偏',
    target: path.join(targetPath, '..', 'confirmed-rule.md'),
  });

  const correctionDir = path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections');
  const { content } = await readOnlyMarkdownFile(correctionDir);
  assert.match(content, /^target: knowledge\/rules\/confirmed-rule\.md$/m);
  assert.match(
    content,
    new RegExp(`^target_hash: ${createHash('sha256').update(Buffer.from(targetContent, 'utf8')).digest('hex')}$`, 'm'),
  );
});

test('recordFix target realpath rejects a knowledge junction escaping the current repository', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    outsideRoot,
    'confirmed.md',
    ['---', 'title: 外部规则', 'status: confirmed', '---', '', '# 外部规则', ''].join('\n'),
  );
  const linkPath = path.join(knowledgeRoot, 'knowledge', 'escaped');
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (!await createDirectoryLink(t, outsideRoot, linkPath)) {
    return;
  }

  await assert.rejects(
    recordFix({
      knowledgeRoot,
      type: 'tech',
      title: '不应链接外部规则',
      target: 'knowledge/escaped/confirmed.md',
    }),
    /当前知识库/,
  );
  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections')));
});

test('recordFix target realpath accepts an in-repository knowledge junction', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const rulesDir = path.join(knowledgeRoot, 'knowledge', 'rules');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/confirmed.md',
    ['---', 'title: 内部规则', 'status: confirmed', '---', '', '# 内部规则', ''].join('\n'),
  );
  const linkPath = path.join(knowledgeRoot, 'knowledge', 'alias');
  if (!await createDirectoryLink(t, rulesDir, linkPath)) {
    return;
  }

  await recordFix({
    knowledgeRoot,
    type: 'tech',
    title: '允许内部真实路径',
    target: 'knowledge/alias/confirmed.md',
  });

  const correctionDir = path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections');
  const { content } = await readOnlyMarkdownFile(correctionDir);
  assert.match(content, /^target: knowledge\/alias\/confirmed\.md$/m);
});

test('recordFix target realpath rejects missing, non-Markdown, and non-confirmed targets', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(knowledgeRoot, 'knowledge/rules/not-markdown.txt', 'not markdown\n');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/pending.md',
    ['---', 'title: 未确认规则', 'status: pending', '---', '', '# 未确认规则', ''].join('\n'),
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/confirmed.md',
    ['---', 'title: 错位正式规则', 'status: confirmed', '---', '', '# 错位正式规则', ''].join('\n'),
  );

  await assert.rejects(
    recordFix({ knowledgeRoot, type: 'bug', target: 'knowledge/rules/missing.md' }),
    /不存在或不是 Markdown/,
  );
  await assert.rejects(
    recordFix({ knowledgeRoot, type: 'bug', target: 'knowledge/rules/not-markdown.txt' }),
    /不存在或不是 Markdown/,
  );
  await assert.rejects(
    recordFix({ knowledgeRoot, type: 'bug', target: 'knowledge/rules/pending.md' }),
    /confirmed/,
  );
  await assert.rejects(
    recordFix({ knowledgeRoot, type: 'bug', target: 'inbox/rules/confirmed.md' }),
    /knowledge\//,
  );
});

test('CLI resolve-fix publishes a fix and clearly reports source, snapshot, and resolved paths', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'CLI resolve lifecycle' });
  await changeResolvableTarget(fix, 'CLI merged target body');

  const { stdout, stderr } = await runCli([
    'resolve-fix',
    '--file',
    fix.sourceRelative,
    '--knowledge-root',
    knowledgeRoot,
  ]);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  assert.equal(stderr, '');
  assert.match(stdout, /source/i);
  assert.ok(stdout.includes(fix.sourceRelative), stdout);
  assert.match(stdout, /snapshot/i);
  assert.match(stdout, /resolved/i);
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
});

test('CLI resolve-fix forwards explicit legacy confirmation', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/cli-legacy.md',
  );

  const { stdout, stderr } = await runCli([
    'resolve-fix',
    '--file',
    legacy.sourceRelative,
    '--confirm-legacy',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.equal(stderr, '');
  assert.match(stdout, /archive\/resolved\/fixes\/cli-legacy\.md/);
  assert.ok(existsSync(path.join(knowledgeRoot, 'archive', 'resolved', 'fixes', 'cli-legacy.md')));
});

test('CLI resolve-fix rejects missing, empty, duplicate, and unknown arguments without writing', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'strict CLI resolve arguments' });
  await changeResolvableTarget(fix, 'strict parser should reject before resolution');
  const sourceBefore = await readFile(fix.sourcePath, 'utf8');
  const invalidArguments = [
    [],
    ['--file'],
    ['--file', ''],
    ['--file='],
    ['--file', '--confirm-legacy'],
    ['--file', fix.sourceRelative, '--file', fix.sourceRelative],
    [`--file=${fix.sourceRelative}`, `--file=${fix.sourceRelative}`],
    ['--file', fix.sourceRelative, '--confirm-legacy', '--confirm-legacy'],
    ['--file', fix.sourceRelative, '--unknown'],
    [fix.sourceRelative],
    ['--file', fix.sourceRelative, '--json'],
  ];

  for (const commandArgs of invalidArguments) {
    const error = await runCliFailure([
      'resolve-fix',
      ...commandArgs,
      '--knowledge-root',
      knowledgeRoot,
    ]);

    assert.equal(error.code, 1, `expected rejection for: ${commandArgs.join(' ')}`);
    const output = `${error.stderr}${error.stdout}`;
    assert.match(output, /resolve-fix/i);
    assert.doesNotMatch(output, /未知命令|unknown command/i);
    assert.equal(await readFile(fix.sourcePath, 'utf8'), sourceBefore);
    assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
    assert.equal(existsSync(path.join(knowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'archive')), false);
  }
});

test('CLI resolve-fix rejects repository-root and duplicate knowledge-root before resolution', async () => {
  const argumentVariants = [
    ({ knowledgeRoot, bogusRepositoryRoot }) => [
      '--repository-root',
      bogusRepositoryRoot,
      '--knowledge-root',
      knowledgeRoot,
    ],
    ({ knowledgeRoot }) => [
      '--knowledge-root',
      knowledgeRoot,
      `--knowledge-root=${knowledgeRoot}`,
    ],
    ({ knowledgeRoot, otherKnowledgeRoot }) => [
      `--knowledge-root=${knowledgeRoot}`,
      '--knowledge-root',
      otherKnowledgeRoot,
    ],
  ];

  for (const buildGlobalArguments of argumentVariants) {
    const knowledgeRoot = await createTempRoot();
    const otherKnowledgeRoot = await createTempRoot();
    const bogusRepositoryRoot = path.join(await createTempRoot(), 'missing-repository');
    const fix = await createResolvableFix(knowledgeRoot, { title: 'strict global resolve arguments' });
    await changeResolvableTarget(fix, 'global options must be rejected before resolveFix');
    const sourceBefore = await readFile(fix.sourcePath, 'utf8');
    const globalArguments = buildGlobalArguments({
      knowledgeRoot,
      otherKnowledgeRoot,
      bogusRepositoryRoot,
    });

    const error = await runCliFailure([
      'resolve-fix',
      '--file',
      fix.sourceRelative,
      ...globalArguments,
    ]);
    const output = `${error.stderr}${error.stdout}`;

    assert.equal(error.code, 1);
    assert.match(output, /resolve-fix/i);
    assert.match(output, /--repository-root|--knowledge-root/i);
    assert.equal(await readFile(fix.sourcePath, 'utf8'), sourceBefore);
    assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
    assert.equal(existsSync(path.join(knowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'archive')), false);
    assert.equal(existsSync(path.join(otherKnowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(otherKnowledgeRoot, 'archive')), false);
  }
});

test('resolveFix happy publishes immutable source artifacts without rewriting the confirmed target', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot);
  const sourceBytes = await readFile(fix.sourcePath);
  const sourceText = sourceBytes.toString('utf8');
  const changedTargetContent = [
    '---',
    'title: resolve target',
    'status: confirmed',
    '---',
    '',
    '# resolve target',
    '',
    'human reviewed target body',
    '',
  ].join('\n');
  await writeFile(fix.targetPath, changedTargetContent, 'utf8');
  const targetBytesBeforeResolve = await readFile(fix.targetPath);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  const result = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

  assert.deepEqual(await readFile(fix.targetPath), targetBytesBeforeResolve, 'resolveFix must not rewrite target');
  assert.ok(!existsSync(fix.sourcePath));
  assert.ok(!existsSync(artifacts.claim));
  assert.ok(!existsSync(artifacts.claimContainer));
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
  const survivorBytes = await readFile(artifacts.survivor);
  const snapshotBytes = await readFile(artifacts.snapshot);
  assert.deepEqual(survivorBytes, sourceBytes);
  assert.deepEqual(snapshotBytes, sourceBytes);
  assert.notEqual((await stat(artifacts.survivor)).ino, (await stat(artifacts.snapshot)).ino);
  assert.equal((await stat(artifacts.survivor)).mode & 0o222, 0);
  assert.equal((await stat(artifacts.snapshot)).mode & 0o222, 0);

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  const fixId = sourceText.match(/^fix_id: (.+)$/m)[1];
  const target = sourceText.match(/^target: (.+)$/m)[1];
  const targetHash = sourceText.match(/^target_hash: (.+)$/m)[1];
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const resolvedTargetHash = createHash('sha256').update(targetBytesBeforeResolve).digest('hex');
  assert.match(resolvedContent, /^status: resolved$/m);
  assert.match(resolvedContent, /^updated: \d{4}-\d{2}-\d{2}$/m);
  assert.match(resolvedContent, /^resolved_at: \d{4}-\d{2}-\d{2}T.+Z$/m);
  assert.match(resolvedContent, new RegExp(`^fix_id: ${fixId}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^target: ${target}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^target_hash: ${targetHash}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^resolved_target_hash: ${resolvedTargetHash}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^source: ${fix.sourceRelative.replaceAll('/', '\\/')}$`, 'm'));
  assert.match(resolvedContent, /^source_survivor: archive\/source-survivors\/fixes\/.+\.md$/m);
  assert.match(resolvedContent, /^source_snapshot: archive\/resolved-sources\/fixes\/.+\.md$/m);
  assert.match(resolvedContent, new RegExp(`^source_hash: ${sourceHash}$`, 'm'));
  assert.match(resolvedContent, /fix body must survive resolution|证据链/);
  assert.equal(result.source, fix.sourceRelative);
  assert.equal(result.sourceSurvivor, path.relative(knowledgeRoot, artifacts.survivor).replaceAll('\\', '/'));
  assert.equal(result.sourceSnapshot, path.relative(knowledgeRoot, artifacts.snapshot).replaceAll('\\', '/'));
  assert.equal(result.resolved, path.relative(knowledgeRoot, artifacts.resolved).replaceAll('\\', '/'));
  assert.deepEqual(await searchKnowledge({ knowledgeRoot, query: '证据链' }), []);
  assert.deepEqual(await listPending({ knowledgeRoot }), []);
});

test('resolveFix happy atomically renames source into the deterministic claim container', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'claim container rename' });
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const renameCalls = [];

  await resolveFix({
    knowledgeRoot,
    file: fix.sourceRelative,
    renameFile: async (sourcePath, claimPath) => {
      renameCalls.push([sourcePath, claimPath]);
      await rename(sourcePath, claimPath);
    },
  });

  assert.deepEqual(renameCalls, [[fix.sourcePath, artifacts.claim]]);
  assert.ok(!existsSync(artifacts.claimContainer));
});

test('resolveFix source removes a safe empty claim container after rename EBUSY or EACCES and allows retry', async () => {
  for (const errorCode of ['EBUSY', 'EACCES']) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `rename-retry-${errorCode}` });
    const sourceBytes = await readFile(fix.sourcePath);
    await writeFile(
      fix.targetPath,
      ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
      'utf8',
    );
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const renameError = new Error(`simulated rename ${errorCode}`);
    renameError.code = errorCode;

    await assert.rejects(
      resolveFix({
        knowledgeRoot,
        file: fix.sourceRelative,
        renameFile: async () => {
          throw renameError;
        },
      }),
      (error) => error === renameError,
      errorCode,
    );

    assert.deepEqual(await readFile(fix.sourcePath), sourceBytes, errorCode);
    assert.ok(!existsSync(artifacts.claimContainer), errorCode);
    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    assert.ok(existsSync(artifacts.resolved), errorCode);
  }
});

test('resolveFix source preserves a non-empty claim container when rename fails and reports recovery path', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'rename-non-empty-recovery' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const recoveryEvidence = path.join(artifacts.claimContainer, 'manual-evidence.txt');
  const renameError = new Error('simulated rename blocked by recovery evidence');
  renameError.code = 'EBUSY';
  let caughtError;

  try {
    await resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      renameFile: async () => {
        await writeFile(recoveryEvidence, 'retain me\n', { flag: 'wx' });
        throw renameError;
      },
    });
  } catch (error) {
    caughtError = error;
  }

  assert.ok(caughtError);
  assert.equal(caughtError.cause, renameError);
  assert.match(caughtError.message, /恢复路径|恢复现场/);
  assert.match(caughtError.message, new RegExp(path.basename(artifacts.claimContainer).replaceAll('.', '\\.')));
  assert.match(caughtError.message, /simulated rename blocked/);
  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.equal(await readFile(recoveryEvidence, 'utf8'), 'retain me\n');
  assert.ok(existsSync(artifacts.claimContainer));
});

test('resolveFix source preserves an unsafe claim container path when rename fails and reports recovery path', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'rename-unsafe-recovery' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const renameError = new Error('simulated access denied after junction replacement');
  renameError.code = 'EACCES';
  let linkUnavailable = false;
  let caughtError;

  try {
    await resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      renameFile: async () => {
        await rmdir(artifacts.claimContainer);
        if (!await createDirectoryLink(t, outsideRoot, artifacts.claimContainer)) {
          linkUnavailable = true;
        }
        throw renameError;
      },
    });
  } catch (error) {
    caughtError = error;
  }
  if (linkUnavailable) {
    return;
  }

  assert.ok(caughtError);
  assert.equal(caughtError.cause, renameError);
  assert.match(caughtError.message, /恢复路径|恢复现场/);
  assert.match(caughtError.message, /simulated access denied/);
  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.deepEqual(await readdir(outsideRoot), []);
  assert.ok(existsSync(artifacts.claimContainer));
});

test('resolveFix happy preserves a new inbox source recreated after claim rename', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'source recreation' });
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const recreatedSource = Buffer.from('new source created by editor\n', 'utf8');

  await resolveFix({
    knowledgeRoot,
    file: fix.sourceRelative,
    renameFile: async (sourcePath, claimPath) => {
      await rename(sourcePath, claimPath);
      await writeFile(sourcePath, recreatedSource, { flag: 'wx' });
    },
  });

  assert.deepEqual(await readFile(fix.sourcePath), recreatedSource);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
});

test('resolveFix unchanged rejects an untouched target and safely restores the pending source', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot);
  const sourceBytes = await readFile(fix.sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
    /target.*未变化|目标.*未变化|哈希.*相同/,
  );

  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
});

test('resolveFix target second validation failure keeps the claim and never restores inbox source', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'second target validation' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterClaimRename: async () => {
          await writeFile(
            fix.targetPath,
            ['---', 'title: changed again', 'status: pending', '---', '', '# changed again', ''].join('\n'),
            'utf8',
          );
        },
      },
    }),
    /confirmed/,
  );

  assert.ok(!existsSync(fix.sourcePath));
  assert.deepEqual(await readFile(artifacts.claim), sourceBytes);
  assert.ok(existsSync(artifacts.claimContainer));
  assert.ok(!existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix target rejects deleted, non-confirmed, and non-file targets without archiving the source', async () => {
  const cases = [
    {
      name: 'deleted',
      prepare: async ({ targetPath }) => rm(targetPath),
      error: /target.*不存在|目标.*不存在/,
    },
    {
      name: 'non-confirmed',
      prepare: async ({ targetPath }) => writeFile(
        targetPath,
        ['---', 'title: pending target', 'status: pending', '---', '', '# pending target', ''].join('\n'),
        'utf8',
      ),
      error: /confirmed/,
    },
    {
      name: 'non-file',
      prepare: async ({ knowledgeRoot, targetPath, sourcePath }) => {
        await rm(targetPath);
        await mkdir(targetPath);
        await rm(sourcePath);
        await writePendingFix(knowledgeRoot, path.relative(knowledgeRoot, sourcePath), {
          target: 'knowledge/rules/resolve-target.md',
          targetHash: 'a'.repeat(64),
        });
      },
      error: /Markdown.*普通文件|不是.*文件/,
    },
  ];

  for (const scenario of cases) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `target-${scenario.name}` });
    await scenario.prepare({ knowledgeRoot, ...fix });
    const sourceBytes = await readFile(fix.sourcePath);

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
      scenario.error,
      scenario.name,
    );

    assert.deepEqual(await readFile(fix.sourcePath), sourceBytes, scenario.name);
    assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
  }
});

test('resolveFix target rejects a junction escaping the knowledge root and restores the source', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const outsideTargetContent = ['---', 'title: outside', 'status: confirmed', '---', '', '# outside', ''].join('\n');
  await writeExternalKnowledgeFile(outsideRoot, 'target.md', outsideTargetContent);
  const escapedDir = path.join(knowledgeRoot, 'knowledge', 'escaped');
  await mkdir(path.dirname(escapedDir), { recursive: true });
  if (!await createDirectoryLink(t, outsideRoot, escapedDir)) {
    return;
  }
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/escaped-target.md', {
    target: 'knowledge/escaped/target.md',
    targetHash: createHash('sha256').update(Buffer.from(outsideTargetContent)).digest('hex'),
  });
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/escaped-target.md' }),
    /知识库.*内|越界|逃逸/,
  );

  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
});

test('resolveFix target rejects confirmed files outside the formal knowledge tree', async () => {
  const targetCases = [
    'inbox/rules/confirmed-target.md',
    'archive/manual/confirmed-target.md',
  ];

  for (const [index, relativeTarget] of targetCases.entries()) {
    const knowledgeRoot = await createTempRoot();
    await writeExternalKnowledgeFile(
      knowledgeRoot,
      relativeTarget,
      ['---', 'title: misplaced target', 'status: confirmed', '---', '', '# misplaced target', ''].join('\n'),
    );
    const sourcePath = await writePendingFix(knowledgeRoot, `inbox/fixes/misplaced-${index}.md`, {
      target: relativeTarget,
      targetHash: 'a'.repeat(64),
    });
    const sourceBytes = await readFile(sourcePath);

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: path.relative(knowledgeRoot, sourcePath) }),
      /target.*knowledge\//,
      relativeTarget,
    );

    assert.deepEqual(await readFile(sourcePath), sourceBytes, relativeTarget);
    assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
  }
});

test('resolveFix target rejects a knowledge junction resolving into inbox', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const inboxTargetDir = path.join(knowledgeRoot, 'inbox', 'confirmed-targets');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/confirmed-targets/target.md',
    ['---', 'title: inbox confirmed', 'status: confirmed', '---', '', '# inbox confirmed', ''].join('\n'),
  );
  const linkedKnowledgeDir = path.join(knowledgeRoot, 'knowledge', 'inbox-alias');
  await mkdir(path.dirname(linkedKnowledgeDir), { recursive: true });
  if (!await createDirectoryLink(t, inboxTargetDir, linkedKnowledgeDir)) {
    return;
  }
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/knowledge-junction.md', {
    target: 'knowledge/inbox-alias/target.md',
    targetHash: 'a'.repeat(64),
  });
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/knowledge-junction.md' }),
    /target.*knowledge.*真实路径|正式 knowledge/,
  );

  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
});

test('resolveFix source rejects paths outside fixed categories before creating work or archive state', async () => {
  const invalidSources = [
    'inbox/rules/not-a-fix.md',
    'inbox/fixes/nested/not-direct.md',
    'inbox/fixes/not-markdown.txt',
  ];

  for (const relativeSource of invalidSources) {
    const knowledgeRoot = await createTempRoot();
    const sourcePath = await writePendingFix(knowledgeRoot, relativeSource, {
      target: 'knowledge/rules/target.md',
      targetHash: 'a'.repeat(64),
    });
    const sourceBytes = await readFile(sourcePath);

    await assert.rejects(resolveFix({ knowledgeRoot, file: relativeSource }), /固定分类|source.*路径|Markdown/);

    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.ok(!existsSync(path.join(knowledgeRoot, 'work')));
    assert.ok(!existsSync(path.join(knowledgeRoot, 'archive')));
  }
});

test('resolveFix source rejects non-pending and incomplete new-format fixes before any side effect', async () => {
  const invalidFields = [
    { status: 'resolved', target: 'knowledge/rules/target.md', targetHash: 'a'.repeat(64) },
    { targetHash: 'a'.repeat(64) },
    { target: 'knowledge/rules/target.md' },
  ];

  for (const [index, fields] of invalidFields.entries()) {
    const knowledgeRoot = await createTempRoot();
    const relativeSource = `inbox/prd-corrections/invalid-${index}.md`;
    const sourcePath = await writePendingFix(knowledgeRoot, relativeSource, fields);
    const sourceBytes = await readFile(sourcePath);

    await assert.rejects(resolveFix({ knowledgeRoot, file: relativeSource }), /pending|target|target_hash/);

    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
    await assertResolveLockReleased(knowledgeRoot);
  }
});

test('resolveFix source rejects a non-empty malformed fix_id before any side effect', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/uuid-target.md',
    ['---', 'title: uuid target', 'status: confirmed', '---', '', '# uuid target', ''].join('\n'),
  );
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/malformed-uuid.md', {
    fixId: 'not-a-valid-uuid',
    target: 'knowledge/rules/uuid-target.md',
    targetHash: 'a'.repeat(64),
  });
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/malformed-uuid.md' }),
    /fix_id.*UUID|fix_id.*uuid/,
  );

  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
  await assertResolveLockReleased(knowledgeRoot);
});

test('resolveFix source rejects missing fix_id when a new-format target_hash is present', async () => {
  const knowledgeRoot = await createTempRoot();
  const originalTarget = ['---', 'title: target', 'status: confirmed', '---', '', '# target', 'old', ''].join('\n');
  const changedTarget = ['---', 'title: target', 'status: confirmed', '---', '', '# target', 'new', ''].join('\n');
  const targetPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/missing-id-target.md',
    originalTarget,
  );
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/missing-id.md', {
    omitFixId: true,
    target: 'knowledge/rules/missing-id-target.md',
    targetHash: createHash('sha256').update(Buffer.from(originalTarget)).digest('hex'),
  });
  await writeFile(targetPath, changedTarget, 'utf8');
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/missing-id.md' }),
    /fix_id/,
  );
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
});

test('resolveFix source rejects a symlink even when it resolves inside the knowledge root', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const actualSource = await writePendingFix(knowledgeRoot, 'inbox/actual-source.md', {
    target: 'knowledge/rules/target.md',
    targetHash: 'a'.repeat(64),
  });
  const linkedSource = path.join(knowledgeRoot, 'inbox', 'fixes', 'linked.md');
  await mkdir(path.dirname(linkedSource), { recursive: true });
  try {
    await symlink(actualSource, linkedSource, 'file');
  } catch (error) {
    if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      t.skip(`file links are unavailable on this platform: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(resolveFix({ knowledgeRoot, file: 'inbox/fixes/linked.md' }), /symlink|符号链接|普通文件/);

  assert.ok(existsSync(linkedSource));
  assert.ok(existsSync(actualSource));
  assertNoResolutionArtifacts(knowledgeRoot, linkedSource);
  await assertResolveLockReleased(knowledgeRoot);
});

test('resolveFix source rejects an inbox category parent junction escaping the knowledge root', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const externalSource = await writePendingFix(outsideRoot, 'junction-source.md', {
    target: 'knowledge/rules/target.md',
    targetHash: 'a'.repeat(64),
  });
  const externalBytes = await readFile(externalSource);
  const categoryPath = path.join(knowledgeRoot, 'inbox', 'fixes');
  await mkdir(path.dirname(categoryPath), { recursive: true });
  if (!await createDirectoryLink(t, outsideRoot, categoryPath)) {
    return;
  }

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/junction-source.md' }),
    /source.*真实路径|source.*知识库|越出当前知识库/,
  );

  assert.deepEqual(await readFile(externalSource), externalBytes);
  assert.deepEqual(await readdir(outsideRoot), ['junction-source.md']);
  assertNoResolutionArtifacts(knowledgeRoot, path.join(knowledgeRoot, 'inbox', 'fixes', 'junction-source.md'));
  await assertResolveLockReleased(knowledgeRoot);
});

test('resolveFix source never overwrites an existing claim', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'existing claim' });
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const sourceBytes = await readFile(fix.sourcePath);
  const claimPath = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath).claim;
  const existingClaimBytes = Buffer.from('existing claim must not be overwritten\n', 'utf8');
  await mkdir(path.dirname(claimPath), { recursive: true });
  await writeFile(claimPath, existingClaimBytes);

  await assert.rejects(resolveFix({ knowledgeRoot, file: fix.sourceRelative }), /claim.*已存在/);

  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.deepEqual(await readFile(claimPath), existingClaimBytes);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  assert.ok(!existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix source reports an existing claim before reading a missing inbox source', async () => {
  const knowledgeRoot = await createTempRoot();
  const missingSource = path.join(knowledgeRoot, 'inbox', 'fixes', 'claimed-only.md');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, missingSource);
  const claimedBytes = Buffer.from('claimed evidence retained for Task3\n', 'utf8');
  await mkdir(artifacts.claimContainer, { recursive: true });
  await writeFile(artifacts.claim, claimedBytes);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/claimed-only.md' }),
    /claim.*恢复.*Task3|claim.*已存在/,
  );

  assert.deepEqual(await readFile(artifacts.claim), claimedBytes);
  assert.ok(!existsSync(missingSource));
});

test('resolveFix source rejects a claim container replaced by an external junction after mkdir', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'claim container junction race' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  let linkUnavailable = false;
  let caughtError;

  try {
    await resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterClaimContainerCreated: async ({ claimContainer }) => {
          await rmdir(claimContainer);
          if (!await createDirectoryLink(t, outsideRoot, claimContainer)) {
            linkUnavailable = true;
            throw new Error('directory links unavailable');
          }
        },
      },
    });
  } catch (error) {
    caughtError = error;
  }
  if (linkUnavailable) {
    return;
  }

  assert.ok(caughtError);
  assert.match(caughtError.message, /claim.*空目录|claim.*普通目录|claim.*知识库/);
  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.deepEqual(await readdir(outsideRoot), []);
  assert.ok(existsSync(artifacts.claimContainer));
  assert.ok(!existsSync(artifacts.claim));
  assert.ok(!existsSync(artifacts.survivor));
});

test('resolveFix internal path revalidates archive parents at every write and preserves existing evidence', async (t) => {
  const scenarios = [
    { stage: 'survivor-publish', claim: true, survivor: false, snapshot: false, temp: false },
    { stage: 'snapshot-temp-write', claim: false, survivor: true, snapshot: false, temp: false },
    { stage: 'snapshot-link', claim: false, survivor: true, snapshot: false, temp: true },
    { stage: 'resolved-temp-write', claim: false, survivor: true, snapshot: true, temp: false },
    { stage: 'resolved-link', claim: false, survivor: true, snapshot: true, temp: true },
  ];

  for (const scenario of scenarios) {
    const knowledgeRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `archive-race-${scenario.stage}` });
    await writeFile(
      fix.targetPath,
      ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
      'utf8',
    );
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    let swapResult;
    let caughtError;

    try {
      await resolveFix({
        knowledgeRoot,
        file: fix.sourceRelative,
        hooks: {
          beforeArchiveWrite: async ({ stage, parentPath }) => {
            if (stage === scenario.stage) {
              swapResult = await swapDirectoryForExternalLink(t, parentPath, outsideRoot);
            }
          },
        },
      });
    } catch (error) {
      caughtError = error;
    }
    if (swapResult && !swapResult.linked) {
      return;
    }

    assert.ok(caughtError, scenario.stage);
    assert.match(caughtError.message, /父目录.*知识库|真实路径.*知识库/, scenario.stage);
    assert.deepEqual(await readdir(outsideRoot), [], scenario.stage);
    assert.equal(existsSync(artifacts.claim), scenario.claim, scenario.stage);
    assert.equal(existsSync(artifacts.survivor), scenario.survivor, scenario.stage);
    assert.equal(existsSync(artifacts.snapshot), scenario.snapshot, scenario.stage);
    assert.ok(!existsSync(artifacts.resolved), scenario.stage);
    assert.ok(!existsSync(fix.sourcePath), scenario.stage);
    const backupEntries = await readdir(swapResult.backupDirectory);
    assert.equal(backupEntries.some((entry) => entry.endsWith('.tmp')), scenario.temp, scenario.stage);
  }
});

test('resolveFix internal path rejects work and archive parent junction escapes before locking or claiming', async (t) => {
  const unsafeParents = [
    'work',
    'archive/source-survivors',
    'archive/resolved-sources',
    'archive/resolved',
  ];

  for (const unsafeParent of unsafeParents) {
    const knowledgeRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `internal-${unsafeParent}` });
    await writeFile(
      fix.targetPath,
      ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
      'utf8',
    );
    const sourceBytes = await readFile(fix.sourcePath);
    const linkPath = path.join(knowledgeRoot, ...unsafeParent.split('/'));
    await mkdir(path.dirname(linkPath), { recursive: true });
    if (!await createDirectoryLink(t, outsideRoot, linkPath)) {
      return;
    }

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
      /内部目录|知识库.*内|越界|逃逸/,
      unsafeParent,
    );

    assert.deepEqual(await readFile(fix.sourcePath), sourceBytes, unsafeParent);
    assert.deepEqual(await readdir(outsideRoot), [], unsafeParent);
    const lockDir = path.join(knowledgeRoot, 'work', 'locks', 'resolve');
    if (existsSync(lockDir)) {
      assert.deepEqual(await readdir(lockDir), [], unsafeParent);
    }
  }
});

test('resolveFix recovery resumes an old claim before a recreated or missing inbox source', async () => {
  for (const recreateSource of [false, true]) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `claim-recovery-${recreateSource}` });
    const oldSourceBytes = await readFile(fix.sourcePath);
    await changeResolvableTarget(fix);
    await interruptResolveAt(knowledgeRoot, fix, 'after-claim');
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const recreatedBytes = Buffer.from('invalid new lifecycle source\n', 'utf8');
    if (recreateSource) {
      await writeFile(fix.sourcePath, recreatedBytes, { flag: 'wx' });
    }

    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

    assert.deepEqual(await readFile(artifacts.snapshot), oldSourceBytes);
    assert.ok(existsSync(artifacts.resolved));
    assert.equal(existsSync(fix.sourcePath), recreateSource);
    if (recreateSource) {
      assert.deepEqual(await readFile(fix.sourcePath), recreatedBytes);
    }
  }
});

test('resolveFix recovery serializes Windows source filename case variants with one filesystem identity', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only case-insensitive filesystem identity contract');
    return;
  }
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'windows-case-lock' });
  await changeResolvableTarget(fix);
  const variantSource = windowsSourceCaseVariant(fix.sourceRelative);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  let releaseClaim;
  let reportClaimed;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const claimReached = new Promise((resolve) => { reportClaimed = resolve; });
  const firstCall = resolveFix({
    knowledgeRoot,
    file: fix.sourceRelative,
    hooks: {
      afterClaimRename: async () => {
        reportClaimed();
        await claimGate;
      },
    },
  });
  await claimReached;
  let secondSettled = false;
  const secondCall = resolveFix({ knowledgeRoot, file: variantSource });
  const observedSecond = secondCall.then(
    (value) => {
      secondSettled = true;
      return { status: 'fulfilled', value };
    },
    (reason) => {
      secondSettled = true;
      return { status: 'rejected', reason };
    },
  );

  await delay(100);
  const serializedWhileFirstOwnsLock = !secondSettled;
  releaseClaim();
  const [firstResult, secondResult] = await Promise.allSettled([firstCall, observedSecond]);

  assert.ok(serializedWhileFirstOwnsLock, 'case variant must wait for the first source lock');
  assert.equal(firstResult.status, 'fulfilled');
  assert.equal(secondResult.status, 'fulfilled');
  assert.equal(secondResult.value.status, 'fulfilled');
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
  assert.ok(!existsSync(artifacts.claimContainer));
  assert.deepEqual(await readdir(path.dirname(artifacts.survivor)), [path.basename(artifacts.survivor)]);
  assert.deepEqual(await readdir(path.dirname(artifacts.snapshot)), [path.basename(artifacts.snapshot)]);
  assert.deepEqual(await readdir(path.dirname(artifacts.resolved)), [path.basename(artifacts.resolved)]);
});

test('resolveFix recovery cleans only an empty claim container when the original source still exists', async () => {
  const retryRoot = await createTempRoot();
  const retryFix = await createResolvableFix(retryRoot, { title: 'empty-claim-retry' });
  await changeResolvableTarget(retryFix);
  const retryArtifacts = resolutionArtifactPaths(retryRoot, retryFix.sourcePath);
  await mkdir(retryArtifacts.claimContainer, { recursive: true });

  await resolveFix({ knowledgeRoot: retryRoot, file: retryFix.sourceRelative });

  assert.ok(existsSync(retryArtifacts.resolved));
  assert.ok(!existsSync(retryArtifacts.claimContainer));

  const missingRoot = await createTempRoot();
  const missingSource = path.join(missingRoot, 'inbox', 'fixes', 'missing.md');
  const missingArtifacts = resolutionArtifactPaths(missingRoot, missingSource);
  await mkdir(missingArtifacts.claimContainer, { recursive: true });
  await assert.rejects(
    resolveFix({ knowledgeRoot: missingRoot, file: 'inbox/fixes/missing.md' }),
    /claim.*不完整|source.*不存在|恢复现场/,
  );
  assert.ok(existsSync(missingArtifacts.claimContainer));

  const nonEmptyRoot = await createTempRoot();
  const nonEmptyFix = await createResolvableFix(nonEmptyRoot, { title: 'non-empty-claim' });
  await changeResolvableTarget(nonEmptyFix);
  const nonEmptyArtifacts = resolutionArtifactPaths(nonEmptyRoot, nonEmptyFix.sourcePath);
  await mkdir(nonEmptyArtifacts.claimContainer, { recursive: true });
  const evidencePath = path.join(nonEmptyArtifacts.claimContainer, 'manual.txt');
  await writeFile(evidencePath, 'keep\n', 'utf8');
  await assert.rejects(
    resolveFix({ knowledgeRoot: nonEmptyRoot, file: nonEmptyFix.sourceRelative }),
    /claim.*不完整|预期|未知/,
  );
  assert.equal(await readFile(evidencePath, 'utf8'), 'keep\n');
  assert.ok(existsSync(nonEmptyFix.sourcePath));

  const mixedRoot = await createTempRoot();
  const mixedFix = await createResolvableFix(mixedRoot, { title: 'claim-source-plus-unknown' });
  await changeResolvableTarget(mixedFix);
  await interruptResolveAt(mixedRoot, mixedFix, 'after-claim');
  const mixedArtifacts = resolutionArtifactPaths(mixedRoot, mixedFix.sourcePath);
  const unknownPath = path.join(mixedArtifacts.claimContainer, 'unknown.txt');
  await writeFile(unknownPath, 'retain unknown evidence\n', 'utf8');

  await assert.rejects(
    resolveFix({ knowledgeRoot: mixedRoot, file: mixedFix.sourceRelative }),
    /claim.*预期|claim.*不完整|未知/,
  );
  assert.ok(existsSync(mixedArtifacts.claim));
  assert.equal(await readFile(unknownPath, 'utf8'), 'retain unknown evidence\n');
  assert.ok(!existsSync(mixedArtifacts.survivor));
});

test('resolveFix recovery accepts only a same-inode claim and survivor pair', async () => {
  const sameRoot = await createTempRoot();
  const sameFix = await createResolvableFix(sameRoot, { title: 'same-inode-claim-survivor' });
  await changeResolvableTarget(sameFix);
  await interruptResolveAt(sameRoot, sameFix, 'after-claim');
  const sameArtifacts = resolutionArtifactPaths(sameRoot, sameFix.sourcePath);
  await mkdir(path.dirname(sameArtifacts.survivor), { recursive: true });
  await link(sameArtifacts.claim, sameArtifacts.survivor);

  await resolveFix({ knowledgeRoot: sameRoot, file: sameFix.sourceRelative });

  assert.ok(!existsSync(sameArtifacts.claimContainer));
  assert.ok(existsSync(sameArtifacts.resolved));
  assert.equal((await stat(sameArtifacts.survivor)).mode & 0o222, 0);

  const conflictRoot = await createTempRoot();
  const conflictFix = await createResolvableFix(conflictRoot, { title: 'different-inode-claim-survivor' });
  await changeResolvableTarget(conflictFix);
  await interruptResolveAt(conflictRoot, conflictFix, 'after-claim');
  const conflictArtifacts = resolutionArtifactPaths(conflictRoot, conflictFix.sourcePath);
  await mkdir(path.dirname(conflictArtifacts.survivor), { recursive: true });
  await writeFile(conflictArtifacts.survivor, await readFile(conflictArtifacts.claim));

  await assert.rejects(
    resolveFix({ knowledgeRoot: conflictRoot, file: conflictFix.sourceRelative }),
    /claim.*survivor.*冲突|inode|同一.*inode/,
  );
  assert.ok(existsSync(conflictArtifacts.claim));
  assert.ok(existsSync(conflictArtifacts.survivor));
});

test('resolveFix recovery resumes survivor-only and survivor-plus-snapshot states', async () => {
  for (const stage of ['snapshot-temp-write', 'resolved-temp-write']) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `resume-${stage}` });
    await changeResolvableTarget(fix);
    await interruptResolveAt(knowledgeRoot, fix, stage);
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

    assert.ok(existsSync(artifacts.resolved), stage);
    assert.equal((await stat(artifacts.survivor)).mode & 0o222, 0, stage);
    assert.equal((await stat(artifacts.snapshot)).mode & 0o222, 0, stage);
  }
});

test('resolveFix recovery revalidates target before completing survivor and snapshot states', async () => {
  const scenarios = [
    {
      stage: 'snapshot-temp-write',
      name: 'deleted',
      mutate: ({ targetPath }) => rm(targetPath),
      error: /target.*不存在/,
    },
    {
      stage: 'snapshot-temp-write',
      name: 'non-confirmed',
      mutate: ({ targetPath }) => writeFile(
        targetPath,
        ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
        'utf8',
      ),
      error: /confirmed/,
    },
    {
      stage: 'resolved-temp-write',
      name: 'baseline',
      mutate: ({ targetPath, originalTargetContent }) => writeFile(targetPath, originalTargetContent, 'utf8'),
      error: /哈希.*相同|未变化/,
    },
  ];

  for (const scenario of scenarios) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `revalidate-${scenario.name}` });
    await changeResolvableTarget(fix);
    await interruptResolveAt(knowledgeRoot, fix, scenario.stage);
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    await scenario.mutate(fix);

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
      scenario.error,
      scenario.name,
    );
    assert.ok(existsSync(artifacts.survivor), scenario.name);
    // survivor-only 恢复按权威流程先固化独立 snapshot，再重新校验 target；target 失败也保留新快照。
    assert.ok(existsSync(artifacts.snapshot), scenario.name);
    assert.ok(!existsSync(artifacts.resolved), scenario.name);
  }
});

test('resolveFix recovery rejects a target link escape in an incomplete state', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'recovery-target-link' });
  await changeResolvableTarget(fix);
  await interruptResolveAt(knowledgeRoot, fix, 'resolved-temp-write');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const targetDir = path.dirname(fix.targetPath);
  const backupDir = `${targetDir}.backup`;
  await rename(targetDir, backupDir);
  if (!await createDirectoryLink(t, outsideRoot, targetDir)) {
    return;
  }

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
    /target.*不存在|target.*知识库|真实路径/,
  );
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix recovery validates survivor-only artifact before chmod and rejects a directory link', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const outsideEvidence = path.join(outsideRoot, 'outside.txt');
  await writeFile(outsideEvidence, 'outside must remain unchanged\n', 'utf8');
  const fix = await createResolvableFix(knowledgeRoot, { title: 'unsafe-survivor-artifact' });
  await changeResolvableTarget(fix);
  await interruptResolveAt(knowledgeRoot, fix, 'snapshot-temp-write');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  await chmod(artifacts.survivor, 0o666);
  await rm(artifacts.survivor);
  if (!await createDirectoryLink(t, outsideRoot, artifacts.survivor)) {
    return;
  }
  const chmodCalls = [];

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      chmodFile: async (filePath, mode) => {
        chmodCalls.push(filePath);
        if (filePath !== artifacts.survivor) {
          await chmod(filePath, mode);
        }
      },
    }),
    /survivor.*普通 Markdown|survivor.*链接|真实路径|无法确认只读/,
  );

  assert.ok(!chmodCalls.includes(artifacts.survivor));
  assert.equal(await readFile(outsideEvidence, 'utf8'), 'outside must remain unchanged\n');
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));
});

test('resolveFix recovery validates snapshot artifact before chmod and rejects a directory link', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const outsideEvidence = path.join(outsideRoot, 'outside.txt');
  await writeFile(outsideEvidence, 'outside snapshot must remain unchanged\n', 'utf8');
  const fix = await createResolvableFix(knowledgeRoot, { title: 'unsafe-snapshot-artifact' });
  await changeResolvableTarget(fix);
  await interruptResolveAt(knowledgeRoot, fix, 'resolved-temp-write');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  await chmod(artifacts.snapshot, 0o666);
  await rm(artifacts.snapshot);
  if (!await createDirectoryLink(t, outsideRoot, artifacts.snapshot)) {
    return;
  }
  const chmodCalls = [];

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      chmodFile: async (filePath, mode) => {
        chmodCalls.push(filePath);
        if (filePath !== artifacts.snapshot) {
          await chmod(filePath, mode);
        }
      },
    }),
    /snapshot.*普通 Markdown|snapshot.*链接|真实路径|无法确认只读/,
  );

  assert.ok(!chmodCalls.includes(artifacts.snapshot));
  assert.equal(await readFile(outsideEvidence, 'utf8'), 'outside snapshot must remain unchanged\n');
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix recovery rejects snapshot-only and archive-only incomplete states', async () => {
  const snapshotRoot = await createTempRoot();
  const snapshotFix = await createResolvableFix(snapshotRoot, { title: 'snapshot-only' });
  await changeResolvableTarget(snapshotFix);
  await interruptResolveAt(snapshotRoot, snapshotFix, 'resolved-temp-write');
  const snapshotArtifacts = resolutionArtifactPaths(snapshotRoot, snapshotFix.sourcePath);
  await chmod(snapshotArtifacts.survivor, 0o666);
  await rm(snapshotArtifacts.survivor);

  await assert.rejects(
    resolveFix({ knowledgeRoot: snapshotRoot, file: snapshotFix.sourceRelative }),
    /snapshot.*survivor|不完整/,
  );
  assert.ok(existsSync(snapshotArtifacts.snapshot));

  const archiveRoot = await createTempRoot();
  const archiveFix = await createResolvableFix(archiveRoot, { title: 'archive-only' });
  await changeResolvableTarget(archiveFix);
  await resolveFix({ knowledgeRoot: archiveRoot, file: archiveFix.sourceRelative });
  const archiveArtifacts = resolutionArtifactPaths(archiveRoot, archiveFix.sourcePath);
  await chmod(archiveArtifacts.survivor, 0o666);
  await chmod(archiveArtifacts.snapshot, 0o666);
  await rm(archiveArtifacts.survivor);
  await rm(archiveArtifacts.snapshot);

  await assert.rejects(
    resolveFix({ knowledgeRoot: archiveRoot, file: archiveFix.sourceRelative }),
    /resolved.*survivor|归档.*不完整|不完整/,
  );
  assert.ok(existsSync(archiveArtifacts.resolved));
});

test('resolveFix idempotent completion ignores current target state and validates persistent artifacts', async () => {
  for (const mutation of ['delete', 'pending', 'changed-again']) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `completed-target-${mutation}` });
    await changeResolvableTarget(fix);
    const firstResult = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    if (mutation === 'delete') {
      await rm(fix.targetPath);
    } else if (mutation === 'pending') {
      await writeFile(
        fix.targetPath,
        ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
        'utf8',
      );
    } else {
      await changeResolvableTarget(fix, 'changed after completion');
    }

    const retryResult = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

    assert.deepEqual(retryResult, firstResult, mutation);
  }
});

test('resolveFix idempotent accepts a Windows source filename case variant', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only case-insensitive filesystem identity contract');
    return;
  }
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'windows-case-idempotent' });
  await changeResolvableTarget(fix);
  const firstResult = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
  const variantSource = windowsSourceCaseVariant(fix.sourceRelative);

  const retryResult = await resolveFix({ knowledgeRoot, file: variantSource });

  assert.deepEqual(retryResult, firstResult);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  assert.deepEqual(await readdir(path.dirname(artifacts.resolved)), [path.basename(artifacts.resolved)]);
  const replacement = Buffer.from('new Windows source lifecycle\n', 'utf8');
  await writeFile(fix.sourcePath, replacement, { flag: 'wx' });
  await assert.rejects(
    resolveFix({ knowledgeRoot, file: variantSource }),
    /source.*复用|重命名|新.*source/,
  );
  assert.deepEqual(await readFile(fix.sourcePath), replacement);
});

test('resolveFix idempotent completion handles residual claims and rejects conflicting ones', async () => {
  const sameRoot = await createTempRoot();
  const sameFix = await createResolvableFix(sameRoot, { title: 'completed-same-claim' });
  await changeResolvableTarget(sameFix);
  await resolveFix({ knowledgeRoot: sameRoot, file: sameFix.sourceRelative });
  const sameArtifacts = resolutionArtifactPaths(sameRoot, sameFix.sourcePath);
  await mkdir(sameArtifacts.claimContainer, { recursive: true });
  await link(sameArtifacts.survivor, sameArtifacts.claim);

  await resolveFix({ knowledgeRoot: sameRoot, file: sameFix.sourceRelative });

  assert.ok(!existsSync(sameArtifacts.claimContainer));
  assert.equal((await stat(sameArtifacts.survivor)).mode & 0o222, 0);

  const conflictRoot = await createTempRoot();
  const conflictFix = await createResolvableFix(conflictRoot, { title: 'completed-different-claim' });
  await changeResolvableTarget(conflictFix);
  await resolveFix({ knowledgeRoot: conflictRoot, file: conflictFix.sourceRelative });
  const conflictArtifacts = resolutionArtifactPaths(conflictRoot, conflictFix.sourcePath);
  await mkdir(conflictArtifacts.claimContainer, { recursive: true });
  await writeFile(conflictArtifacts.claim, await readFile(conflictArtifacts.survivor));

  await assert.rejects(
    resolveFix({ knowledgeRoot: conflictRoot, file: conflictFix.sourceRelative }),
    /claim.*survivor.*冲突|inode/,
  );
  assert.ok(existsSync(conflictArtifacts.claim));
  assert.ok(existsSync(conflictArtifacts.survivor));
});

test('resolveFix idempotent validates completed artifacts before chmod and rejects directory links', async (t) => {
  for (const artifactName of ['survivor', 'snapshot']) {
    const knowledgeRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const outsideEvidence = path.join(outsideRoot, 'outside.txt');
    await writeFile(outsideEvidence, `outside ${artifactName} must remain unchanged\n`, 'utf8');
    const fix = await createResolvableFix(knowledgeRoot, { title: `completed-unsafe-${artifactName}` });
    await changeResolvableTarget(fix);
    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const unsafeArtifact = artifacts[artifactName];
    await chmod(unsafeArtifact, 0o666);
    await rm(unsafeArtifact);
    if (!await createDirectoryLink(t, outsideRoot, unsafeArtifact)) {
      return;
    }
    const chmodCalls = [];

    await assert.rejects(
      resolveFix({
        knowledgeRoot,
        file: fix.sourceRelative,
        chmodFile: async (filePath, mode) => {
          chmodCalls.push(filePath);
          if (filePath !== unsafeArtifact) {
            await chmod(filePath, mode);
          }
        },
      }),
      /普通 Markdown|链接|真实路径|无法确认只读/,
      artifactName,
    );

    assert.ok(!chmodCalls.includes(unsafeArtifact), artifactName);
    assert.equal(
      await readFile(outsideEvidence, 'utf8'),
      `outside ${artifactName} must remain unchanged\n`,
      artifactName,
    );
    assert.ok(existsSync(unsafeArtifact), artifactName);
    assert.ok(existsSync(artifacts.resolved), artifactName);
  }
});

test('resolveFix idempotent rejects a truncated archive and a reused completed source path', async () => {
  const truncatedRoot = await createTempRoot();
  const truncatedFix = await createResolvableFix(truncatedRoot, { title: 'truncated-resolved' });
  await changeResolvableTarget(truncatedFix);
  await resolveFix({ knowledgeRoot: truncatedRoot, file: truncatedFix.sourceRelative });
  const truncatedArtifacts = resolutionArtifactPaths(truncatedRoot, truncatedFix.sourcePath);
  const originalResolved = await readFile(truncatedArtifacts.resolved, 'utf8');
  await writeFile(truncatedArtifacts.resolved, originalResolved.slice(0, originalResolved.indexOf('#')), 'utf8');

  await assert.rejects(
    resolveFix({ knowledgeRoot: truncatedRoot, file: truncatedFix.sourceRelative }),
    /resolved.*冲突|完整.*载荷|归档.*不一致|frontmatter/,
  );

  const reuseRoot = await createTempRoot();
  const reuseFix = await createResolvableFix(reuseRoot, { title: 'source-path-reuse' });
  await changeResolvableTarget(reuseFix);
  await resolveFix({ knowledgeRoot: reuseRoot, file: reuseFix.sourceRelative });
  const replacement = Buffer.from('new source lifecycle must remain\n', 'utf8');
  await writeFile(reuseFix.sourcePath, replacement, { flag: 'wx' });

  await assert.rejects(
    resolveFix({ knowledgeRoot: reuseRoot, file: reuseFix.sourceRelative }),
    /source.*复用|重命名|新.*source/,
  );
  assert.deepEqual(await readFile(reuseFix.sourcePath), replacement);
});

test('resolveFix idempotent rejects invalid persisted completion timestamps', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'invalid-completion-time' });
  await changeResolvableTarget(fix);
  await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  await writeFile(
    artifacts.resolved,
    resolvedContent.replace(/^resolved_at:.*$/m, 'resolved_at: invalid-time'),
    'utf8',
  );

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
    /resolved_at|时间|归档.*冲突/,
  );
});

test('resolveFix recovery retries chmod, unlink, and resolved publication failures without losing evidence', async () => {
  const scenarios = ['survivor-chmod', 'snapshot-chmod', 'claim-unlink', 'resolved-publish'];
  for (const scenario of scenarios) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `failure-${scenario}` });
    await changeResolvableTarget(fix);
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const injectedError = new Error(`simulated ${scenario}`);
    let chmodCalls = 0;
    let removeFailed = false;
    const options = {
      knowledgeRoot,
      file: fix.sourceRelative,
      chmodFile: async (filePath, mode) => {
        chmodCalls += 1;
        if ((scenario === 'survivor-chmod' && chmodCalls === 1)
            || (scenario === 'snapshot-chmod' && filePath === artifacts.snapshot)) {
          throw injectedError;
        }
        await chmod(filePath, mode);
      },
      removeFile: async (filePath, removeOptions) => {
        if (scenario === 'claim-unlink' && filePath === artifacts.claim && !removeFailed) {
          removeFailed = true;
          throw injectedError;
        }
        await rm(filePath, removeOptions);
      },
      hooks: scenario === 'resolved-publish'
        ? {
            beforeArchiveWrite: async ({ stage }) => {
              if (stage === 'resolved-link') {
                throw injectedError;
              }
            },
          }
        : {},
    };

    await assert.rejects(resolveFix(options), (error) => error === injectedError, scenario);
    assert.ok(
      [artifacts.claim, artifacts.survivor, artifacts.snapshot].some((artifact) => existsSync(artifact)),
      scenario,
    );

    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    assert.ok(existsSync(artifacts.resolved), scenario);
  }
});

test('resolveFix late write before resolved publication preserves both sources and does not publish resolved', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'late-before-resolved' });
  await changeResolvableTarget(fix);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const lateBytes = Buffer.from('late writer bytes before resolved\n', 'utf8');

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'resolved-temp-write') {
            await chmod(artifacts.survivor, 0o666);
            await writeFile(artifacts.survivor, lateBytes);
          }
        },
      },
    }),
    /survivor.*snapshot.*不一致|晚到写入|并发写入/,
  );

  assert.deepEqual(await readFile(artifacts.survivor), lateBytes);
  assert.notDeepEqual(await readFile(artifacts.snapshot), lateBytes);
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix late write after resolved publication preserves all artifacts and returns conflict', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'late-after-resolved' });
  await changeResolvableTarget(fix);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const lateBytes = Buffer.from('late writer bytes after resolved\n', 'utf8');

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterArchivePublished: async ({ stage }) => {
          if (stage === 'resolved-link') {
            await chmod(artifacts.survivor, 0o666);
            await writeFile(artifacts.survivor, lateBytes);
          }
        },
      },
    }),
    /survivor.*snapshot.*不一致|晚到写入|并发写入/,
  );

  assert.deepEqual(await readFile(artifacts.survivor), lateBytes);
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
});

test('resolveFix recovery retains claim when target changes after preflight but before claim validation', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'target-race-before-claim-file' });
  const sourceBytes = await readFile(fix.sourcePath);
  await changeResolvableTarget(fix);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterClaimContainerCreated: async () => {
          await writeFile(
            fix.targetPath,
            ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
            'utf8',
          );
        },
      },
    }),
    /confirmed/,
  );

  assert.ok(!existsSync(fix.sourcePath));
  assert.deepEqual(await readFile(artifacts.claim), sourceBytes);
  assert.ok(!existsSync(artifacts.survivor));
});

test('resolveFix recovery legacy requires explicit confirmation and derives a stable snapshot identity', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/legacy-stable.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: legacy.sourceRelative }),
    /confirm-legacy|旧版|legacy/,
  );
  assert.deepEqual(await readFile(legacy.sourcePath), legacy.sourceBytes);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'resolved-temp-write') {
            throw new Error('interrupt legacy after snapshot');
          }
        },
      },
    }),
    /interrupt legacy after snapshot/,
  );
  assert.deepEqual(await readFile(artifacts.snapshot), legacy.sourceBytes);
  const expectedId = `legacy-${createHash('sha256')
    .update(legacy.sourceRelative)
    .update(Buffer.from([0]))
    .update(legacy.sourceBytes)
    .digest('hex')}`;

  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative, confirmLegacy: true });

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  assert.match(resolvedContent, new RegExp(`^fix_id: ${expectedId}$`, 'm'));
  assert.match(resolvedContent, /^legacy_confirmed: true$/m);
  assert.ok(!/^target_hash:/m.test(resolvedContent));
  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative });
});

test('resolveFix recovery legacy preserves an existing UUID while marking manual confirmation', async () => {
  const knowledgeRoot = await createTempRoot();
  const fixId = '22222222-2222-4222-8222-222222222222';
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/tech-solution-corrections/legacy-with-id.md',
    { fixId },
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);

  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative, confirmLegacy: true });

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  assert.match(resolvedContent, new RegExp(`^fix_id: ${fixId}$`, 'm'));
  assert.match(resolvedContent, /^legacy_confirmed: true$/m);
});

test('resolveFix recovery legacy finalizes identity from a late write captured before snapshot publication', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/prd-corrections/legacy-late-before-snapshot.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);
  const lateSnapshotBytes = Buffer.concat([
    legacy.sourceBytes,
    Buffer.from('\nlate editor evidence before snapshot\n', 'utf8'),
  ]);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'snapshot-temp-write') {
            await chmod(artifacts.survivor, 0o666);
            await writeFile(artifacts.survivor, lateSnapshotBytes);
          }
          if (stage === 'resolved-temp-write') {
            throw new Error('interrupt after late snapshot');
          }
        },
      },
    }),
    /interrupt after late snapshot/,
  );
  assert.deepEqual(await readFile(artifacts.snapshot), lateSnapshotBytes);
  const expectedId = `legacy-${createHash('sha256')
    .update(legacy.sourceRelative)
    .update(Buffer.from([0]))
    .update(lateSnapshotBytes)
    .digest('hex')}`;

  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative, confirmLegacy: true });

  assert.match(await readFile(artifacts.resolved, 'utf8'), new RegExp(`^fix_id: ${expectedId}$`, 'm'));
});

test('resolveFix recovery legacy keeps fix_id stable across a Windows source filename case variant', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only case-insensitive filesystem identity contract');
    return;
  }
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/legacy-windows-case.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);
  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'resolved-temp-write') {
            throw new Error('interrupt legacy before Windows case retry');
          }
        },
      },
    }),
    /interrupt legacy before Windows case retry/,
  );
  const variantSource = windowsSourceCaseVariant(legacy.sourceRelative);
  const expectedId = `legacy-${createHash('sha256')
    .update(legacy.sourceRelative.toLowerCase())
    .update(Buffer.from([0]))
    .update(await readFile(artifacts.snapshot))
    .digest('hex')}`;

  await resolveFix({ knowledgeRoot, file: variantSource, confirmLegacy: true });

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  assert.match(resolvedContent, new RegExp(`^fix_id: ${expectedId}$`, 'm'));
  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative });
});

test('resolveFix recovery legacy does not advance an incomplete survivor without renewed confirmation', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/legacy-renew-confirmation.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);
  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'snapshot-temp-write') {
            throw new Error('interrupt before legacy snapshot');
          }
        },
      },
    }),
    /interrupt before legacy snapshot/,
  );
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: legacy.sourceRelative }),
    /confirm-legacy/,
  );
  assert.ok(!existsSync(artifacts.snapshot));
});

test('CLI add-rule writes to separated private knowledge repository inbox', async () => {
  const knowledgeRoot = await createTempRoot();

  await runCli([
    'add-rule',
    '私有知识库规则',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  const ruleDir = path.join(knowledgeRoot, 'inbox', 'rules');
  const { filePath, content } = await readOnlyMarkdownFile(ruleDir);

  assert.match(content, /私有知识库规则/);
  assert.match(content, /^status: draft$/m);
  await assertNoBom(filePath);
});

test('CLI record-fix writes to separated private knowledge repository inbox', async () => {
  const knowledgeRoot = await createTempRoot();

  await runCli([
    'record-fix',
    '--type',
    'tech',
    '--title',
    '私有知识库技术方案纠偏',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  const correctionDir = path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections');
  const { filePath, content } = await readOnlyMarkdownFile(correctionDir);

  assert.match(content, /私有知识库技术方案纠偏/);
  assert.match(content, /证据链/);
  await assertNoBom(filePath);
});

test('CLI record-fix rejects --target pointing to an unconfirmed inbox draft', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/cli-draft.md',
    ['---', 'title: CLI 草稿', 'status: draft', '---', '', '# CLI 草稿', ''].join('\n'),
  );

  const error = await runCliFailure([
    'record-fix',
    '--type',
    'tech',
    '--title',
    '不应生成',
    '--target',
    'inbox/rules/cli-draft.md',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.notEqual(error.code, 0);
  assert.match(`${error.stderr}${error.stdout}`, /未确认草稿.*直接修改原草稿/);
  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections')));
});

test('CLI record-fix rejects --target without a file path', async () => {
  const knowledgeRoot = await createTempRoot();
  const error = await runCliFailure([
    'record-fix',
    '--type',
    'tech',
    '--title',
    '缺少目标路径',
    '--target',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.notEqual(error.code, 0);
  assert.match(`${error.stderr}${error.stdout}`, /--target.*知识文件路径/);
  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox', 'tech-solution-corrections')));
});

test('strict CLI record-fix rejects an unknown option before writing', async () => {
  const knowledgeRoot = await createTempRoot();
  const error = await runCliFailure([
    'record-fix',
    '--type',
    'tech',
    '--title',
    '参数拼写错误',
    '--targte',
    'knowledge/rules/target.md',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.notEqual(error.code, 0);
  assert.match(`${error.stderr}${error.stdout}`, /record-fix.*未知参数.*--targte/);
  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox')));
});

test('strict CLI record-fix rejects duplicate command options before writing', async () => {
  const knowledgeRoot = await createTempRoot();
  const error = await runCliFailure([
    'record-fix',
    '--type',
    'bug',
    '--type',
    'tech',
    '--title',
    '重复类型',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.notEqual(error.code, 0);
  assert.match(`${error.stderr}${error.stdout}`, /record-fix.*--type.*一次/);
  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox')));
});

test('strict CLI record-fix rejects unsupported and duplicate global options before writing', async () => {
  const firstKnowledgeRoot = await createTempRoot();
  const secondKnowledgeRoot = await createTempRoot();
  const unsupportedJson = await runCliFailure([
    'record-fix',
    '--type',
    'tech',
    '--title',
    '不支持 JSON',
    '--json',
    '--knowledge-root',
    firstKnowledgeRoot,
  ]);
  const duplicateRoot = await runCliFailure([
    'record-fix',
    '--type',
    'tech',
    '--title',
    '重复知识库根',
    '--knowledge-root',
    firstKnowledgeRoot,
    '--knowledge-root',
    secondKnowledgeRoot,
  ]);

  assert.match(`${unsupportedJson.stderr}${unsupportedJson.stdout}`, /record-fix.*--json/);
  assert.match(`${duplicateRoot.stderr}${duplicateRoot.stdout}`, /--knowledge-root.*一次/);
  assert.ok(!existsSync(path.join(firstKnowledgeRoot, 'inbox')));
  assert.ok(!existsSync(path.join(secondKnowledgeRoot, 'inbox')));
});

test('strict CLI query commands reject unknown option-like arguments', async () => {
  const knowledgeRoot = await createTempRoot();
  for (const command of ['search', 'before-task']) {
    const error = await runCliFailure([
      command,
      '知识库检索',
      '--targte',
      'unexpected',
      '--knowledge-root',
      knowledgeRoot,
    ]);

    assert.match(`${error.stderr}${error.stdout}`, new RegExp(`${command}.*未知参数.*--targte`));
  }
});

test('strict CLI promote rejects extra arguments before moving the source', async () => {
  const knowledgeRoot = await createTempRoot();
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/strict-promote.md',
    ['---', 'title: strict promote', 'status: draft', '---', '', '# strict promote', ''].join('\n'),
  );
  const error = await runCliFailure([
    'promote',
    '--file',
    'inbox/rules/strict-promote.md',
    'unexpected-position',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(`${error.stderr}${error.stdout}`, /promote.*位置参数.*unexpected-position/);
  assert.ok(existsSync(source));
  assert.ok(!existsSync(path.join(knowledgeRoot, 'knowledge')));
});

test('strict CLI refresh-project rejects duplicate options before modifying knowledge', async () => {
  const projectRoot = await createGitProject();
  const knowledgeRoot = await createTempRoot();
  const knowledgeFile = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-strict-refresh.md',
    ['---', 'title: strict refresh', 'status: confirmed', '---', '', '# strict refresh', ''].join('\n'),
  );
  const before = await readFile(knowledgeFile, 'utf8');
  const error = await runCliFailure([
    'refresh-project',
    '--project-root',
    projectRoot,
    '--knowledge-file',
    'knowledge/domain/project-strict-refresh.md',
    '--knowledge-file',
    'knowledge/domain/project-strict-refresh.md',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(`${error.stderr}${error.stdout}`, /refresh-project.*--knowledge-file.*一次/);
  assert.equal(await readFile(knowledgeFile, 'utf8'), before);
  assert.ok(!existsSync(`${knowledgeFile}.lock`));
});

test('strict CLI list-pending rejects unknown arguments', async () => {
  const knowledgeRoot = await createTempRoot();
  const error = await runCliFailure([
    'list-pending',
    '--unknown',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(`${error.stderr}${error.stdout}`, /list-pending.*未知参数.*--unknown/);
});

test('public entry exports remain stable for programmatic consumers', () => {
  assert.deepEqual(Object.keys(agentKnowledgeModule).sort(), [
    'addRule',
    'checkStale',
    'doctor',
    'extractKeywords',
    'extractQueryKeywords',
    'listPending',
    'promote',
    'recordFix',
    'refreshProject',
    'resolveFix',
    'searchKnowledge',
    'syncAdapters',
    'syncCommandDocs',
    'writeFileAtomic',
    'writeUniqueFile',
  ].sort());
});

test('bin entry import has no CLI side effects', async () => {
  const entryUrl = new URL('../bin/agent-knowledge.js', import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(entryUrl)});`,
  ], {
    encoding: 'utf8',
  });

  assert.equal(stdout, '');
  assert.equal(stderr, '');
});

test('CLI unknown command returns non-zero and readable error', async () => {
  const error = await runCliFailure(['unknown-command'], {
    cwd: await createTempRoot(),
  });

  assert.notEqual(error.code, 0);
  assert.match(`${error.stderr}${error.stdout}`, /未知命令/);
});

test('CLI add-rule without title returns non-zero before writing', async () => {
  const error = await runCliFailure(['add-rule'], {
    cwd: await createTempRoot(),
  });

  assert.notEqual(error.code, 0);
  assert.match(`${error.stderr}${error.stdout}`, /title|标题/i);
});

test('CLI record-fix rejects missing or invalid type', async () => {
  const missingType = await runCliFailure(['record-fix', '--type'], {
    cwd: await createTempRoot(),
  });
  const invalidType = await runCliFailure(['record-fix', '--type', 'other', '--title', '无效类型'], {
    cwd: await createTempRoot(),
  });

  assert.notEqual(missingType.code, 0);
  assert.match(`${missingType.stderr}${missingType.stdout}`, /bug\|prd\|tech/);
  assert.notEqual(invalidType.code, 0);
  assert.match(`${invalidType.stderr}${invalidType.stdout}`, /bug\|prd\|tech/);
});

test('addRule writes rules to inbox with draft status by default', async () => {
  const rootDir = await createTempRoot();

  await addRule({
    rootDir,
    title: '聚合接口数据源一致性',
  });

  const ruleDir = path.join(rootDir, 'agent-knowledge', 'inbox', 'rules');
  const { filePath, content } = await readOnlyMarkdownFile(ruleDir);

  assert.match(content, /^status: draft$/m);
  await assertNoBom(filePath);
});

test('addRule writes confirmed rules to knowledge with confirmed status', async () => {
  const rootDir = await createTempRoot();

  await addRule({
    rootDir,
    title: '已确认规则',
    confirmed: true,
  });

  const ruleDir = path.join(rootDir, 'agent-knowledge', 'knowledge', 'rules');
  const { filePath, content } = await readOnlyMarkdownFile(ruleDir);

  assert.match(content, /^status: confirmed$/m);
  await assertNoBom(filePath);
});

test('recordFix writes PRD corrections to inbox and includes evidence chain template', async () => {
  const rootDir = await createTempRoot();

  await recordFix({
    rootDir,
    type: 'prd',
    title: 'PRD 字段含义纠偏',
  });

  const correctionDir = path.join(rootDir, 'agent-knowledge', 'inbox', 'prd-corrections');
  const { filePath, content } = await readOnlyMarkdownFile(correctionDir);

  assert.match(content, /证据链/);
  await assertNoBom(filePath);
});

test('extractQueryKeywords expands synonyms to improve recall', () => {
  const keywords = extractQueryKeywords('队列 为空');

  assert.ok(keywords.includes('队列'));
  assert.ok(keywords.includes('排队'));
  assert.ok(keywords.includes('queue'));
});

test('extractQueryKeywords segments Chinese phrases into bigrams and expands synonyms', () => {
  const keywords = extractQueryKeywords('预习题型训练队列为空');

  assert.ok(keywords.includes('队列'));
  assert.ok(keywords.includes('排队'));
  assert.ok(keywords.includes('queue'));
});

test('query groups deduplicate synonym case variants', () => {
  const keywords = extractQueryKeywords('queue 队列 Graph graph');

  assert.equal(keywords.filter((keyword) => keyword.toLowerCase() === 'queue').length, 1);
  assert.equal(keywords.filter((keyword) => keyword.toLowerCase() === 'graph').length, 1);
  assert.ok(keywords.includes('队列'));
  assert.ok(keywords.includes('图谱'));
});

test('query groups count one synonym group once for score coverage', async () => {
  const rootDir = await createTempRoot();
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/queue.md',
    [
      '---',
      'title: Queue 限流',
      'tags: [Queue]',
      'status: confirmed',
      '---',
      '',
      '# Queue 限流',
      '',
      'Queue backlog handling.',
      '',
    ].join('\n'),
  );

  const [result] = await searchKnowledge({ rootDir, query: '队列' });

  assert.equal(result.coverage, 1);
  assert.equal(result.matched, 1);
  assert.equal(result.total, 1);
  assert.deepEqual(result.matchedTerms, ['queue']);
});

test('mustRead v2 keeps low-coverage body matches related instead of required', async () => {
  const rootDir = await createTempRoot();
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/body-only.md',
    [
      '---',
      'title: unrelated body note',
      'status: confirmed',
      '---',
      '',
      '# unrelated body note',
      '',
      'alpha beta gamma',
      '',
    ].join('\n'),
  );

  const [result] = await searchKnowledge({
    rootDir,
    query: 'alpha beta gamma delta epsilon zeta',
  });

  assert.equal(result.score, 8, 'fixture must reproduce the legacy score threshold');
  assert.equal(result.coverage, 0.5);
  assert.equal(result.mustRead, false);
  assert.equal(result.mustReadReason, 'related_low_confidence');
});

test('mustRead v2 requires a high-coverage title or frontmatter match', async () => {
  const rootDir = await createTempRoot();
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/graph-datasource.md',
    [
      '---',
      'title: graph datasource consistency',
      'tags: [graph, datasource]',
      'status: confirmed',
      '---',
      '',
      '# graph datasource consistency',
      '',
      'Keep graph ownership data consistent.',
      '',
    ].join('\n'),
  );

  const [result] = await searchKnowledge({ rootDir, query: 'graph datasource' });

  assert.equal(result.coverage, 1);
  assert.equal(result.mustRead, true);
  assert.match(result.mustReadReason, /high_coverage_(title|frontmatter)/);
  assert.ok(result.reasonCodes.includes('title'));
  assert.ok(result.reasonCodes.includes('frontmatter'));
});

test('mustRead v2 caps required knowledge at five results', async () => {
  const rootDir = await createTempRoot();
  for (let index = 1; index <= 7; index += 1) {
    await writeKnowledgeFile(
      rootDir,
      `knowledge/rules/alpha-${index}.md`,
      [
        '---',
        `title: alpha rule ${index}`,
        'tags: [alpha]',
        'status: confirmed',
        '---',
        '',
        `# alpha rule ${index}`,
        '',
        'alpha',
        '',
      ].join('\n'),
    );
  }

  const results = await searchKnowledge({ rootDir, query: 'alpha' });

  assert.equal(results.length, 7);
  assert.equal(results.filter((result) => result.mustRead).length, 5);
  assert.equal(results.filter((result) => result.mustReadReason === 'must_read_limit').length, 2);
});

test('mustRead v2 keeps a task-style weak business match out of required results', async () => {
  const rootDir = await createTempRoot();
  await writeKnowledgeFile(
    rootDir,
    'knowledge/service-map/agent-knowledge-hook.md',
    [
      '---',
      'title: 优化钩子检索性能缓存索引',
      'tags: [优化, 钩子, 检索, 性能, 缓存, 索引]',
      'status: confirmed',
      '---',
      '',
      '# 优化钩子检索性能缓存索引',
      '',
      '知识库钩子性能优化入口。',
      '',
    ].join('\n'),
  );
  await writeKnowledgeFile(
    rootDir,
    'knowledge/domain/business-project.md',
    [
      '---',
      'title: 业务项目说明',
      'status: confirmed',
      '---',
      '',
      '# 业务项目说明',
      '',
      '通用描述中偶然出现钩子、检索和性能。',
      '',
    ].join('\n'),
  );

  const results = await searchKnowledge({
    rootDir,
    query: '优化 钩子 检索 性能 缓存 索引',
  });
  const hookResult = results.find((result) => result.relativePath.endsWith('agent-knowledge-hook.md'));
  const businessResult = results.find((result) => result.relativePath.endsWith('business-project.md'));

  assert.equal(hookResult.mustRead, true);
  assert.equal(businessResult.score, 8, 'fixture must reproduce the legacy score threshold');
  assert.equal(businessResult.coverage, 0.5);
  assert.equal(businessResult.mustRead, false);
});

test('searchKnowledge ranks full-coverage title match above partial body spam and includes snippet', async () => {
  const rootDir = await createTempRoot();
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/precise.md',
    [
      '---',
      'title: 队列设计',
      'tags: [queue]',
      'status: confirmed',
      '---',
      '',
      '# 队列设计',
      '',
      '这里是队列的精确说明。',
      '',
    ].join('\n'),
  );
  await writeKnowledgeFile(
    rootDir,
    'knowledge/rules/spam.md',
    [
      '---',
      'title: 无关长文',
      'tags: [spam]',
      'status: confirmed',
      '---',
      '',
      '# 无关长文',
      '',
      '队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列 队列',
      '',
    ].join('\n'),
  );

  const results = await searchKnowledge({ rootDir, query: '队列' });
  const names = results.map((result) => path.basename(result.path));

  assert.ok(names.indexOf('precise.md') < names.indexOf('spam.md'), 'precise should rank before spam');
  assert.ok(results[0].snippet && results[0].snippet.length > 0, 'snippet should be present');
});

test('searchKnowledge flags stale knowledge files whose last_scanned_commit differs from project HEAD', async () => {
  const projectRoot = await createGitProject();
  const oldCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), '# demo\n\nchanged\n', 'utf8');
  await runGit(['add', 'README.md'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '更新',
  ], projectRoot);

  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-stale-demo.md',
    [
      '---',
      'title: stale demo',
      'status: confirmed',
      `project_root: ${projectRoot}`,
      `last_scanned_commit: ${oldCommit}`,
      '---',
      '',
      '# stale demo',
      '',
      'stale demo content',
      '',
    ].join('\n'),
  );

  const results = await searchKnowledge({ knowledgeRoot, query: 'stale demo content' });

  assert.equal(results.length, 1);
  assert.equal(results[0].stale, true);
});

test('CLI check-stale --deep reports stale when evidence file changed since last scan', async () => {
  const projectRoot = await createGitProject();
  const oldCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'foo.js'), 'console.log(1);\n', 'utf8');
  await runGit(['add', 'src/foo.js'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '新增 foo',
  ], projectRoot);

  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-deep.md',
    [
      '---',
      'title: deep demo',
      'status: confirmed',
      `project_root: ${projectRoot}`,
      `last_scanned_commit: ${oldCommit}`,
      'evidence_files: src/foo.js',
      '---',
      '',
      '# deep demo',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli([
    'check-stale',
    '--project-root',
    projectRoot,
    '--knowledge-file',
    'knowledge/domain/project-deep.md',
    '--deep',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(stdout, /深度检查/);
  assert.match(stdout, /命中 1 个/);
});

test('promote moves inbox draft into knowledge and marks confirmed', async () => {
  const knowledgeRoot = await createTempRoot();
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/draft-rule.md',
    [
      '---',
      'title: 草稿规则',
      'status: draft',
      '---',
      '',
      '# 草稿规则',
      '',
      '草稿内容',
      '',
    ].join('\n'),
  );

  const result = await promote({ knowledgeRoot, file: 'inbox/rules/draft-rule.md' });

  assert.equal(result.source, 'inbox/rules/draft-rule.md');
  assert.equal(result.target, 'knowledge/rules/draft-rule.md');
  assert.ok(existsSync(path.join(knowledgeRoot, 'knowledge', 'rules', 'draft-rule.md')));
  assert.ok(!existsSync(source), 'source inbox file should be removed');
  const content = await readFile(path.join(knowledgeRoot, 'knowledge', 'rules', 'draft-rule.md'), 'utf8');
  assert.match(content, /^status: confirmed$/m);
  assert.match(content, /草稿内容/);
});

test('promote rejects a non-empty targeted fix before any write and keeps the source unchanged', async () => {
  const knowledgeRoot = await createTempRoot();
  const sourceContent = [
    '---',
    'title: targeted correction',
    'type: tech',
    'status: pending',
    'target: knowledge/rules/formal-rule.md',
    '---',
    '',
    '# targeted correction',
    '',
    'must be merged into its target',
    '',
  ].join('\n');
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/tech-solution-corrections/targeted.md',
    sourceContent,
  );

  await assert.rejects(
    promote({ knowledgeRoot, file: 'inbox/tech-solution-corrections/targeted.md' }),
    /先修改.*resolve-fix/s,
  );

  assert.equal(await readFile(source, 'utf8'), sourceContent);
  assert.equal(existsSync(path.join(knowledgeRoot, 'knowledge')), false);
  assert.deepEqual(await readdir(path.dirname(source)), ['targeted.md']);
});

test('promote treats a blank target as independent and preserves existing promotion behavior', async () => {
  const knowledgeRoot = await createTempRoot();
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/blank-target.md',
    ['---', 'title: blank target', 'status: pending', 'target:   ', '---', '', 'independent body', ''].join('\n'),
  );

  const result = await promote({ knowledgeRoot, file: 'inbox/fixes/blank-target.md' });

  assert.equal(result.target, 'knowledge/fixes/blank-target.md');
  assert.equal(existsSync(source), false);
  assert.match(
    await readFile(path.join(knowledgeRoot, 'knowledge', 'fixes', 'blank-target.md'), 'utf8'),
    /independent body/,
  );
});

test('promote rejects files outside inbox', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/already.md',
    ['---', 'title: x', 'status: confirmed', '---', '', 'x', ''].join('\n'),
  );

  await assert.rejects(
    promote({ knowledgeRoot, file: 'knowledge/rules/already.md' }),
    /inbox/,
  );
});

test('promote rejects existing knowledge target without removing source', async () => {
  const knowledgeRoot = await createTempRoot();
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/same.md',
    ['---', 'title: draft', 'status: draft', '---', '', 'draft body', ''].join('\n'),
  );
  const target = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/same.md',
    ['---', 'title: existing', 'status: confirmed', '---', '', 'existing body', ''].join('\n'),
  );

  await assert.rejects(
    promote({ knowledgeRoot, file: 'inbox/rules/same.md' }),
    /target already exists/,
  );

  assert.ok(existsSync(source), 'source inbox file should remain when target exists');
  assert.match(await readFile(target, 'utf8'), /existing body/);
});

test('promote publishes at most once when the same source is promoted concurrently', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/concurrent.md',
    ['---', 'title: concurrent', 'status: draft', '---', '', 'concurrent body', ''].join('\n'),
  );

  const results = await Promise.allSettled([
    promote({ knowledgeRoot, file: 'inbox/rules/concurrent.md' }),
    promote({ knowledgeRoot, file: 'inbox/rules/concurrent.md' }),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const targetDir = path.join(knowledgeRoot, 'knowledge', 'rules');
  assert.deepEqual(await readdir(targetDir), ['concurrent.md']);
  assert.match(await readFile(path.join(targetDir, 'concurrent.md'), 'utf8'), /concurrent body/);
});

test('promote keeps its source and removes its temp file when exclusive publish fails', async () => {
  const knowledgeRoot = await createTempRoot();
  const source = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/publish-failure.md',
    ['---', 'title: failure', 'status: draft', '---', '', 'source body', ''].join('\n'),
  );
  const publishError = new Error('publish failed');

  await assert.rejects(
    promote({
      knowledgeRoot,
      file: 'inbox/rules/publish-failure.md',
      linkFile: async () => {
        throw publishError;
      },
    }),
    (error) => error === publishError,
  );

  assert.match(await readFile(source, 'utf8'), /source body/);
  const targetDir = path.join(knowledgeRoot, 'knowledge', 'rules');
  assert.deepEqual(await readdir(targetDir), []);
});

test('listPending lists inbox items with status and type', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/draft.md',
    ['---', 'title: d', 'status: draft', '---', '', 'x', ''].join('\n'),
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/fixes/bug.md',
    ['---', 'title: b', 'type: bug', 'status: pending', '---', '', 'y', ''].join('\n'),
  );

  const items = await listPending({ knowledgeRoot });

  assert.equal(items.length, 2);
  const draft = items.find((item) => item.relativePath === 'inbox/rules/draft.md');
  assert.ok(draft);
  assert.equal(draft.status, 'draft');
  const bug = items.find((item) => item.relativePath === 'inbox/fixes/bug.md');
  assert.ok(bug);
  assert.equal(bug.status, 'pending');
  assert.equal(bug.type, 'bug');
  assert.ok(bug.mtime);
});

test('listPending ignores inbox documentation files', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/README.md',
    ['# inbox', '', 'Documentation for pending knowledge.', ''].join('\n'),
  );

  const items = await listPending({ knowledgeRoot });

  assert.deepEqual(items, []);
});

test('CLI promote moves inbox file into knowledge', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/cli-draft.md',
    ['---', 'title: c', 'status: draft', '---', '', 'c', ''].join('\n'),
  );

  const { stdout } = await runCli([
    'promote',
    '--file',
    'inbox/rules/cli-draft.md',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.match(stdout, /已晋升/);
  assert.ok(existsSync(path.join(knowledgeRoot, 'knowledge', 'rules', 'cli-draft.md')));
  assert.ok(!existsSync(path.join(knowledgeRoot, 'inbox', 'rules', 'cli-draft.md')));
});

test('CLI list-pending lists inbox drafts', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/rules/cli-pending.md',
    ['---', 'title: p', 'status: draft', '---', '', 'p', ''].join('\n'),
  );

  const { stdout } = await runCli(['list-pending', '--knowledge-root', knowledgeRoot]);

  assert.match(stdout, /待确认知识清单/);
  assert.match(stdout, /inbox\/rules\/cli-pending\.md/);
});

test('CLI search --json outputs parseable JSON with mustRead v2 explanation fields', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-g.md',
    [
      '---',
      'title: g',
      'status: confirmed',
      '---',
      '',
      '# g',
      '',
      'graph-service owns entity graph.',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli([
    'search',
    'graph-service',
    '--json',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.command, 'search');
  assert.ok(Array.isArray(parsed.results));
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].mustRead, true);
  assert.deepEqual(parsed.keywords, parsed.expandedTerms);
  assert.ok(parsed.queryTerms.includes('graph'));
  assert.ok(parsed.expandedTerms.includes('graph'));
  assert.ok(parsed.results[0].matchedTerms.includes('graph'));
  assert.ok(parsed.results[0].reasonCodes.includes('body'));
  assert.match(parsed.results[0].mustReadReason, /high_coverage/);
});

test('CLI check-stale --json outputs parseable JSON', async () => {
  const projectRoot = await createGitProject();
  const oldCommit = await runGit(['rev-parse', 'HEAD'], projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), '# demo\n\nchanged\n', 'utf8');
  await runGit(['add', 'README.md'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '更新',
  ], projectRoot);
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/domain/project-j.md',
    [
      '---',
      'title: j',
      'status: confirmed',
      `project_root: ${projectRoot}`,
      `last_scanned_commit: ${oldCommit}`,
      '---',
      '',
      '# j',
      '',
    ].join('\n'),
  );

  const { stdout } = await runCli([
    'check-stale',
    '--project-root',
    projectRoot,
    '--knowledge-file',
    'knowledge/domain/project-j.md',
    '--json',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.command, 'check-stale');
  assert.equal(parsed.stale, true);
});

const expectedMinimalCiWorkflow = [
  'name: Agent Knowledge CI',
  '',
  'on:',
  '  push:',
  '  pull_request:',
  '',
  'permissions:',
  '  contents: read',
  '',
  'defaults:',
  '  run:',
  '    working-directory: agent-knowledge',
  '',
  'jobs:',
  '  verify:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: Check out repository',
  '        uses: actions/checkout@v6',
  '        with:',
  '          persist-credentials: false',
  '      - name: Set up Node.js',
  '        uses: actions/setup-node@v6',
  '        with:',
  "          node-version: 'lts/*'",
  '          package-manager-cache: false',
  '      - name: Run tests',
  '        run: npm test',
  '      - name: Check generated command documentation',
  '        run: node bin/agent-knowledge.js sync-command-docs --check --repository-root ..',
  '      - name: Check generated adapters',
  '        run: node bin/agent-knowledge.js sync-adapters --check --repository-root ..',
  '      - name: Check bundled knowledge base',
  '        run: node bin/agent-knowledge.js doctor --repository-root ..',
  '',
].join('\n');

function assertMinimalCiWorkflow(content) {
  assert.match(content, /^on:\r?\n {2}push:\r?\n {2}pull_request:/m);
  assert.match(content, /^permissions:\r?\n {2}contents: read$/m);
  assert.match(content, /^ {4}runs-on: ubuntu-latest$/m);
  assert.match(
    content,
    /^defaults:\r?\n {2}run:\r?\n {4}working-directory: agent-knowledge$/m,
  );
  assert.match(
    content,
    /uses: actions\/checkout@v6\r?\n\s+with:\r?\n\s+persist-credentials: false/,
  );
  assert.match(
    content,
    /uses: actions\/setup-node@v6\r?\n\s+with:\r?\n\s+node-version: 'lts\/\*'\r?\n\s+package-manager-cache: false/,
  );

  const commands = [...content.matchAll(/^[ \t]+run:[ \t]+(\S.*)$/gm)].map((match) => match[1]);
  assert.deepEqual(commands, [
    'npm test',
    'node bin/agent-knowledge.js sync-command-docs --check --repository-root ..',
    'node bin/agent-knowledge.js sync-adapters --check --repository-root ..',
    'node bin/agent-knowledge.js doctor --repository-root ..',
  ]);
  assert.deepEqual(
    [...content.matchAll(/uses:\s+(\S+)/g)].map((match) => match[1]),
    ['actions/checkout@v6', 'actions/setup-node@v6'],
  );
  assert.doesNotMatch(content, /^\s+[\w-]+:\s+write\s*$/m);
  assert.doesNotMatch(content, /\b(?:npm|pnpm|yarn)\s+(?:ci|install)\b/i);
  assert.doesNotMatch(
    content,
    /--knowledge-root|team-agent-knowledge|AGENT_KNOWLEDGE_ROOT|continue-on-error/i,
  );
  assert.doesNotMatch(content, /\b(?:curl|wget|Invoke-WebRequest)\b/i);
  assert.equal(
    content.replace(/\r\n?/g, '\n'),
    expectedMinimalCiWorkflow,
    'GitHub Actions workflow 必须完整匹配最小只读契约',
  );
}

test('GitHub Actions workflow enforces the minimal read-only CI contract', async () => {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'agent-knowledge-ci.yml');
  const content = await readFile(workflowPath, 'utf8');

  assertMinimalCiWorkflow(content);
});

test('GitHub Actions workflow contract rejects job write-all permissions and skipped jobs', async () => {
  const workflowPath = path.join(repoRoot, '.github', 'workflows', 'agent-knowledge-ci.yml');
  const content = await readFile(workflowPath, 'utf8');
  const maliciousContent = content.replace(
    /( {2}verify:\r?\n)/,
    '$1    permissions: write-all\n    if: false\n',
  );

  assert.notEqual(maliciousContent, content);
  assert.throws(
    () => assertMinimalCiWorkflow(maliciousContent),
    /必须完整匹配最小只读契约/,
  );
});
