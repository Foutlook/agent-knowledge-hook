# Knowledge Hook P1 Modularization Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不改变任何可观察行为的前提下，把知识库钩子的 3695 行单体 CLI 和 5429 行单体测试拆成单向依赖的功能模块。

**Architecture:** 保留 `bin/agent-knowledge.js` 作为兼容入口，通过 re-export 维持程序化 API；生产逻辑按基础设施、功能域、CLI 三层逐个迁移。生产模块全部稳定后再拆测试，避免同时改变实现和保护网。

**Tech Stack:** Node.js ESM、Node 内置 test runner、PowerShell 5.1、Git；零第三方运行时依赖。

**Required skills:** `@refactor-module-safely`、`@test-driven-development`、`@verification-before-completion`

---

## 全局约束

- 设计依据：`docs/plans/2026-07-15-knowledge-hook-p1-modularization-design.md`。
- 所有移动必须保留原函数体、错误文本、注释和调用参数；除导入/导出外不顺手清理代码。
- 命令参数、stdout/stderr、退出码、JSON、文件格式、路径、锁和恢复语义不得改变。
- 每个任务完成后运行定向测试和全量测试；失败时按系统化调试流程定位，不叠加猜测性修改。
- 所有文本 UTF-8 无 BOM；Git 提交信息使用中文。
- 不修改 `team-agent-knowledge`，不增加依赖、索引、缓存、MCP 或 PowerShell 新架构。

## 基线

Run:

```powershell
cd C:\idea_workspace_tob\agent-knowledge-hook\agent-knowledge
npm.cmd test
```

Expected: `tests 243`、`pass 241`、`fail 0`、`skipped 2`。

---

### Task 1：锁定入口与公共导出契约

**Files:**

- Modify: `agent-knowledge/tests/agent-knowledge.test.js`
- Reference: `agent-knowledge/bin/agent-knowledge.js:1-23`

**Step 1：增加公共导出 characterization test**

在现有模块导出测试附近增加：

```js
test('public entry exports remain stable for programmatic consumers', () => {
  assert.deepEqual(
    Object.keys(agentKnowledgeModule).sort(),
    [
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
    ],
  );
});
```

**Step 2：增加导入无副作用 characterization test**

用 `execFile(process.execPath, ['--input-type=module', '--eval', ...])` 导入 `bin/agent-knowledge.js`，断言退出 0 且 stdout/stderr 为空。导入脚本不得调用 CLI。

**Step 3：运行入口定向测试**

Run:

```powershell
node --test --test-name-pattern="public entry exports|import.*side effect|CLI unknown command" tests/agent-knowledge.test.js
```

Expected: PASS。characterization test 在重构前即应通过。

**Step 4：运行全量并提交**

```powershell
npm.cmd test
git add agent-knowledge/tests/agent-knowledge.test.js
git commit -m "锁定知识库钩子公共入口契约"
```

Expected: 全量 0 失败。

---

### Task 2：提取知识文件与锁基础设施

**Files:**

- Create: `agent-knowledge/lib/knowledge-files.js`
- Create: `agent-knowledge/lib/locks.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`

**Step 1：先提取 `knowledge-files.js` 的稳定接口**

移动以下函数及其直接常量，不改函数体和错误文本：

```js
export {
  appendRefreshRecord,
  applyTemplateFields,
  assertConfirmedKnowledgeFile,
  collectMarkdownFiles,
  createTemporaryPath,
  hasFrontmatterField,
  isExistingDirectory,
  isExistingFileWithinRealRoot,
  isPathWithinRoot,
  parseFrontmatter,
  parseMarkdownFile,
  prepareKnowledgeDirectory,
  readDoctorMarkdownFile,
  readFrontmatterField,
  readGitHead,
  readTemplate,
  resolveKnowledgeContext,
  resolveKnowledgeMarkdownFile,
  resolveRealPathIfExists,
  resolveRootDir,
  slugify,
  timestamp,
  toPosixPath,
  updateFrontmatterFields,
  writeFileAtomic,
  writeUniqueFile,
};
```

内部 helper（如 `appendNumericSuffix`、`collectMarkdownFilesUnder`、`createTemporaryPath` 的序列状态、`inspectMarkdownCollectionPath`、root 推导函数）跟随其唯一 owner 移动，不额外导出。

`writeFileAtomic`、`writeUniqueFile` 继续由最终公共入口 re-export。

**Step 2：运行文件安全与原子写入测试**

```powershell
node --test --test-name-pattern="writeFileAtomic|writeUniqueFile|knowledge path boundary|realpath|UTF-8" tests/agent-knowledge.test.js
```

