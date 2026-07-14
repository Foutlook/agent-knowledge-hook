import assert from 'node:assert/strict';
import test from 'node:test';

import {
  loadCommandContract,
  renderAkBasicUsage,
  renderAkCommandTable,
  renderCliCommandList,
  renderCliCommandTable,
  renderCliUsage,
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
