import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { syncAdapters } from '../bin/agent-knowledge.js';
import * as agentKnowledgeModule from '../bin/agent-knowledge.js';
import {
  adapterFileNames,
  assertNoBom,
  createTempRoot,
  execFileAsync,
  repoRoot,
  runCli,
  runCliFailure,
  writeAdapterTemplates,
} from './test-helpers.js';

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
