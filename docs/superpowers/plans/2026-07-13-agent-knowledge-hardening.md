# Agent Knowledge Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 防止知识文件被同名覆盖，提供可执行的知识库健康检查，并让 OpenCode 实际命令由仓库内单一模板生成和校验。

**Architecture:** 保持零第三方依赖。在现有 `agent-knowledge.js` 中增加文件安全与检查函数：新建文件使用独占创建，原子替换使用同目录临时文件，`refreshProject` 用跨进程锁序列化“重读—更新—发布”，`promote` 用硬链接独占发布避免 TOCTOU 覆盖。OpenCode 命令以 `templates/opencode/` 为唯一来源，通过 `sync-adapters` 同步，通过 `doctor` 复用同一漂移检查。所有行为先写可确定复现的失败测试，再实现最小代码。

**Tech Stack:** Node.js ESM、`node:test`、PowerShell 5.1 包装器、Markdown/frontmatter、Git。

**Execution note:** 当前工作区包含上一轮尚未提交的相关修改，本计划在当前工作区内执行，不创建 worktree，不自动提交 Git。

---

### Task 1: 新建与更新文件的安全写入

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 为同名规则防覆盖写失败测试**

在同一个临时知识库中连续两次调用 `addRule`，标题完全相同。断言返回路径不同、两个文件都存在、第一份内容未被第二次写入覆盖。

- [x] **Step 2: 为同名纠偏防覆盖写失败测试**

连续两次调用 `recordFix`，使用相同英文标题。断言生成两份不同文件。

- [x] **Step 3: 运行聚焦测试并确认 RED**

Run:

```powershell
node --test --test-name-pattern="same title|does not overwrite" tests/agent-knowledge.test.js
```

Expected: FAIL，因为当前日期加 slug 会生成相同路径。

- [x] **Step 4: 实现独占的新文件创建**

新增内部函数 `writeUniqueFile(targetDir, fileName, content)`：

```js
for (let suffix = 1; ; suffix += 1) {
  const candidate = suffix === 1 ? fileName : appendSuffix(fileName, suffix);
  try {
    await writeFile(candidatePath, content, { encoding: 'utf8', flag: 'wx' });
    return candidatePath;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
```

`addRule` 和 `recordFix` 统一调用该函数。后缀使用 `-2`、`-3`，保证可读且并发时不覆盖。

- [x] **Step 5: 为原子更新与并发刷新写可确定失败的测试**

直接测试 `writeFileAtomic` 的失败边界：注入一个抛错的 `renameFile`，断言旧文件内容不变、同目录无 `.tmp-*` 残留、原异常继续抛出。另用 `Promise.all` 并发执行两次 `refreshProject`，断言两条刷新记录都被保留，没有静默丢更新。

- [x] **Step 6: 实现原子替换 helper**

新增 `writeFileAtomic(filePath, content, { renameFile = rename } = {})`：同目录用 `wx` 写入唯一临时文件，写入成功后 `rename` 到目标；失败时清理临时文件。新增 `withFileLock`，以相邻 `.lock` 文件的 `wx` 创建作为跨进程互斥；等待超时时显式失败，仅在锁记录的 PID 已不存活时清理遗留锁。`refreshProject` 必须在获锁后重新读取文件，完成后释放锁。

- [x] **Step 7: 加固 promote**

用 `publishFileExclusive` 先在目标目录完整写入唯一临时文件，再用同文件系统的 `link(temp, target)` 完成原子且不覆盖的发布，不再使用 `existsSync + writeFile` 的 TOCTOU 流程。只有目标发布成功后才删除 inbox 源文件；并发发布或任何失败都不覆盖目标，并优先保留源文件。增加“并发 promote 仅一个成功”和“发布失败不删源文件”测试。

- [x] **Step 8: 运行安全写入聚焦测试并确认 GREEN**

Run:

```powershell
node --test --test-name-pattern="same title|does not overwrite|refreshProject|promote" tests/agent-knowledge.test.js
```

Expected: PASS。

### Task 2: OpenCode 适配器单一来源

**Files:**
- Create: `agent-knowledge/templates/opencode/knowledge.before-task.md`
- Create: `agent-knowledge/templates/opencode/knowledge.record-fix.md`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/bin/ak.ps1`
- Modify: `.opencode/command/knowledge.before-task.md`
- Modify: `.opencode/command/knowledge.record-fix.md`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 为适配器漂移检测写失败测试**

构造临时仓库，模板内容和 `.opencode/command` 内容不同。调用 `syncAdapters({ check: true })`，断言返回 `adapter_drift` 且不修改目标文件。

- [x] **Step 2: 为适配器同步写失败测试**

调用 `syncAdapters({ check: false })`，断言实际命令与模板逐字一致；再次 check 返回空问题列表。

- [x] **Step 3: 运行聚焦测试并确认 RED**

Run:

```powershell
node --test --test-name-pattern="adapter" tests/agent-knowledge.test.js
```

Expected: FAIL，因为尚无 `syncAdapters`。

- [x] **Step 4: 实现模板映射与同步**

定义固定映射：

```js
const ADAPTER_SPECS = [
  ['opencode/knowledge.before-task.md', '.opencode/command/knowledge.before-task.md'],
  ['opencode/knowledge.record-fix.md', '.opencode/command/knowledge.record-fix.md'],
];
```

实现 `syncAdapters({ repositoryRoot, check })`。`repositoryRoot` 的契约只能是包含 `agent-knowledge/` 和 `.opencode/` 的钩子仓库根；模板固定来自 `<repositoryRoot>/agent-knowledge/templates/opencode/`，目标固定为 `<repositoryRoot>/.opencode/command/`，`knowledgeRoot` 绝不改变适配器来源。`check` 模式只比较并返回问题；同步模式使用原子写入 helper。暂不生成 README、AGENT 或说明文档。

- [x] **Step 5: 增加 CLI 与短命令**

新增：

```powershell
agent-knowledge sync-adapters [--check]
ak adapters [--check]
```

`--check` 有漂移时退出码为 1；同步成功退出 0。

增加子进程 CLI 测试：漂移时 `sync-adapters --check` 退出 1 且不写文件，同步后退出 0；Windows 上验证 `ak.ps1 adapters --check` 参数透传。

- [x] **Step 6: 同步实际 OpenCode 命令**

模板中的纠错流程必须明确：未确认草稿直接修改；正式知识或独立业务结论才创建 fix；已知知识目标时传 `--target`。

- [x] **Step 7: 运行适配器聚焦测试并确认 GREEN**

### Task 3: `doctor` 知识库健康检查

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/bin/ak.ps1`
- Modify: `agent-knowledge/help/ak.zh-CN.txt`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 为知识文件结构检查写失败测试**

