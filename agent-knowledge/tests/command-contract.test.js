import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  loadCommandContract,
  renderAkBasicUsage,
  renderAkCommandTable,
  renderCliCommandList,
  renderCliCommandTable,
  renderCliUsage,
  replaceGeneratedBlock,
  validateCommandContract,
} from '../lib/command-contract.js';

const cliCommandNames = [
  'before-task',
  'search',
  'add-rule',
  'record-fix',
  'check-stale',
  'refresh-project',
  'resolve-fix',
  'promote',
  'list-pending',
  'sync-adapters',
  'doctor',
  'sync-command-docs',
];

const akCommandNames = [
  'task',
  'search',
  'projects',
  'check',
  'refresh',
  'bug',
  'prd',
  'tech',
  'rule',
  'promote',
  'resolve',
  'pending',
  'adapters',
  'doctor',
  'raw',
];

const cliEntryPath = fileURLToPath(new URL('../bin/agent-knowledge.js', import.meta.url));
const blockBegin = '<!-- BEGIN GENERATED: TEST_BLOCK -->';
const blockEnd = '<!-- END GENERATED: TEST_BLOCK -->';

test('生成区块保持 LF 且标记外内容逐字节不变', () => {
  const source = `前缀\n${blockBegin}\n旧内容\n${blockEnd}\n后缀\n`;

  assert.deepEqual(replaceGeneratedBlock(source, 'TEST_BLOCK', '第一行\n第二行'), {
    content: `前缀\n${blockBegin}\n第一行\n第二行\n${blockEnd}\n后缀\n`,
    changed: true,
  });
});

test('生成区块保持 CRLF', () => {
  const source = `前缀\r\n${blockBegin}\r\n旧内容\r\n${blockEnd}\r\n后缀\r\n`;

  assert.deepEqual(replaceGeneratedBlock(source, 'TEST_BLOCK', '第一行\n第二行'), {
    content: `前缀\r\n${blockBegin}\r\n第一行\r\n第二行\r\n${blockEnd}\r\n后缀\r\n`,
    changed: true,
  });
});

test('生成区块重复替换保持字节级幂等', () => {
  const source = `前缀\n${blockBegin}\n旧内容\n${blockEnd}\n后缀`;
  const first = replaceGeneratedBlock(source, 'TEST_BLOCK', '新内容');
  const second = replaceGeneratedBlock(first.content, 'TEST_BLOCK', '新内容');

  assert.equal(second.content, first.content);
  assert.equal(second.changed, false);
});

const invalidGeneratedBlockCases = [
  {
    name: '拒绝缺失标记',
    source: '没有生成标记\n',
    error: /TEST_BLOCK.*缺失/u,
  },
  {
    name: '拒绝重复开始标记',
    source: `${blockBegin}\n${blockBegin}\n内容\n${blockEnd}\n`,
    error: /TEST_BLOCK.*重复/u,
  },
  {
    name: '拒绝重复结束标记',
    source: `${blockBegin}\n内容\n${blockEnd}\n${blockEnd}\n`,
    error: /TEST_BLOCK.*重复/u,
  },
  {
    name: '拒绝颠倒标记',
    source: `${blockEnd}\n内容\n${blockBegin}\n`,
    error: /TEST_BLOCK.*颠倒/u,
  },
  {
    name: '拒绝生成标记嵌套',
    source: `${blockBegin}\n<!-- BEGIN GENERATED: OTHER_BLOCK -->\n内容\n${blockEnd}\n<!-- END GENERATED: OTHER_BLOCK -->\n`,
    error: /嵌套/u,
  },
  {
    name: '拒绝混合换行',
    source: `${blockBegin}\r\n内容\n${blockEnd}\r\n`,
    error: /混合换行/u,
  },
];

for (const { name, source, error } of invalidGeneratedBlockCases) {
  test(name, () => {
    assert.throws(() => replaceGeneratedBlock(source, 'TEST_BLOCK', '新内容'), error);
  });
}

