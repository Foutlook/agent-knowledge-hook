import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  addRule,
  extractKeywords,
  extractQueryKeywords,
  listPending,
  promote,
  recordFix,
  searchKnowledge,
} from '../bin/agent-knowledge.js';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(testDir, '..', 'bin', 'agent-knowledge.js');
const repoRoot = path.resolve(testDir, '..', '..');

async function createTempRoot() {
  return mkdtemp(path.join(tmpdir(), 'agent-knowledge-test-'));
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

function resultPath(result) {
  if (typeof result === 'string') {
    return result;
  }

  return result.path ?? result.filePath ?? result.file;
}

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

test('recordFix writes to separated private knowledge repository inbox and reads packaged templates', async () => {
  const knowledgeRoot = await createTempRoot();

  await recordFix({
    knowledgeRoot,
    type: 'bug',
    title: '私有知识库纠错记录',
  });

  const fixDir = path.join(knowledgeRoot, 'inbox', 'fixes');
  const { filePath, content } = await readOnlyMarkdownFile(fixDir);

  assert.match(content, /私有知识库纠错记录/);
  assert.match(content, /证据链/);
  await assertNoBom(filePath);
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

test('CLI search --json outputs parseable JSON with mustRead flags', async () => {
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
