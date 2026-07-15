import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import * as agentKnowledgeModule from '../bin/agent-knowledge.js';
import { isRfc4122Uuid } from '../lib/locks.js';
import * as targetedFixContract from '../lib/targeted-fix-contract.js';
import {
  createGitProject,
  createTempRoot,
  execFileAsync,
  runCliFailure,
  writeExternalKnowledgeFile,
} from './test-helpers.js';

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

  assert.deepEqual(Object.keys(targetedFixContract).sort(), [
    'getTargetedFixCategory',
    'isTargetedFixCategory',
  ]);
  for (const [type, category] of [
    ['bug', 'fixes'],
    ['prd', 'prd-corrections'],
    ['tech', 'tech-solution-corrections'],
  ]) {
    assert.equal(targetedFixContract.getTargetedFixCategory(type), category);
    assert.equal(targetedFixContract.isTargetedFixCategory(category), true);
  }
  assert.equal(targetedFixContract.getTargetedFixCategory('unknown'), undefined);
  assert.equal(targetedFixContract.isTargetedFixCategory('unknown'), false);

  const validUuid = '123E4567-E89B-12D3-A456-426614174000';
  assert.equal(isRfc4122Uuid(validUuid), true);
  assert.equal(isRfc4122Uuid({ toString: () => validUuid }), true);
  assert.equal(isRfc4122Uuid(''), false);
  assert.equal(isRfc4122Uuid(null), false);
  assert.equal(isRfc4122Uuid(undefined), false);
  assert.equal(isRfc4122Uuid(123), false);
});

test('bin entry import has no CLI side effects', async () => {
  const entryUrl = new URL('../bin/agent-knowledge.js', import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    '--input-type=module',
    '--eval',
    `await import(${JSON.stringify(entryUrl)});`,
  ], {
    encoding: 'utf8',
    timeout: 5000,
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
