import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  addRule,
  checkStale,
  listPending,
  promote,
  recordFix,
  refreshProject,
} from '../bin/agent-knowledge.js';
import * as agentKnowledgeModule from '../bin/agent-knowledge.js';
import {
  assertNoBom,
  cliPath,
  createDirectoryLink,
  createExitedProcessPid,
  createGitProject,
  createTempRoot,
  execFileAsync,
  runCli,
  runCliFailure,
  runGit,
  writeExternalKnowledgeFile,
} from './test-helpers.js';

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