const commandDocTargets = [
  {
    relativePath: 'README.md',
    blocks: [
      ['AK_COMMAND_TABLE', renderAkCommandTable],
      ['CLI_COMMAND_TABLE', renderCliCommandTable],
    ],
  },
  {
    relativePath: 'agent-knowledge/README.md',
    blocks: [
      ['AK_COMMAND_TABLE', renderAkCommandTable],
      ['CLI_COMMAND_LIST', renderCliCommandList],
    ],
  },
  {
    relativePath: 'agent-knowledge/help/ak.zh-CN.txt',
    blocks: [
      ['AK_COMMAND_TABLE', renderAkCommandTable],
    ],
  },
];

function createMarkedDocument(blocks, content = '旧内容') {
  return [
    '标记前内容',
    ...blocks.flatMap(([blockName]) => [
      `<!-- BEGIN GENERATED: ${blockName} -->`,
      content,
      `<!-- END GENERATED: ${blockName} -->`,
    ]),
    '标记后内容',
    '',
  ].join('\n');
}

function renderMarkedDocument(source, blocks, contract) {
  let content = source;
  for (const [blockName, render] of blocks) {
    content = replaceGeneratedBlock(content, blockName, render(contract)).content;
  }
  return content;
}

async function createCommandDocRepository(t, { currentTargets = [], invalidTarget = '' } = {}) {
  const repositoryRoot = await mkdtemp(path.join(tmpdir(), 'agent-knowledge-command-docs-'));
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  const contract = await loadCommandContract();
  const files = new Map();

  for (const target of commandDocTargets) {
    const filePath = path.join(repositoryRoot, ...target.relativePath.split('/'));
    await mkdir(path.dirname(filePath), { recursive: true });
    let content = createMarkedDocument(target.blocks);
    if (currentTargets.includes(target.relativePath)) {
      content = renderMarkedDocument(content, target.blocks, contract);
    }
    if (invalidTarget === target.relativePath) {
      content = content.replace(`<!-- END GENERATED: ${target.blocks.at(-1)[0]} -->`, '非法结束标记');
    }
    await writeFile(filePath, content, 'utf8');
    files.set(target.relativePath, { filePath, content, target });
  }

  return { repositoryRoot, contract, files };
}

function runSyncCommandDocs(repositoryRoot, ...args) {
  return spawnSync(process.execPath, [
    cliEntryPath,
    'sync-command-docs',
    ...args,
    '--repository-root',
    repositoryRoot,
  ], { encoding: 'utf8' });
}

async function snapshotTree(root) {
  const snapshot = [];
  async function visit(currentPath) {
    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = path.join(currentPath, entry.name);
      const relativePath = path.relative(root, entryPath).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        snapshot.push({ path: `${relativePath}/`, type: 'directory' });
        await visit(entryPath);
      } else {
        snapshot.push({
          path: relativePath,
          type: 'file',
          content: (await readFile(entryPath)).toString('base64'),
        });
      }
    }
  }
  await visit(root);
  return snapshot;
}

function comparableStat(fileStat) {
  return {
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    birthtimeMs: fileStat.birthtimeMs,
  };
}

test('sync-command-docs --check 报告全部漂移且完全只读', async (t) => {
  const { repositoryRoot } = await createCommandDocRepository(t);
  const before = await snapshotTree(repositoryRoot);

  const result = runSyncCommandDocs(repositoryRoot, '--check');

  assert.equal(result.status, 1);
  for (const target of commandDocTargets) {
    for (const [blockName] of target.blocks) {
      assert.match(result.stderr, new RegExp(`${target.relativePath.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}.*${blockName}`, 'u'));
    }
  }
  assert.deepEqual(await snapshotTree(repositoryRoot), before);
});

