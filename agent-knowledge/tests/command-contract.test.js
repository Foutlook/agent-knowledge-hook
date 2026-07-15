import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
const akEntryPath = fileURLToPath(new URL('../bin/ak.ps1', import.meta.url));
const repositoryRootPath = fileURLToPath(new URL('../../', import.meta.url));
const commandContractTestPath = fileURLToPath(import.meta.url);
const powerShellExecutable = process.platform === 'win32' ? 'powershell' : 'pwsh';
const blockBegin = '<!-- BEGIN GENERATED: TEST_BLOCK -->';
const blockEnd = '<!-- END GENERATED: TEST_BLOCK -->';

test('PowerShell 子进程按运行平台选择可执行文件', async () => {
  const commandContractTestSource = await readFile(commandContractTestPath, 'utf8');

  assert.match(
    commandContractTestSource,
    /const powerShellExecutable = process\.platform === 'win32' \? 'powershell' : 'pwsh';/u,
    'PowerShell 子进程必须按运行平台选择可执行文件',
  );
  assert.doesNotMatch(
    commandContractTestSource,
    /spawnSync\('powershell'/u,
    'Ubuntu npm test 路径不能硬编码 Windows-only powershell',
  );
});

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
  const contract = createFormattingContract();
  const files = new Map();
  const toolRoot = path.join(repositoryRoot, '.tool');
  const toolBinRoot = path.join(toolRoot, 'bin');
  const toolLibRoot = path.join(toolRoot, 'lib');
  await Promise.all([
    mkdir(toolBinRoot, { recursive: true }),
    mkdir(toolLibRoot, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(cliEntryPath, path.join(toolBinRoot, 'agent-knowledge.js')),
    copyFile(fileURLToPath(new URL('../lib/command-contract.js', import.meta.url)), path.join(toolLibRoot, 'command-contract.js')),
    writeFile(path.join(toolRoot, 'command-contract.json'), `${JSON.stringify(contract, null, 2)}\n`, 'utf8'),
    writeFile(path.join(toolRoot, 'package.json'), '{"type":"module"}\n', 'utf8'),
  ]);

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
  const localEntryPath = path.join(repositoryRoot, '.tool', 'bin', 'agent-knowledge.js');
  return spawnSync(process.execPath, [
    existsSync(localEntryPath) ? localEntryPath : cliEntryPath,
    'sync-command-docs',
    ...args,
    '--repository-root',
    repositoryRoot,
  ], { encoding: 'utf8' });
}

test('真实仓库命令文档与命令契约一致', () => {
  const result = runSyncCommandDocs(repositoryRootPath, '--check');

  assert.equal(result.status, 0, result.stderr);
});

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
  assert.match(first.stdout, /README\.md \[AK_COMMAND_TABLE\]/u);
  assert.match(first.stdout, /README\.md \[CLI_COMMAND_TABLE\]/u);
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

test('sync-command-docs --check 在 jsonOutput 变化后报告对应生成区块漂移', async (t) => {
  const currentTargets = commandDocTargets.map(({ relativePath }) => relativePath);
  const { repositoryRoot, contract } = await createCommandDocRepository(t, { currentTargets });
  contract.cliCommands[0].jsonOutput = false;
  await writeFile(
    path.join(repositoryRoot, '.tool', 'command-contract.json'),
    `${JSON.stringify(contract, null, 2)}\n`,
    'utf8',
  );

  const result = runSyncCommandDocs(repositoryRoot, '--check');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /README\.md \[CLI_COMMAND_TABLE\]/u);
  assert.match(result.stderr, /agent-knowledge\/README\.md \[CLI_COMMAND_LIST\]/u);
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

for (const args of [[], ['--check']]) {
  const mode = args.length === 0 ? '同步' : '检查';
  test(`sync-command-docs ${mode}严格拒绝标记外非法 UTF-8 且完全不写入`, async (t) => {
    const { repositoryRoot, files } = await createCommandDocRepository(t);
    const targetPath = files.get('agent-knowledge/README.md').filePath;
    const original = await readFile(targetPath);
    await writeFile(targetPath, Buffer.concat([Buffer.from([0x80]), original]));
    const before = await snapshotTree(repositoryRoot);

    const result = runSyncCommandDocs(repositoryRoot, ...args);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /agent-knowledge\/README\.md.*UTF-8/u);
    assert.deepEqual(await snapshotTree(repositoryRoot), before);
  });
}

test('Node 严格拒绝命令契约字符串中的非法 UTF-8', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'agent-knowledge-invalid-utf8-contract-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contractPath = path.join(root, 'command-contract.json');
  await writeFile(contractPath, Buffer.concat([
    Buffer.from('{"version":1,"cliCommands":[{"id":"base","name":"base","args":"","summary":"'),
    Buffer.from([0x80]),
    Buffer.from('","writeMode":"never","jsonOutput":false}],"akCommands":[]}'),
  ]));

  await assert.rejects(loadCommandContract(contractPath), /UTF-8/u);
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

function extractStandardCommandRoutes(source) {
  const routePattern = /^  if \(command === '([a-z0-9]+(?:-[a-z0-9]+)*)'\) \{$/gmu;
  return [...source.matchAll(routePattern)].map((match) => match[1]);
}

function assertRouteContractEqual(actualRoutes, contractRoutes) {
  assert.deepEqual(new Set(actualRoutes), new Set(contractRoutes));
}

test('CLI 帮助命令顺序来自合成契约且命令只出现一次', async (t) => {
  const contract = createFormattingContract();
  const { entryPath } = await createMinimalCliTool(t, `${JSON.stringify(contract, null, 2)}\n`);
  const result = spawnSync(process.execPath, [entryPath, '--help'], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  const helpCommands = result.stdout
    .split(/\r?\n/u)
    .filter((line) => /^  [a-z0-9]/u.test(line))
    .map((line) => line.trimStart().match(/^([a-z0-9-]+)/u)[1]);
  assert.deepEqual(helpCommands, contract.cliCommands.map(({ name }) => name));
  for (const { name } of contract.cliCommands) {
    assert.equal(result.stdout.match(new RegExp(`\\b${name}\\b`, 'gu'))?.length, 1);
  }
});

async function createMinimalCliTool(t, contractContent) {
  const toolRoot = await mkdtemp(path.join(tmpdir(), 'agent-knowledge-lazy-contract-'));
  t.after(() => rm(toolRoot, { recursive: true, force: true }));
  const binRoot = path.join(toolRoot, 'bin');
  const libRoot = path.join(toolRoot, 'lib');
  const knowledgeRoot = path.join(toolRoot, 'knowledge-root');
  await Promise.all([
    mkdir(binRoot, { recursive: true }),
    mkdir(libRoot, { recursive: true }),
    mkdir(path.join(knowledgeRoot, 'knowledge'), { recursive: true }),
  ]);
  const entryPath = path.join(binRoot, 'agent-knowledge.js');
  await Promise.all([
    copyFile(cliEntryPath, entryPath),
    copyFile(fileURLToPath(new URL('../lib/command-contract.js', import.meta.url)), path.join(libRoot, 'command-contract.js')),
    writeFile(path.join(toolRoot, 'package.json'), '{"type":"module"}\n', 'utf8'),
    writeFile(
      path.join(knowledgeRoot, 'knowledge', 'sample.md'),
      '---\ntitle: 示例知识\nstatus: confirmed\n---\n\n# 示例知识\n\n唯一检索词。\n',
      'utf8',
    ),
  ]);
  if (contractContent !== undefined) {
    await writeFile(path.join(toolRoot, 'command-contract.json'), contractContent, 'utf8');
  }
  return { entryPath, knowledgeRoot, toolRoot };
}

for (const { name, contractContent } of [
  { name: '缺失', contractContent: undefined },
  { name: '损坏', contractContent: '{not-json}\n' },
]) {
  test(`原只读业务命令不依赖${name}的命令契约，但帮助与同步仍失败`, async (t) => {
    const { entryPath, knowledgeRoot, toolRoot } = await createMinimalCliTool(t, contractContent);

    const businessResult = spawnSync(process.execPath, [
      entryPath,
      'search',
      '唯一检索词',
      '--knowledge-root',
      knowledgeRoot,
    ], { encoding: 'utf8' });
    const helpResult = spawnSync(process.execPath, [entryPath, '--help'], { encoding: 'utf8' });
    const syncResult = spawnSync(process.execPath, [
      entryPath,
      'sync-command-docs',
      '--repository-root',
      toolRoot,
    ], { encoding: 'utf8' });

    assert.equal(businessResult.status, 0, businessResult.stderr);
    assert.match(businessResult.stdout, /唯一检索词/u);
    assert.equal(helpResult.status, 1);
    assert.match(helpResult.stderr, /command-contract\.json|JSON/u);
    assert.equal(syncResult.status, 1);
    assert.match(syncResult.stderr, /command-contract\.json|JSON/u);
  });
}

test('Node 顶层命令路由与契约双向一致', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(cliEntryPath, 'utf8'),
  ]);

  assertRouteContractEqual(
    extractStandardCommandRoutes(source),
    contract.cliCommands.map(({ name }) => name),
  );
});

test('路由一致性检查拒绝源码多出的标准路由', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(cliEntryPath, 'utf8'),
  ]);
  const sourceWithExtraRoute = [
    source,
    "  if (command === 'extra-command') {",
    '    return 0;',
    '  }',
  ].join('\n');

  assert.throws(
    () => assertRouteContractEqual(
      extractStandardCommandRoutes(sourceWithExtraRoute),
      contract.cliCommands.map(({ name }) => name),
    ),
    assert.AssertionError,
  );
});