Expected: PASS。

**Step 3：提取 `locks.js`**

移动并导出：

```js
export {
  acquireAdjacentFileLock,
  isProcessAlive,
  parseLockContent,
};
```

`createLockContent`、`tryCreateLock`、`releaseOwnedLock`、`removeLockOwnedByDeadProcess` 保持模块私有；`FILE_LOCK_TIMEOUT_MS`、`FILE_LOCK_RETRY_DELAY_MS` 和 UUID/lock regex 与它们一起移动。

**Step 4：运行锁与恢复相邻测试**

```powershell
node --test --test-name-pattern="file lock|LOCK_TIMEOUT|refreshProject.*lock|doctor.*lock|resolveFix.*lock" tests/agent-knowledge.test.js
```

Expected: PASS。

**Step 5：运行全量并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/knowledge-files.js agent-knowledge/lib/locks.js agent-knowledge/bin/agent-knowledge.js
git commit -m "提取知识文件与锁基础能力"
```

---

### Task 3：提取检索模块

**Files:**

- Create: `agent-knowledge/lib/retrieval.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`

**Step 1：移动完整检索闭环**

移动：

- `STOP_WORDS`、`MAX_MUST_READ_RESULTS`、`synonymsCache`。
- `loadSynonyms` 至 `splitIdentifier`。
- `searchKnowledge`、`applyMustReadClassification`、`classifyMustRead`。
- `scoreMarkdownFile` 至 `buildSnippet`，包含检索时 stale 计算。

公开导出保持：

```js
export {
  extractKeywords,
  extractQueryKeywords,
  searchKnowledge,
};
```

从 `knowledge-files.js` 导入知识上下文、Markdown 解析和 Git HEAD helper；不要复制 frontmatter 或路径函数。

**Step 2：运行检索定向测试**

```powershell
node --test --test-name-pattern="extractKeywords|extractQueryKeywords|query groups|searchKnowledge|mustRead v2|snippet|stale knowledge" tests/agent-knowledge.test.js
```

Expected: PASS，测试名和数量不变。

**Step 3：对比真实样例 JSON**

在移动前后分别执行并保存到内存变量，不写团队知识库：

```powershell
node bin/agent-knowledge.js before-task "查询章节图谱聚合接口数据源不一致" --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge
node bin/agent-knowledge.js before-task "优化知识库钩子检索性能" --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge
```

Expected: 排序、mustRead 数量、`matchedTerms`、`reasonCodes` 和 `mustReadReason` 不变。

**Step 4：全量验证并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/retrieval.js agent-knowledge/bin/agent-knowledge.js
git commit -m "拆分知识检索模块"
```

---

### Task 4：提取仓库维护模块

**Files:**

- Create: `agent-knowledge/lib/repository-maintenance.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`
- Test: `agent-knowledge/tests/command-contract.test.js`

**Step 1：移动适配器和命令文档同步逻辑**

移动：

- `ADAPTER_SPECS`、`COMMAND_DOC_TARGETS`。
- `syncAdapters`、`syncCommandDocs`。
- 仅被上述函数使用的模板路径、生成区块和漂移 helper。

公开导出：

```js
export { syncAdapters, syncCommandDocs };
```

`repository-maintenance.js` 从 `knowledge-files.js` 导入 `resolveRootDir`、`writeFileAtomic`，从 `command-contract.js` 导入渲染和严格 UTF-8 helper。

**Step 2：运行维护定向测试**

```powershell
node --test --test-name-pattern="syncAdapters|sync-adapters|sync-command-docs|命令文档|适配器" tests/agent-knowledge.test.js tests/command-contract.test.js
```

Expected: PASS，生成区块仍保持字节级幂等。

**Step 3：运行只读漂移检查**

```powershell
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
```

Expected: 均通过且工作区无新改动。

**Step 4：全量验证并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/repository-maintenance.js agent-knowledge/bin/agent-knowledge.js
git commit -m "拆分仓库维护模块"
```

---

### Task 5：提取普通知识生命周期模块

**Files:**

- Create: `agent-knowledge/lib/lifecycle.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`

**Step 1：移动生命周期常量和函数**

移动：

- `FIX_TYPE_DIRS`。
- `addRule`、`recordFix`、`validateFixTarget`。
- `checkStale`、`computeDeepStale`。
- `refreshProject`。
- `promote`、`listPending`、`collectPendingUnder`。
- 仅属于模板填充、刷新正文和晋升映射的 helper。

公开导出：

```js
export {
  addRule,
  checkStale,
  listPending,
  promote,
  recordFix,
  refreshProject,
};
```

从 `knowledge-files.js` 和 `locks.js` 导入基础能力，不重新实现路径或锁逻辑。

**Step 2：运行生命周期定向测试**

```powershell
node --test --test-name-pattern="addRule|recordFix|check-stale|refreshProject|promote|listPending|knowledge path boundary" tests/agent-knowledge.test.js
```

Expected: PASS；文件内容、锁、错误文本和副作用不变。

**Step 3：全量验证并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/lifecycle.js agent-knowledge/bin/agent-knowledge.js
git commit -m "拆分知识生命周期模块"
```