test('sync-command-docs 只写漂移文件且再次运行不写入', async (t) => {
  const currentTargets = commandDocTargets.slice(1).map(({ relativePath }) => relativePath);
  const { repositoryRoot, contract, files } = await createCommandDocRepository(t, { currentTargets });
  const stableStatsBefore = new Map();
  for (const relativePath of currentTargets) {
    stableStatsBefore.set(relativePath, comparableStat(await stat(files.get(relativePath).filePath)));
  }

  const first = runSyncCommandDocs(repositoryRoot);

  assert.equal(first.status, 0, first.stderr);
  const changedTarget = files.get('README.md');
  assert.equal(
    await readFile(changedTarget.filePath, 'utf8'),
    renderMarkedDocument(changedTarget.content, changedTarget.target.blocks, contract),
  );
  for (const relativePath of currentTargets) {
    assert.deepEqual(
      comparableStat(await stat(files.get(relativePath).filePath)),
      stableStatsBefore.get(relativePath),
    );
  }

  const treeAfterFirst = await snapshotTree(repositoryRoot);
  const statsAfterFirst = new Map();
  for (const { relativePath } of commandDocTargets) {
    statsAfterFirst.set(relativePath, comparableStat(await stat(files.get(relativePath).filePath)));
  }
  const second = runSyncCommandDocs(repositoryRoot);

  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(await snapshotTree(repositoryRoot), treeAfterFirst);
  for (const { relativePath } of commandDocTargets) {
    assert.deepEqual(
      comparableStat(await stat(files.get(relativePath).filePath)),
      statsAfterFirst.get(relativePath),
    );
  }
});

test('sync-command-docs 预检任一非法目标后不发生部分写入', async (t) => {
  const { repositoryRoot } = await createCommandDocRepository(t, {
    invalidTarget: 'agent-knowledge/README.md',
  });
  const before = await snapshotTree(repositoryRoot);

  const result = runSyncCommandDocs(repositoryRoot);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /agent-knowledge\/README\.md.*标记/u);
  assert.deepEqual(await snapshotTree(repositoryRoot), before);
});

const invalidSyncCommandDocsArgs = [
  { name: '拒绝位置参数', args: ['extra'], error: /位置参数.*extra/u },
  { name: '拒绝重复 --check', args: ['--check', '--check'], error: /--check.*一次/u },
  { name: '拒绝未知参数', args: ['--unknown'], error: /未知参数.*--unknown/u },
  { name: '拒绝 --knowledge-root', args: ['--knowledge-root', 'unused'], error: /--knowledge-root/u },
  { name: '拒绝 --json', args: ['--json'], error: /--json/u },
];

for (const { name, args, error } of invalidSyncCommandDocsArgs) {
  test(`sync-command-docs ${name}`, async (t) => {
    const { repositoryRoot } = await createCommandDocRepository(t);

    const result = runSyncCommandDocs(repositoryRoot, ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  });
}

test('sync-command-docs 拒绝缺少 --repository-root', () => {
  const result = spawnSync(process.execPath, [cliEntryPath, 'sync-command-docs'], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /需要.*--repository-root/u);
});

test('sync-command-docs 拒绝重复 --repository-root', async (t) => {
  const { repositoryRoot } = await createCommandDocRepository(t);
  const result = runSyncCommandDocs(repositoryRoot, '--repository-root', repositoryRoot);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--repository-root.*一次/u);
});

