import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { extractKeywords, extractQueryKeywords, searchKnowledge } from '../bin/agent-knowledge.js';
import { getQueryMetadata } from '../lib/retrieval.js';
import {
  createGitProject,
  createTempRoot,
  repoRoot,
  runCli,
  runGit,
  writeExternalKnowledgeFile,
} from './test-helpers.js';

async function writeKnowledgeFile(rootDir, relativePath, content) {
  const filePath = path.join(rootDir, 'agent-knowledge', relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
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

test('extractQueryKeywords expands synonyms to improve recall', () => {
  const keywords = extractQueryKeywords('队列 为空');
  const metadata = getQueryMetadata('队列 为空');

  assert.ok(keywords.includes('队列'));
  assert.ok(keywords.includes('排队'));
  assert.ok(keywords.includes('queue'));
  assert.deepEqual(metadata.keywords, keywords);
  assert.deepEqual(metadata.expandedTerms, keywords);
  assert.deepEqual(metadata.queryTerms, extractKeywords('队列 为空'));
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