---

### Task 6：提取 targeted fix 状态机

**Files:**

- Create: `agent-knowledge/lib/resolve-fix.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`

**Step 1：整体移动 resolve 闭环**

移动 `RESOLVABLE_FIX_CATEGORIES`、resolve lock/artifact regex，以及 `resolveFix` 到 `buildResolvedFixContent` 之间所有仅属于 targeted fix 的状态校验、claim、恢复、发布、chmod、unlink 和工件 helper。

只公开：

```js
export { resolveFix };
```

以下边界原样保留：

- source 分类与真实路径校验。
- `target_hash`、legacy confirmation、`fix_id`。
- claim/survivor/snapshot/resolved 的顺序和幂等恢复。
- owner lock、恢复冲突、late write 和 source path reuse 处理。
- hooks 和可替换文件操作参数，供现有故障注入测试继续使用。

**Step 2：运行完整 resolve 定向测试**

```powershell
node --test --test-name-pattern="resolveFix|resolve-fix|targeted fix|resolution" tests/agent-knowledge.test.js
```

Expected: PASS；不得只选 happy path。

**Step 3：全量验证并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/resolve-fix.js agent-knowledge/bin/agent-knowledge.js
git commit -m "拆分纠偏关闭与恢复模块"
```

---

### Task 7：提取 doctor 模块

**Files:**

- Create: `agent-knowledge/lib/doctor.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`

**Step 1：移动 doctor 闭环**

移动 `doctor`、frontmatter/status/target/fix/evidence 检查、重复标题、锁扫描、适配器 issue 转换、issue 排序和格式化前的数据构建 helper。

只公开：

```js
export { doctor };
```

从 `repository-maintenance.js` 只读调用适配器漂移检查；从 `knowledge-files.js`、`locks.js` 使用共享能力。不得在 doctor 中写文件。

**Step 2：运行 doctor 定向测试**

```powershell
node --test --test-name-pattern="doctor" tests/agent-knowledge.test.js
```

Expected: issue code、severity、文件数、排序、JSON 和退出码测试全部 PASS。

**Step 3：运行真实团队库 doctor**

```powershell
node bin/agent-knowledge.js doctor --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --repository-root ..
```

Expected: `ok: true`、`checkedFiles: 8`、`issues: []`。

**Step 4：全量验证并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/doctor.js agent-knowledge/bin/agent-knowledge.js
git commit -m "拆分知识库健康检查模块"
```

---

### Task 8：迁移 CLI 并收口薄入口

**Files:**

- Create: `agent-knowledge/lib/cli.js`
- Rewrite: `agent-knowledge/bin/agent-knowledge.js`
- Test: `agent-knowledge/tests/agent-knowledge.test.js`
- Test: `agent-knowledge/tests/command-contract.test.js`

**Step 1：移动 CLI 路由、解析和输出函数**

`lib/cli.js` 包含：

- `GLOBAL_OPTION_SUPPORT`、`KNOWN_CLI_COMMANDS`。
- `usage`、`main`（重命名导出为 `runCli`）。
- `parseGlobalOptions`、`validateGlobalOptions`、`parseFreeTextArguments`、`parseSyncCommandDocsOptions`、`parseCommandOptions`、`parseResolveFixOptions`。
- `formatSearchOutput` 至 `staleToJson` 的所有文本/JSON formatter。

导出：

```js
export async function runCli(argv) {
  // 原 main 函数体，原样保留路由顺序、输出和退出码。
}
```

**Step 2：把 bin 改成兼容 facade**

目标结构：

```js
#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runCli } from '../lib/cli.js';

export { doctor } from '../lib/doctor.js';
export {
  addRule,
  checkStale,
  listPending,
  promote,
  recordFix,
  refreshProject,
} from '../lib/lifecycle.js';
export { resolveFix } from '../lib/resolve-fix.js';
export { extractKeywords, extractQueryKeywords, searchKnowledge } from '../lib/retrieval.js';
export { syncAdapters, syncCommandDocs } from '../lib/repository-maintenance.js';
export { writeFileAtomic, writeUniqueFile } from '../lib/knowledge-files.js';

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (executedPath === modulePath) {
  runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
```