function findMatchingDelimiter(source, openingIndex, opening, closing) {
  let depth = 0;
  let state = 'code';

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (character === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      if (character === '*' && next === '/') {
        state = 'code';
        index += 1;
      }
      continue;
    }
    if (state === 'single-quote' || state === 'double-quote' || state === 'template') {
      if (character === '\\') {
        index += 1;
        continue;
      }
      if ((state === 'single-quote' && character === "'")
          || (state === 'double-quote' && character === '"')
          || (state === 'template' && character === '`')) {
        state = 'code';
      }
      continue;
    }
    if (character === '/' && next === '/') {
      state = 'line-comment';
      index += 1;
      continue;
    }
    if (character === '/' && next === '*') {
      state = 'block-comment';
      index += 1;
      continue;
    }
    if (character === "'") {
      state = 'single-quote';
      continue;
    }
    if (character === '"') {
      state = 'double-quote';
      continue;
    }
    if (character === '`') {
      state = 'template';
      continue;
    }
    if (character === opening) depth += 1;
    if (character === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(`未找到匹配的 ${closing}`);
}

function extractTopLevelCommandRoutes(source) {
  const mainStart = source.indexOf('async function main(');
  assert.notEqual(mainStart, -1, '必须存在 async function main');
  const bodyStart = source.indexOf('{', mainStart);
  const bodyEnd = findMatchingDelimiter(source, bodyStart, '{', '}');
  const body = source.slice(bodyStart + 1, bodyEnd);
  const routes = [];
  let depth = 0;

  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '{') {
      depth += 1;
      continue;
    }
    if (body[index] === '}') {
      depth -= 1;
      continue;
    }
    if (depth !== 0) continue;

    if (/\bswitch\s*\(\s*command\s*\)/u.test(body.slice(index))) {
      throw new Error('未知路由结构：switch (command)，请同步更新契约测试');
    }

    const rest = body.slice(index);
    const ifMatch = rest.match(/^\s*if\s*\(/u);
    if (!ifMatch) continue;
    const conditionStart = index + ifMatch[0].lastIndexOf('(');
    const conditionEnd = findMatchingDelimiter(body, conditionStart, '(', ')');
    const condition = body.slice(conditionStart + 1, conditionEnd).trim();
    index = conditionEnd;

    if (condition === "!command || command === '--help' || command === '-h'") {
      continue;
    }
    const routeMatch = condition.match(/^command === '([a-z0-9]+(?:-[a-z0-9]+)*)'$/u);
    if (!routeMatch) {
      if (/\bcommand\b/u.test(condition)) {
        throw new Error(`未知路由结构：${condition}，请同步更新契约测试`);
      }
      continue;
    }
    routes.push(routeMatch[1]);
  }

  const topLevelWithoutAllowedIfs = body.replace(
    /^\s*if\s*\(\s*(?:!command\s*\|\|\s*command\s*===\s*'--help'\s*\|\|\s*command\s*===\s*'-h'|command\s*===\s*'[a-z0-9]+(?:-[a-z0-9]+)*')\s*\)/gmu,
    'if (true)',
  );
  if (/\bswitch\s*\(\s*command\s*\)|\b\w+\s*\[\s*command\s*\]\s*\(/u.test(topLevelWithoutAllowedIfs)) {
    throw new Error('未知路由结构：检测到未登记的 command 顶层分发，请同步更新契约测试');
  }

  return routes;
}

function assertRouteContractEqual(actualRoutes, contractRoutes) {
  assert.deepEqual(new Set(actualRoutes), new Set(contractRoutes));
}

test('CLI 帮助命令顺序来自契约且同步命令只出现一次', async () => {
  const contract = await loadCommandContract();
  const result = spawnSync(process.execPath, [cliEntryPath, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const helpCommands = result.stdout
    .split(/\r?\n/u)
    .filter((line) => /^  [a-z0-9]/u.test(line))
    .map((line) => line.trimStart().match(/^([a-z0-9-]+)/u)[1]);
  assert.deepEqual(helpCommands, contract.cliCommands.map(({ name }) => name));
  assert.equal(result.stdout.match(/\bsync-command-docs\b/gu)?.length, 1);
});

test('Node 顶层命令路由与契约双向一致', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(cliEntryPath, 'utf8'),
  ]);

  assertRouteContractEqual(
    extractTopLevelCommandRoutes(source),
    contract.cliCommands.map(({ name }) => name),
  );
});

test('路由一致性检查拒绝源码多出的命令', () => {
  assert.throws(
    () => assertRouteContractEqual(['known', 'extra'], ['known']),
    assert.AssertionError,
  );
});

test('路由一致性检查拒绝契约多出的命令', () => {
  assert.throws(
    () => assertRouteContractEqual(['known'], ['known', 'missing']),
    assert.AssertionError,
  );
});

test('路由提取器拒绝 switch 或查表式顶层分发', () => {
  const switchSource = `async function main(argv) {
    const [command] = argv;
    switch (command) { case 'known': return 0; }
  }`;
  const lookupSource = `async function main(argv) {
    const [command] = argv;
    routes[command]();
  }`;

  assert.throws(() => extractTopLevelCommandRoutes(switchSource), /未知路由结构.*同步更新契约测试/u);
  assert.throws(() => extractTopLevelCommandRoutes(lookupSource), /未知路由结构.*同步更新契约测试/u);
});