test('路由一致性检查拒绝契约多出的命令', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(cliEntryPath, 'utf8'),
  ]);

  assert.throws(
    () => assertRouteContractEqual(
      extractStandardCommandRoutes(source),
      [...contract.cliCommands.map(({ name }) => name), 'contract-only'],
    ),
    assert.AssertionError,
  );
});

function countPowerShellStructuralBraces(line) {
  let depthChange = 0;
  let quote = '';
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote === '"') {
      if (character === '`') {
        index++;
      } else if (character === '"') {
        quote = '';
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && line[index + 1] === "'") {
        index++;
      } else if (character === "'") {
        quote = '';
      }
      continue;
    }
    if (character === '#') {
      break;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      depthChange++;
    } else if (character === '}') {
      depthChange--;
    }
  }
  return depthChange;
}

function extractAkCommandRoutes(source) {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const switchIndex = lines.findIndex((line) => /^\s*switch \(\$command\) \{$/u.test(line));
  assert.notEqual(switchIndex, -1, '未找到 switch ($command)');

  const routes = [];
  let depth = 1;
  let closed = false;
  for (const line of lines.slice(switchIndex + 1)) {
    const selector = line.trim();
    if (depth === 1) {
      if (!selector || selector.startsWith('#')) {
        continue;
      }
      if (selector === '}') {
        closed = true;
      } else if (selector === 'default {') {
        // default 是控制分支，不属于契约登记的短命令。
      } else {
        const stringCase = selector.match(/^"([a-z0-9]+(?:-[a-z0-9]+)*)" \{$/u);
        const compoundCase = selector.match(/^\{ \$_ -in @\((.+)\) \} \{$/u);
        if (stringCase) {
          routes.push(stringCase[1]);
        } else if (compoundCase) {
          const list = compoundCase[1];
          if (!/^"[a-z0-9]+(?:-[a-z0-9]+)*"(?:, "[a-z0-9]+(?:-[a-z0-9]+)*")*$/u.test(list)) {
            throw new Error(`不支持的 PowerShell switch 复合 case：${selector}`);
          }
          routes.push(...JSON.parse(`[${list}]`));
        } else {
          throw new Error(`不支持的 PowerShell switch case：${selector}`);
        }
      }
    }

    depth += countPowerShellStructuralBraces(line);
    if (depth === 0) {
      break;
    }
    assert.ok(depth > 0, 'switch ($command) 花括号不平衡');
  }
  assert.equal(closed, true, 'switch ($command) 未闭合');
  assert.equal(depth, 0, 'switch ($command) 花括号不平衡');
  return routes;
}

function akContractRoutes(contract) {
  return contract.akCommands.flatMap(({ name, aliases }) => [name, ...aliases]);
}

test('PowerShell 顶层短命令路由与契约主命令及别名双向一致', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(akEntryPath, 'utf8'),
  ]);

  assertRouteContractEqual(extractAkCommandRoutes(source), akContractRoutes(contract));
});