覆盖以下问题码：

- `utf8_bom`
- `missing_frontmatter`
- `invalid_status`
- `duplicate_title`
- `broken_target`
- `missing_evidence_file`
- `missing_project_root`
- `adapter_drift`

每个测试使用真实临时 Markdown 文件，不 mock 文件系统。

- [x] **Step 2: 定义 doctor 返回契约**

```js
{
  ok: false,
  checkedFiles: 4,
  issues: [
    { severity: 'error', code: 'invalid_status', file: 'knowledge/rules/x.md', message: '...' }
  ]
}
```

所有问题按 `file + code` 稳定排序。`error` 会使 `ok=false` 并退出 1；`warning` 保留在结果中但不单独阻断退出码。`--json` 在成功和失败时都只输出一个可解析 JSON 对象。

- [x] **Step 3: 运行 doctor 聚焦测试并确认 RED**

Run:

```powershell
node --test --test-name-pattern="doctor" tests/agent-knowledge.test.js
```

Expected: FAIL，因为尚无 `doctor`。

- [x] **Step 4: 实现只读检查**

规则：

- 跳过 `inbox/README.md` 说明文件。BOM 先报 `utf8_bom`，再用去除 BOM 的内容解析，不因同一 BOM 额外误报 `missing_frontmatter`。
- `knowledge/` 只允许 `confirmed`。
- `inbox/` 只允许 `draft` 或 `pending`。
- 重复标题在 `knowledge/` 与 `inbox/` 的全局 Markdown 范围内检查，标题按 Unicode NFKC、去首尾空白、连续空白合并和小写化规范化；以 `warning` 报告，不自动删除或合并。
- `target` 必须位于当前知识库且存在。
- 只有存在非空 `evidence_files` 时才要求 `project_root`；缺失时报 `missing_project_root` warning。已配置时按 `project_root` 校验证据文件，本机项目根或证据文件不存在均报 `missing_evidence_file` warning，避免外置绝对路径阻断全部检查。
- `doctor({ repositoryRoot, knowledgeRoot })` 中 `repositoryRoot` 遵循 Task 2 契约；`knowledgeRoot` 只决定知识文件位置。如果 `<repositoryRoot>/.opencode/command/` 目录不存在，跳过适配器检查；目录存在时，缺失目标文件或内容不同都报 `adapter_drift` error。

- [x] **Step 5: 增加 CLI、JSON 与短命令**

新增：

```powershell
agent-knowledge doctor [--json]
ak doctor [--json]
```

文本输出包含检查文件数、问题数和逐条问题；禁止自动修复。

增加子进程 CLI 测试：`doctor --json` 在无 error 时退出 0、有 error 时退出 1，两种情况 stdout 都是纯合法 JSON；Windows 上验证 `ak.ps1 doctor --json` 参数透传。

- [x] **Step 6: 更新帮助与 README**

记录 doctor 检查范围、退出码和 `sync-adapters` 的模板边界。

- [x] **Step 7: 运行 doctor 聚焦测试并确认 GREEN**

### Task 4: 完整验证

**Files:**
- Verify all modified files.

- [x] **Step 1: 运行完整测试**

```powershell
npm.cmd test
```

Expected: 全部 PASS。

- [x] **Step 2: 运行覆盖率**

```powershell
node --experimental-test-coverage --test tests/*.test.js
```

Expected: 新增关键分支有覆盖，整体行覆盖率不低于修改前的 89.33%。

- [x] **Step 3: 验证 CLI 和 PowerShell**

```powershell
node --check bin/agent-knowledge.js
powershell -ExecutionPolicy Bypass -File bin/ak.ps1 doctor
powershell -ExecutionPolicy Bypass -File bin/ak.ps1 adapters --check
```

- [x] **Step 4: 验证格式与编码**

运行 `git diff --check`，并检查所有新增/修改文本文件均为 UTF-8 无 BOM。特别验证 PowerShell 5.1 可解析 `ak.ps1`，新增 `.ps1` 字符串保持 ASCII。

- [x] **Step 5: 审核变更边界**

确认没有修改业务知识正文、没有自动晋升或删除知识、没有创建提交。