test('真实命令契约按登记顺序加载', async () => {
  const contract = await loadCommandContract();

  assert.equal(contract.version, 1);
  assert.deepEqual(contract.cliCommands.map(({ name }) => name), cliCommandNames);
  assert.deepEqual(contract.akCommands.map(({ name }) => name), akCommandNames);
});

test('渲染 CLI 帮助命令行', async () => {
  const contract = await loadCommandContract();

  assert.equal(renderCliUsage(contract), [
    '  before-task <text>  输出任务前知识提示',
    '  search <text>  搜索知识库',
    '  add-rule <title> [--confirmed]  新增规则草稿或确认规则',
    '  record-fix --type <bug|prd|tech> --title <title> [--target <path>]  记录修复经验',
    '  check-stale --project-root <path> --knowledge-file <path> [--deep]  检查知识条目是否落后于项目 HEAD（--deep 比对 evidence_files）',
    '  refresh-project --project-root <path> --knowledge-file <path> [--summary <text>]  刷新项目知识元数据',
    '  resolve-fix --file <path> [--confirm-legacy]  校验 targeted fix 已合并并归档审计工件',
    '  promote --file <path>  将 inbox 待确认条目晋升到 knowledge（status 改为 confirmed）',
    '  list-pending  列出 inbox 下所有待确认条目',
    '  sync-adapters [--check]  同步或检查 OpenCode 命令适配器',
    '  doctor [--json]  只读检查知识库结构、引用、证据与适配器漂移',
    '  sync-command-docs [--check] --repository-root <path>  同步或检查生成的命令文档',
  ].join('\n'));
});

test('渲染 ak 基础使用文本', async () => {
  const contract = await loadCommandContract();

  assert.equal(renderAkBasicUsage(contract), [
    'ak: agent-knowledge short commands',
    '',
    'Commands:',
    '  ak task <任务描述>  任务开始前检索相关知识',
    '  ak search <关键词>  主动搜索知识库',
    '  ak projects  列出知识库项目索引中的项目',
    '  ak check <项目名>  检查项目知识文件是否落后于项目当前 HEAD',
    '  ak refresh <项目名> [说明]  刷新项目知识文件的元数据和刷新记录',
    '  ak bug <标题> [--target <文件>]  记录 BUG 纠错到 inbox',
    '  ak prd <标题> [--target <文件>]  记录 PRD 纠偏到 inbox',
    '  ak tech <标题> [--target <文件>]  记录技术方案纠偏到 inbox',
    '  ak rule <规则标题> [--confirmed]  新增规则草稿或确认规则',
    '  ak promote <inbox文件>  晋升普通草稿或不带 target 的独立 fix',
    '  ak resolve <文件> [--confirm-legacy]  确认 targeted fix 已合入目标并归档审计',
    '  ak pending  列出 inbox 下待确认条目',
    '  ak adapters [--check]  同步或只读检查 OpenCode 命令适配器',
    '  ak doctor [--json]  检查知识库结构、引用、证据和适配器漂移',
    '  ak raw <原始参数>  透传到底层 agent-knowledge CLI',
  ].join('\n'));
});

test('渲染 ak 命令 Markdown 表格', async () => {
  const contract = await loadCommandContract();

  assert.equal(renderAkCommandTable(contract), [
    '| 短命令 | 作用 |',
    '| --- | --- |',
    '| `ak task <任务描述>` | 任务开始前检索相关知识 |',
    '| `ak search <关键词>` | 主动搜索知识库 |',
    '| `ak projects` | 列出知识库项目索引中的项目 |',
    '| `ak check <项目名>` | 检查项目知识文件是否落后于项目当前 HEAD |',
    '| `ak refresh <项目名> [说明]` | 刷新项目知识文件的元数据和刷新记录 |',
    '| `ak bug <标题> [--target <文件>]` | 记录 BUG 纠错到 inbox |',
    '| `ak prd <标题> [--target <文件>]` | 记录 PRD 纠偏到 inbox |',
    '| `ak tech <标题> [--target <文件>]` | 记录技术方案纠偏到 inbox |',
    '| `ak rule <规则标题> [--confirmed]` | 新增规则草稿或确认规则 |',
    '| `ak promote <inbox文件>` | 晋升普通草稿或不带 target 的独立 fix |',
    '| `ak resolve <文件> [--confirm-legacy]` | 确认 targeted fix 已合入目标并归档审计 |',
    '| `ak pending` | 列出 inbox 下待确认条目 |',
    '| `ak adapters [--check]` | 同步或只读检查 OpenCode 命令适配器 |',
    '| `ak doctor [--json]` | 检查知识库结构、引用、证据和适配器漂移 |',
    '| `ak raw <原始参数>` | 透传到底层 agent-knowledge CLI |',
  ].join('\n'));
});