test('PowerShell 路由一致性检查拒绝源码多出的短命令', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(akEntryPath, 'utf8'),
  ]);
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const sourceWithExtraRoute = source.replace(
    /(?=    default \{\r?\n      Write-Error "Unknown ak command: \$command")/u,
    `    "extra" {${newline}      exit 0${newline}    }${newline}`,
  );

  assert.throws(
    () => assertRouteContractEqual(extractAkCommandRoutes(sourceWithExtraRoute), akContractRoutes(contract)),
    assert.AssertionError,
  );
});

test('PowerShell 路由一致性检查拒绝契约多出的短命令', async () => {
  const [contract, source] = await Promise.all([
    loadCommandContract(),
    readFile(akEntryPath, 'utf8'),
  ]);

  assert.throws(
    () => assertRouteContractEqual(
      extractAkCommandRoutes(source),
      [...akContractRoutes(contract), 'contract-only'],
    ),
    assert.AssertionError,
  );
});

test('PowerShell 路由提取器拒绝未知 case 写法', async () => {
  const source = await readFile(akEntryPath, 'utf8');
  const sourceWithUnknownCase = source.replace('    "projects" {', '    /^projects$/ {');

  assert.throws(() => extractAkCommandRoutes(sourceWithUnknownCase), /不支持.*case/u);
});