**Step 3：运行入口和全部 CLI 测试**

```powershell
node --test --test-name-pattern="public entry|CLI |sync-command-docs|PowerShell|路由|帮助" tests/agent-knowledge.test.js tests/command-contract.test.js
```

Expected: PASS；导出集合、导入无副作用、命令顺序和错误文本不变。

**Step 4：运行全量并提交**

```powershell
npm.cmd test
git add agent-knowledge/lib/cli.js agent-knowledge/bin/agent-knowledge.js
git commit -m "收口知识库钩子命令入口"
```

---

### Task 9：按功能域拆分测试

**Files:**

- Create: `agent-knowledge/tests/test-helpers.js`
- Create: `agent-knowledge/tests/retrieval.test.js`
- Create: `agent-knowledge/tests/lifecycle.test.js`
- Create: `agent-knowledge/tests/resolve-fix.test.js`
- Create: `agent-knowledge/tests/doctor.test.js`
- Create: `agent-knowledge/tests/repository-maintenance.test.js`
- Create: `agent-knowledge/tests/cli.test.js`
- Delete: `agent-knowledge/tests/agent-knowledge.test.js`
- Keep: `agent-knowledge/tests/command-contract.test.js`

**Step 1：提取真正共享的测试 helper**

`test-helpers.js` 只放至少被两个测试文件使用的夹具，例如：

```js
export {
  cliPath,
  createDirectoryLink,
  createGitProject,
  createTempRoot,
  runCli,
  runCliFailure,
  writeExternalKnowledgeFile,
};
```

resolve 专用工件、doctor 专用 fixture、适配器模板等 helper 留在各自测试文件，避免形成第二个单体 helper。

**Step 2：先移动 retrieval 和 lifecycle 测试**

保持每个 `test(...)` 的名称、函数体和断言不变，只调整 import/helper。运行：

```powershell
node --test tests/retrieval.test.js tests/lifecycle.test.js
```

Expected: 两个文件全部 PASS。

**Step 3：移动 resolve-fix 和 doctor 测试**

```powershell
node --test tests/resolve-fix.test.js tests/doctor.test.js
```

Expected: 全部 PASS，包括故障注入、恢复和链接边界。

**Step 4：移动 repository-maintenance 和 cli 测试**

```powershell
node --test tests/repository-maintenance.test.js tests/cli.test.js tests/command-contract.test.js
```

Expected: 全部 PASS。

**Step 5：删除空的单体测试并校验测试集合**

```powershell
npm.cmd test
```

Expected: 总测试数不低于重构前的 245（Task 1 新增 2 项），0 失败；仅允许原有 2 项 symlink 跳过。若多文件并发暴露共享测试状态，只修夹具隔离，不串行化整个测试套件。

**Step 6：提交测试拆分**

```powershell
git add agent-knowledge/tests
git commit -m "按功能域拆分知识库钩子测试"
```

---

### Task 10：文档和最终验证

**Files:**

- Modify: `README.md`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/help/ak.zh-CN.txt` only if module layout is described there

**Step 1：更新项目结构说明**

只更新模块目录和测试结构；不修改命令生成区块，不改用户行为说明。

**Step 2：运行完整验证**

```powershell
cd C:\idea_workspace_tob\agent-knowledge-hook\agent-knowledge
npm.cmd test
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
node bin/agent-knowledge.js doctor --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --repository-root ..
```

Expected: 测试 0 失败；命令文档和适配器无漂移；doctor `ok: true`。

**Step 3：运行 CLI 真实回归**

```powershell
node bin/agent-knowledge.js before-task "查询章节图谱聚合接口数据源不一致" --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge
node bin/agent-knowledge.js before-task "优化知识库钩子检索性能" --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge
node bin/agent-knowledge.js search "zValue Jackson 参数绑定" --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge
```

Expected: 排序、mustRead 和解释字段与 P1 前基线一致。

**Step 4：检查编码、换行和范围**

```powershell
git diff --check
git status --short
```

用严格 UTF-8 解码检查所有修改文本，首字节不得为 `EF BB BF`。确认无临时锁、测试知识库或未计划文件。

**Step 5：提交文档**

```powershell
git add README.md agent-knowledge/README.md agent-knowledge/help/ak.zh-CN.txt
git commit -m "更新知识库钩子模块结构说明"
```

若帮助文件无需变化，不得为了凑提交而修改它；只提交实际变更文件。