test('渲染 CLI 命令 Markdown 表格并转义竖线', async () => {
  const contract = await loadCommandContract();

  assert.equal(renderCliCommandTable(contract), [
    '| 命令 | 什么时候用 | 是否写文件 |',
    '| --- | --- | --- |',
    '| `before-task <text>` | 输出任务前知识提示 | 否 |',
    '| `search <text>` | 搜索知识库 | 否 |',
    '| `add-rule <title> [--confirmed]` | 新增规则草稿或确认规则 | 是 |',
    '| `record-fix --type <bug\\|prd\\|tech> --title <title> [--target <path>]` | 记录修复经验 | 是 |',
    '| `check-stale --project-root <path> --knowledge-file <path> [--deep]` | 检查知识条目是否落后于项目 HEAD（--deep 比对 evidence_files） | 否 |',
    '| `refresh-project --project-root <path> --knowledge-file <path> [--summary <text>]` | 刷新项目知识元数据 | 是 |',
    '| `resolve-fix --file <path> [--confirm-legacy]` | 校验 targeted fix 已合并并归档审计工件 | 是 |',
    '| `promote --file <path>` | 将 inbox 待确认条目晋升到 knowledge（status 改为 confirmed） | 是 |',
    '| `list-pending` | 列出 inbox 下所有待确认条目 | 否 |',
    '| `sync-adapters [--check]` | 同步或检查 OpenCode 命令适配器 | 视参数而定 |',
    '| `doctor [--json]` | 只读检查知识库结构、引用、证据与适配器漂移 | 否 |',
    '| `sync-command-docs [--check] --repository-root <path>` | 同步或检查生成的命令文档 | 视参数而定 |',
  ].join('\n'));
});

test('渲染 CLI 命令代码清单', async () => {
  const contract = await loadCommandContract();

  assert.equal(renderCliCommandList(contract), [
    '```text',
    'agent-knowledge before-task <text>',
    'agent-knowledge search <text>',
    'agent-knowledge add-rule <title> [--confirmed]',
    'agent-knowledge record-fix --type <bug|prd|tech> --title <title> [--target <path>]',
    'agent-knowledge check-stale --project-root <path> --knowledge-file <path> [--deep]',
    'agent-knowledge refresh-project --project-root <path> --knowledge-file <path> [--summary <text>]',
    'agent-knowledge resolve-fix --file <path> [--confirm-legacy]',
    'agent-knowledge promote --file <path>',
    'agent-knowledge list-pending',
    'agent-knowledge sync-adapters [--check]',
    'agent-knowledge doctor [--json]',
    'agent-knowledge sync-command-docs [--check] --repository-root <path>',
    '```',
  ].join('\n'));
});

function createValidContract() {
  return {
    version: 1,
    cliCommands: [{
      id: 'base-command',
      name: 'base-command',
      args: '<value|other>',
      summary: '合法命令',
      writeMode: 'never',
      jsonOutput: false,
    }],
    akCommands: [{
      id: 'short',
      name: 'short',
      args: '<值|其它>',
      summary: '合法短命令',
      writeMode: 'never',
      jsonOutput: false,
      aliases: ['s'],
      mapsTo: 'base-command',
    }],
  };
}

test('接受合法最小契约', () => {
  assert.doesNotThrow(() => validateCommandContract(createValidContract()));
});