async function createPowerShellTool(t, contract = createValidContract()) {
  const toolRoot = await mkdtemp(path.join(tmpdir(), 'agent-knowledge-powershell-help-'));
  t.after(() => rm(toolRoot, { recursive: true, force: true }));
  const binRoot = path.join(toolRoot, 'bin');
  await mkdir(binRoot, { recursive: true });
  const scriptPath = path.join(binRoot, 'ak.ps1');
  const contractPath = path.join(toolRoot, 'command-contract.json');
  await Promise.all([
    copyFile(akEntryPath, scriptPath),
    writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, 'utf8'),
  ]);
  return { contractPath, scriptPath };
}

function runPowerShellAkHelp(scriptPath) {
  const escapedScriptPath = scriptPath.replaceAll("'", "''");
  return spawnSync(powerShellExecutable, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); & '${escapedScriptPath}' help`,
  ], { encoding: 'utf8' });
}

test('PowerShell 缺少详细帮助时按契约顺序输出主命令及中文 summary', async (t) => {
  const contract = createFormattingContract();
  const { scriptPath } = await createPowerShellTool(t, contract);

  const result = runPowerShellAkHelp(scriptPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replaceAll('\r\n', '\n').trimEnd(), renderAkBasicUsage(contract));
  for (const { aliases } of contract.akCommands) {
    for (const alias of aliases) {
      assert.doesNotMatch(result.stdout, new RegExp(`^  ak ${alias}(?: |$)`, 'mu'));
    }
  }
});

test('PowerShell 基础帮助严格拒绝非法 UTF-8 契约', async (t) => {
  const { contractPath, scriptPath } = await createPowerShellTool(t);
  await writeFile(contractPath, Buffer.from([0x7b, 0x22, 0x80, 0x22, 0x3a, 0x31, 0x7d]));

  const result = runPowerShellAkHelp(scriptPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /UTF-8/u);
  assert.doesNotMatch(result.stdout, /Commands:/u);
});

const invalidPowerShellContractCases = [
  {
    name: '含大写字母的命令名',
    mutate(contract) {
      contract.cliCommands[0].name = 'Search';
      contract.akCommands[0].mapsTo = 'Search';
    },
    error: /cliCommands\[0\]\.name/u,
  },
  {
    name: '大写 writeMode',
    mutate(contract) { contract.cliCommands[0].writeMode = 'NEVER'; },
    error: /cliCommands\[0\]\.writeMode/u,
  },
  {
    name: '大小写不一致的 CLI mapsTo',
    mutate(contract) {
      contract.cliCommands[0].name = 'search';
      contract.akCommands[0].mapsTo = 'SEARCH';
    },
    error: /akCommands\[0\]\.mapsTo/u,
  },
  {
    name: '大小写错误的白名单 wrapper',
    mutate(contract) { contract.akCommands[0].mapsTo = 'wrapper:PROJECTS'; },
    error: /akCommands\[0\]\.mapsTo/u,
  },
  {
    name: '未知版本',
    mutate(contract) { contract.version = 2; },
    error: /version/u,
  },
  {
    name: '重复 CLI 名称',
    mutate(contract) {
      contract.cliCommands.push({ ...contract.cliCommands[0], id: 'other-command' });
    },
    error: /cliCommands\[1\]\.name/u,
  },
  {
    name: 'ak 别名与主命令冲突',
    mutate(contract) {
      contract.akCommands.push({
        ...contract.akCommands[0],
        id: 'other',
        name: 'other',
        aliases: ['short'],
      });
    },
    error: /akCommands\[1\]\.aliases\[0\]/u,
  },
  {
    name: '重复 ak 别名',
    mutate(contract) {
      contract.akCommands.push({
        ...contract.akCommands[0],
        id: 'other',
        name: 'other',
        aliases: ['s'],
      });
    },
    error: /akCommands\[1\]\.aliases\[0\]/u,
  },
  {
    name: '非法 writeMode',
    mutate(contract) { contract.cliCommands[0].writeMode = 'sometimes'; },
    error: /cliCommands\[0\]\.writeMode/u,
  },
  {
    name: '非布尔 jsonOutput',
    mutate(contract) { contract.akCommands[0].jsonOutput = 'false'; },
    error: /akCommands\[0\]\.jsonOutput/u,
  },
  {
    name: '未知 CLI mapsTo',
    mutate(contract) { contract.akCommands[0].mapsTo = 'missing-command'; },
    error: /akCommands\[0\]\.mapsTo/u,
  },
  {
    name: '非白名单 wrapper',
    mutate(contract) { contract.akCommands[0].mapsTo = 'wrapper:other'; },
    error: /akCommands\[0\]\.mapsTo/u,
  },
];

for (const { name, mutate, error } of invalidPowerShellContractCases) {
  test(`PowerShell 基础帮助拒绝${name}`, async (t) => {
    const contract = createValidContract();
    mutate(contract);
    const { scriptPath } = await createPowerShellTool(t, contract);

    const result = runPowerShellAkHelp(scriptPath);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
    assert.doesNotMatch(result.stdout, /Commands:/u);
  });
}

test('PowerShell 基础帮助允许仅大小写不同的 id', async (t) => {
  const contract = createValidContract();
  contract.cliCommands[0].id = 'foo';
  contract.cliCommands.push({
    ...contract.cliCommands[0],
    id: 'FOO',
    name: 'other-command',
  });
  const { scriptPath } = await createPowerShellTool(t, contract);

  const result = runPowerShellAkHelp(scriptPath);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.replaceAll('\r\n', '\n').trimEnd(), renderAkBasicUsage(contract));
});

test('真实命令契约按登记顺序加载', async () => {
  const contract = await loadCommandContract();

  assert.equal(contract.version, 1);
  assert.deepEqual(contract.cliCommands.map(({ name }) => name), cliCommandNames);
  assert.deepEqual(contract.akCommands.map(({ name }) => name), akCommandNames);
});

test('渲染 CLI 帮助命令行', () => {
  const contract = createFormattingContract();

  assert.equal(renderCliUsage(contract), [
    '  alpha <value|other> [--json]  第一条 | 说明',
    '  beta [--json]  第二条说明',
    '  gamma  第三条说明',
  ].join('\n'));
});

test('渲染 ak 基础使用文本', () => {
  const contract = createFormattingContract();

  assert.equal(renderAkBasicUsage(contract), [
    'ak: agent-knowledge short commands',
    '',
    'Commands:',
    '  ak short <值|其它>  短命令 | 说明',
  ].join('\n'));
});

test('渲染 ak 命令 Markdown 表格', () => {
  const contract = createFormattingContract();

  assert.equal(renderAkCommandTable(contract), [
    '| 短命令 | 作用 |',
    '| --- | --- |',
    '| `ak short <值\\|其它>` | 短命令 \\| 说明 |',
  ].join('\n'));
});

test('渲染 CLI 命令 Markdown 表格并转义竖线', () => {
  const contract = createFormattingContract();

  assert.equal(renderCliCommandTable(contract), [
    '| 命令 | 什么时候用 | 是否写文件 | JSON 输出 |',
    '| --- | --- | --- | --- |',
    '| `alpha <value\\|other>` | 第一条 \\| 说明 | 否 | 支持 |',
    '| `beta [--json]` | 第二条说明 | 是 | 支持 |',
    '| `gamma` | 第三条说明 | 视参数而定 | 不支持 |',
  ].join('\n'));
});

test('渲染 CLI 命令代码清单', () => {
  const contract = createFormattingContract();

  assert.equal(renderCliCommandList(contract), [
    '```text',
    'agent-knowledge alpha <value|other> [--json]',
    'agent-knowledge beta [--json]',
    'agent-knowledge gamma',
    '```',
  ].join('\n'));
});

function createFormattingContract() {
  return {
    version: 1,
    cliCommands: [
      {
        id: 'alpha',
        name: 'alpha',
        args: '<value|other>',
        summary: '第一条 | 说明',
        writeMode: 'never',
        jsonOutput: true,
      },
      {
        id: 'beta',
        name: 'beta',
        args: '[--json]',
        summary: '第二条说明',
        writeMode: 'always',
        jsonOutput: true,
      },
      {
        id: 'gamma',
        name: 'gamma',
        args: '',
        summary: '第三条说明',
        writeMode: 'conditional',
        jsonOutput: false,
      },
    ],
    akCommands: [{
      id: 'short',
      name: 'short',
      args: '<值|其它>',
      summary: '短命令 | 说明',
      writeMode: 'never',
      jsonOutput: false,
      aliases: ['s'],
      mapsTo: 'alpha',
    }],
  };
}

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