const invalidContractCases = [
  {
    name: '拒绝未知版本',
    mutate(contract) { contract.version = 2; },
    error: /version/,
  },
  {
    name: '拒绝非数字版本',
    mutate(contract) { contract.version = '1'; },
    error: /version/,
  },
  {
    name: '拒绝缺失顶层数组',
    mutate(contract) { delete contract.cliCommands; },
    error: /cliCommands/,
  },
  {
    name: '拒绝缺失必填字符串字段',
    mutate(contract) { delete contract.cliCommands[0].args; },
    error: /cliCommands\[0\]\.args/,
  },
  {
    name: '拒绝非法命令名格式',
    mutate(contract) { contract.cliCommands[0].name = 'Bad_Command'; },
    error: /cliCommands\[0\]\.name/,
  },
  {
    name: '拒绝非法别名格式',
    mutate(contract) { contract.akCommands[0].aliases = ['Bad_Alias']; },
    error: /akCommands\[0\]\.aliases\[0\]/,
  },
  {
    name: '拒绝重复 CLI id',
    mutate(contract) {
      contract.cliCommands.push({ ...contract.cliCommands[0], name: 'other-command' });
    },
    error: /cliCommands\[1\]\.id/,
  },
  {
    name: '拒绝重复 ak id',
    mutate(contract) {
      contract.akCommands.push({
        ...contract.akCommands[0],
        name: 'other',
        aliases: [],
      });
    },
    error: /akCommands\[1\]\.id/,
  },
  {
    name: '拒绝重复 CLI 命令名',
    mutate(contract) {
      contract.cliCommands.push({ ...contract.cliCommands[0], id: 'other-command' });
    },
    error: /cliCommands\[1\]\.name/,
  },
  {
    name: '拒绝重复 ak 主命令名',
    mutate(contract) {
      contract.akCommands.push({
        ...contract.akCommands[0],
        id: 'other',
        aliases: [],
      });
    },
    error: /akCommands\[1\]\.name/,
  },
  {
    name: '拒绝别名与主命令冲突',
    mutate(contract) {
      contract.akCommands.push({
        ...contract.akCommands[0],
        id: 'other',
        name: 'other',
        aliases: ['short'],
      });
    },
    error: /akCommands\[1\]\.aliases\[0\]/,
  },
  {
    name: '拒绝别名相互冲突',
    mutate(contract) {
      contract.akCommands.push({
        ...contract.akCommands[0],
        id: 'other',
        name: 'other',
        aliases: ['s'],
      });
    },
    error: /akCommands\[1\]\.aliases\[0\]/,
  },
  {
    name: '拒绝非法 writeMode',
    mutate(contract) { contract.cliCommands[0].writeMode = 'sometimes'; },
    error: /cliCommands\[0\]\.writeMode/,
  },
  {
    name: '拒绝非法布尔值',
    mutate(contract) { contract.akCommands[0].jsonOutput = 'false'; },
    error: /akCommands\[0\]\.jsonOutput/,
  },
  {
    name: '拒绝非数组 aliases',
    mutate(contract) { contract.akCommands[0].aliases = 's'; },
    error: /akCommands\[0\]\.aliases/,
  },
  {
    name: '拒绝未知 mapsTo',
    mutate(contract) { contract.akCommands[0].mapsTo = 'missing-command'; },
    error: /akCommands\[0\]\.mapsTo/,
  },
  {
    name: '拒绝非白名单 wrapper',
    mutate(contract) { contract.akCommands[0].mapsTo = 'wrapper:other'; },
    error: /akCommands\[0\]\.mapsTo/,
  },
  {
    name: '拒绝 CR 文本',
    mutate(contract) { contract.cliCommands[0].summary = '第一行\r第二行'; },
    error: /cliCommands\[0\]\.summary/,
  },
  {
    name: '拒绝 LF 文本',
    mutate(contract) { contract.akCommands[0].args = '第一行\n第二行'; },
    error: /akCommands\[0\]\.args/,
  },
  {
    name: '拒绝反引号文本',
    mutate(contract) { contract.cliCommands[0].id = '`base-command`'; },
    error: /cliCommands\[0\]\.id/,
  },
];

for (const { name, mutate, error } of invalidContractCases) {
  test(name, () => {
    const contract = createValidContract();
    mutate(contract);

    assert.throws(() => validateCommandContract(contract), error);
  });
}
