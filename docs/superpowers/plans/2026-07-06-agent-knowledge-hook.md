# Agent Knowledge Hook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立一个可被 Codex、Claude、OpenCode 共同调用的本地团队知识库命令式钩子。

**Architecture:** 使用 `agent-knowledge/bin/agent-knowledge.js` 承载核心逻辑，`agent-knowledge.ps1` 和 `agent-knowledge.sh` 只做跨平台包装。知识库使用 Markdown 文件和简单 frontmatter，命令通过确定性关键词提取和本地全文检索输出必须阅读项、生成待确认规则草稿、记录纠错反哺材料。

**Tech Stack:** Node.js built-in modules、Node test runner、Markdown、PowerShell、sh、UTF-8 without BOM。

---

## 执行状态

本计划已按 Task 1-7 完成实现和验证。下方任务清单保留实施过程中的原始步骤，用于追溯当时的执行顺序和阶段性预期；当前最终状态以本节为准。

最终验证结果：

- `agent-knowledge/` 下 `npm.cmd run test` 通过，10 个测试全部成功。
- `before-task` 可从仓库根目录通过 PowerShell 包装器运行，并命中数据源一致性和 RPC 本地依赖知识。
- `search "RPC 本地依赖"` 可命中 `agent-knowledge/knowledge/service-map/rpc-local-dependency-map.md`。
- `add-rule` 和 `record-fix` 的写入行为由临时 `rootDir` 测试覆盖，未污染正式 `agent-knowledge/inbox`。
- `agent-knowledge` 与 `docs/superpowers` 下的 `.md`、`.js`、`.json`、`.ps1`、`.sh` 文件均已检查为 UTF-8 无 BOM。

## 设计依据

设计文档：

- `docs/superpowers/specs/2026-07-06-agent-knowledge-hook-design.md`

关键边界：

- 第一版不做服务端、向量库、embedding、联网检索。
- `knowledge/` 只放已确认长期知识。
- `inbox/` 放待确认规则和纠错记录，避免把临时判断污染成长期规则。
- 所有文本文件必须 UTF-8 无 BOM。

## 文件结构

新增文件：

- `agent-knowledge/README.md`
  - 使用说明、目录说明、命令示例、知识沉淀流程。
- `agent-knowledge/package.json`
  - 定义 `node --test` 验证命令，不引入三方依赖。
- `agent-knowledge/bin/agent-knowledge.js`
  - CLI 核心逻辑，负责命令解析、关键词提取、Markdown 扫描、模板生成、UTF-8 写入。
- `agent-knowledge/bin/agent-knowledge.ps1`
  - Windows 入口，转发参数到 Node 脚本。
- `agent-knowledge/bin/agent-knowledge.sh`
  - macOS/Linux 入口，转发参数到 Node 脚本。
- `agent-knowledge/templates/rule.md`
  - 主动补全规则模板。
- `agent-knowledge/templates/fix-record.md`
  - BUG / PRD / 技术方案纠错记录模板。
- `agent-knowledge/templates/domain-note.md`
  - 业务知识模板。
- `agent-knowledge/knowledge/rules/aggregation-data-source-consistency.md`
  - 种子知识：聚合接口数据源一致性。
- `agent-knowledge/knowledge/service-map/rpc-local-dependency-map.md`
  - 种子知识：本地 RPC 依赖索引，来自公开示例映射的规则化版本。
- `agent-knowledge/inbox/README.md`
  - 说明 `inbox/` 是待确认缓冲区。
- `agent-knowledge/tool-adapters/AGENTS.md`
  - Codex / AGENTS 接入片段。
- `agent-knowledge/tool-adapters/CLAUDE.md`
  - Claude 接入片段。
- `agent-knowledge/tool-adapters/opencode.md`
  - OpenCode 接入片段。
- `.opencode/command/knowledge.before-task.md`
  - OpenCode 命令入口说明。
- `.opencode/command/knowledge.record-fix.md`
  - OpenCode 纠错记录命令说明。
- `agent-knowledge/tests/agent-knowledge.test.js`
  - Node test runner 覆盖关键词提取、搜索排序、add-rule 默认进 inbox、record-fix 输出路径。

修改文件：

- `AGENT.md`
  - 追加“团队知识库钩子”章节，保留原有评论和内容，不改写无关段落。

暂不创建根目录 `AGENTS.md`，避免和现有 `AGENT.md` 入口产生重复。第一版先在 `tool-adapters/AGENTS.md` 提供可复制片段。

## 命令接口

第一版支持：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "实体图谱 queryEntityGraph"
node agent-knowledge/bin/agent-knowledge.js search "实体图谱"
node agent-knowledge/bin/agent-knowledge.js add-rule "聚合接口实体集合和映射来源必须一致"
node agent-knowledge/bin/agent-knowledge.js add-rule "已确认规则" --confirmed
node agent-knowledge/bin/agent-knowledge.js record-fix --type bug --title "实体图谱 ownerId 为空"
```

包装器支持：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 before-task "实体图谱 queryEntityGraph"
```

```bash
./agent-knowledge/bin/agent-knowledge.sh before-task "实体图谱 queryEntityGraph"
```

## Task 1: 建立目录、模板和种子知识

**Files:**

- Create: `agent-knowledge/README.md`
- Create: `agent-knowledge/templates/rule.md`
- Create: `agent-knowledge/templates/fix-record.md`
- Create: `agent-knowledge/templates/domain-note.md`
- Create: `agent-knowledge/knowledge/rules/aggregation-data-source-consistency.md`
- Create: `agent-knowledge/knowledge/service-map/rpc-local-dependency-map.md`
- Create: `agent-knowledge/inbox/README.md`

- [ ] **Step 1: 创建目录结构**

Run:

```powershell
New-Item -ItemType Directory -Force agent-knowledge, agent-knowledge\bin, agent-knowledge\templates, agent-knowledge\knowledge\rules, agent-knowledge\knowledge\pitfalls, agent-knowledge\knowledge\domain, agent-knowledge\knowledge\service-map, agent-knowledge\inbox\rules, agent-knowledge\inbox\fixes, agent-knowledge\inbox\prd-corrections, agent-knowledge\inbox\tech-solution-corrections, agent-knowledge\tool-adapters, agent-knowledge\tests
```

Expected: 所有目录创建成功。

- [ ] **Step 2: 编写 `agent-knowledge/README.md`**

要求包含：

- 这个钩子解决什么问题。
- `before-task`、`search`、`add-rule`、`record-fix` 的使用方式。
- `knowledge/` 和 `inbox/` 的区别。
- 为什么默认 `add-rule` 进入 `inbox/rules/`。
- 跨平台入口说明。

- [ ] **Step 3: 编写三份模板**

`rule.md` 必须包含：

```markdown
---
title:
tags: []
scope:
services: []
status: draft
updated:
---

# {{title}}

## 规则

## 适用范围

## 为什么

## 正例

## 反例

## 证据来源
```

`fix-record.md` 必须包含：

```markdown
---
title:
type: bug
tags: []
status: pending
updated:
---

# {{title}}

## 问题现象

## 错误判断或错误方案

## 人工纠正后的结论

## 证据链

- 失败点：
- 实际调用链：
- 最终数据源：
- 关键参数：

## 最小修复方式

## 是否应沉淀为长期规则
```

`domain-note.md` 必须包含：

```markdown
---
title:
tags: []
scope: domain
status: draft
updated:
---

# {{title}}

## 业务知识

## 适用场景

## 约束来源

## 相关系统或接口
```

- [ ] **Step 4: 编写数据源一致性种子知识**

内容从设计文档和当前 AGENTS 规则中提炼，必须写清：

- 规则：聚合接口实体集合和映射数据必须来自同一上游关系范围。
- 反例：`queryEntityGraph` 中 实体集合和 `entityId -> ownerId` 映射来自不同 Facade。
- 分析要求：先找最终赋值点、真实数据源和关键参数，再决定修复。

- [ ] **Step 5: 编写 RPC 本地依赖索引种子知识**

参考公开示例映射，把目录映射整理到 `agent-knowledge/knowledge/service-map/rpc-local-dependency-map.md`。

要求：

- 保留“先查 `@RpcReference`、实际入参和最终调用点”的规则。
- 保留接口前缀、本地仓库、重点目录映射。
- 标注这是 `service-map` 类型知识。

- [ ] **Step 6: 验证 UTF-8 无 BOM**

Run:

```powershell
Get-Content -Encoding Byte -TotalCount 3 agent-knowledge\README.md
```

Expected: 第一字节不是 `239`，也就是没有 BOM。

## Task 2: 编写 CLI 测试

**Files:**

- Create: `agent-knowledge/package.json`
- Create: `agent-knowledge/tests/agent-knowledge.test.js`

- [ ] **Step 1: 编写 `package.json`**

内容：

```json
{
  "name": "agent-knowledge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test tests/*.test.js"
  }
}
```

- [ ] **Step 2: 写关键词提取测试**

测试输入：

```text
修复 queryEntityGraph 实体图谱 ownerId 为空的问题，涉及 EntityGraphService.java
```

期望关键词至少包含：

```text
queryEntityGraph
实体图谱
ownerId
EntityGraphService
Entity
Graph
Service
```

- [ ] **Step 3: 写搜索排序测试**

创建临时知识库：

- 一个文件 frontmatter `tags: [aggregation, datasource]`
- 一个文件正文命中关键词
- 一个文件不相关

期望：

- 命中 tag 的结果排在只命中正文的结果前。
- 不相关文件不返回。

- [ ] **Step 4: 写 `add-rule` 默认进 inbox 测试**

调用核心函数：

```javascript
addRule({ rootDir, title: "聚合接口数据源一致性", confirmed: false })
```

Expected:

- 文件创建在 `agent-knowledge/inbox/rules/`。
- frontmatter `status: draft`。

- [ ] **Step 5: 写 `add-rule --confirmed` 进 knowledge 测试**

调用核心函数：

```javascript
addRule({ rootDir, title: "已确认规则", confirmed: true })
```

Expected:

- 文件创建在 `agent-knowledge/knowledge/rules/`。
- frontmatter `status: confirmed`。

- [ ] **Step 6: 写 `record-fix` 输出路径测试**

调用核心函数：

```javascript
recordFix({ rootDir, type: "prd", title: "PRD 字段含义纠偏" })
```

Expected:

- 文件创建在 `agent-knowledge/inbox/prd-corrections/`。
- 模板中包含“证据链”。

- [ ] **Step 7: 运行测试确认失败**

Run:

```powershell
npm run test
```

Workdir: `C:\workspace\agent-knowledge-hook\agent-knowledge`

Expected: 在 Task 2 阶段应失败，因为当时核心实现尚未创建；最终实现完成后该测试套件应全部通过。

## Task 3: 实现 Node 核心 CLI

**Files:**

- Create: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [ ] **Step 1: 实现命令解析**

支持：

- `before-task <text>`
- `search <text>`
- `add-rule <title> [--confirmed]`
- `record-fix --type <bug|prd|tech> --title <title>`
- `--help`

未知命令返回非 0，并输出可读错误。

- [ ] **Step 2: 实现 `extractKeywords(text)`**

确定性策略：

- 保留长度大于等于 2 的中文连续片段。
- 保留英文、数字、下划线组成的标识符。
- 对驼峰标识符追加拆分词，例如 `EntityGraphService` 追加 `Entity`、`Graph`、`Service`。
- 去重，保持出现顺序。
- 过滤过短英文词和常见停用词。

- [ ] **Step 3: 实现 Markdown 文件扫描**

扫描范围：

- `agent-knowledge/knowledge/**/*.md`
- `agent-knowledge/inbox/**/*.md`

解析内容：

- 文件相对路径。
- frontmatter 原文。
- 标题行。
- 正文。

不引入 YAML 依赖，第一版只做简单文本匹配。

- [ ] **Step 4: 实现搜索打分**

打分规则：

- 文件名命中：+8。
- 标题命中：+8。
- frontmatter 命中：+6。
- 正文命中：+2。
- `knowledge/` 结果额外 +2。
- `inbox/` 结果保留但标注“待确认”。

输出分组：

- `必须阅读`：分数大于等于 8 且位于 `knowledge/`。
- `可能相关`：其他有分结果。

- [ ] **Step 5: 实现 `before-task`**

输出必须包含：

- 关键词列表。
- 必须阅读项。
- 可能相关项。
- 执行要求：先读必须阅读项，再分析代码；BUG 类结论必须说明证据链。

- [ ] **Step 6: 实现 `search`**

输出包含：

- 关键词列表。
- 按分数排序的命中文件。
- 每条结果显示相对路径、分数、命中位置。

- [ ] **Step 7: 实现 `addRule`**

规则：

- 默认写入 `agent-knowledge/inbox/rules/`。
- `--confirmed` 写入 `agent-knowledge/knowledge/rules/`。
- 文件名使用日期 + slug，例如 `2026-07-06-aggregation-data-source-consistency.md`。
- 中文标题无法生成英文 slug 时，使用安全的拼音不做要求，退化为 `rule-YYYYMMDD-HHMMSS.md`。
- 写入 UTF-8 无 BOM。

- [ ] **Step 8: 实现 `recordFix`**

规则：

- `--type bug` 写入 `inbox/fixes/`。
- `--type prd` 写入 `inbox/prd-corrections/`。
- `--type tech` 写入 `inbox/tech-solution-corrections/`。
- 缺少 title 时使用 `fix-YYYYMMDD-HHMMSS.md`。
- 内容必须来自 `templates/fix-record.md`。

- [ ] **Step 9: 导出测试所需函数**

导出：

```javascript
export {
  extractKeywords,
  searchKnowledge,
  addRule,
  recordFix
};
```

- [ ] **Step 10: 运行测试**

Run:

```powershell
npm run test
```

Workdir: `C:\workspace\agent-knowledge-hook\agent-knowledge`

Expected: 全部通过。

## Task 4: 实现跨平台包装器

**Files:**

- Create: `agent-knowledge/bin/agent-knowledge.ps1`
- Create: `agent-knowledge/bin/agent-knowledge.sh`

- [ ] **Step 1: 编写 PowerShell 包装器**

要求：

- 使用 `$PSScriptRoot` 定位 `agent-knowledge.js`。
- 原样转发所有参数。
- 不改变控制台编码。

核心逻辑：

```powershell
$ScriptPath = Join-Path $PSScriptRoot "agent-knowledge.js"
node $ScriptPath @args
exit $LASTEXITCODE
```

- [ ] **Step 2: 编写 sh 包装器**

要求：

- 使用脚本所在目录定位 `agent-knowledge.js`。
- 原样转发所有参数。

核心逻辑：

```sh
#!/usr/bin/env sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
node "$SCRIPT_DIR/agent-knowledge.js" "$@"
```

- [ ] **Step 3: 验证 PowerShell 包装器**

Run:

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 before-task "queryEntityGraph 实体图谱"
```

Expected: 输出关键词和至少一条相关知识。

- [ ] **Step 4: 验证 Node 直接入口**

Run:

```powershell
node agent-knowledge\bin\agent-knowledge.js search "RPC 本地依赖"
```

Expected: 返回 `knowledge/service-map/rpc-local-dependency-map.md`。

## Task 5: 接入工具适配说明

**Files:**

- Create: `agent-knowledge/tool-adapters/AGENTS.md`
- Create: `agent-knowledge/tool-adapters/CLAUDE.md`
- Create: `agent-knowledge/tool-adapters/opencode.md`
- Create: `.opencode/command/knowledge.before-task.md`
- Create: `.opencode/command/knowledge.record-fix.md`
- Modify: `AGENT.md`

- [ ] **Step 1: 编写 AGENTS 接入片段**

必须包含：

- 分析需求、BUG、技术方案前运行 `agent-knowledge before-task`。
- 如果输出“必须阅读”，先读完再给结论。
- 发生人工纠错后使用 `record-fix`。
- 不能把 `inbox/` 内容当成强规则直接套用。

- [ ] **Step 2: 编写 Claude 接入片段**

内容与 AGENTS 片段一致，但命令示例使用：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 before-task "<任务描述>"
```

- [ ] **Step 3: 编写 OpenCode 接入片段**

说明 `.opencode/command/knowledge.before-task.md` 和 `.opencode/command/knowledge.record-fix.md` 的使用场景。

- [ ] **Step 4: 新增 OpenCode 命令文件**

`knowledge.before-task.md` 要求 AI：

- 接收任务描述。
- 运行 `agent-knowledge`。
- 读取必须阅读项。
- 再继续分析。

`knowledge.record-fix.md` 要求 AI：

- 在人工纠正 PRD、技术方案、BUG 分析后调用。
- 生成 `inbox/` 记录。
- 在最终答复里提示记录路径。

- [ ] **Step 5: 追加更新 `AGENT.md`**

只在文件末尾追加“团队知识库钩子”章节，不改写已有章节。

追加内容必须说明：

- 何时调用 `before-task`。
- 何时调用 `record-fix`。
- `inbox/` 与 `knowledge/` 的权威性差异。

## Task 6: 端到端验证

**Files:**

- Modify: `agent-knowledge/README.md`

- [ ] **Step 1: 运行测试**

Run:

```powershell
npm run test
```

Workdir: `C:\workspace\agent-knowledge-hook\agent-knowledge`

Expected: 全部通过。

- [ ] **Step 2: 验证 `before-task` 能命中种子知识**

Run:

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

Expected:

- 输出 `queryEntityGraph`、`实体图谱`、`ownerId` 等关键词。
- 必须阅读或可能相关中包含数据源一致性知识。

- [ ] **Step 3: 验证 `add-rule` 默认进入 inbox**

Run:

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 add-rule "测试规则默认进入 inbox"
```

Expected:

- 创建文件路径位于 `agent-knowledge/inbox/rules/`。
- 输出路径。

清理说明：

- 这一步产生的是验证文件，提交前应删除该验证文件，或改用测试临时目录验证。

- [ ] **Step 4: 验证 `record-fix`**

Run:

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 record-fix --type bug --title "实体图谱 ownerId 为空"
```

Expected:

- 创建文件路径位于 `agent-knowledge/inbox/fixes/`。
- 文件包含“证据链”。

清理说明：

- 如果只是验证生成能力，提交前删除该验证文件。

- [ ] **Step 5: 验证编码**

Run:

```powershell
Get-ChildItem -Recurse agent-knowledge -File | Where-Object { $_.Extension -in ".md",".js",".json",".ps1",".sh" } | ForEach-Object { $bytes = Get-Content -Encoding Byte -TotalCount 3 $_.FullName; if ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { $_.FullName } }
```

Expected: 无输出。

- [ ] **Step 6: 更新 README 的验证结果**

把实际验证命令和结果简要写入 `agent-knowledge/README.md` 的“本地验证”章节。

## Task 7: 最终检查和提交准备

**Files:**

- All files above

- [ ] **Step 1: 查看本次新增和修改**

Run:

```powershell
git status --short agent-knowledge .opencode\command\knowledge.before-task.md .opencode\command\knowledge.record-fix.md AGENT.md docs\superpowers\specs\2026-07-06-agent-knowledge-hook-design.md docs\superpowers\plans\2026-07-06-agent-knowledge-hook.md
```

Expected: 只包含本次设计、计划和 agent-knowledge 相关文件。

- [ ] **Step 2: 搜索关键命令**

Run:

```powershell
rg -n "before-task|record-fix|add-rule|knowledge/|inbox/" agent-knowledge AGENT.md .opencode\command docs\superpowers
```

Expected: README、工具适配、设计文档、计划文档都能搜到关键说明。

- [ ] **Step 3: 最终测试**

Run:

```powershell
npm run test
```

Workdir: `C:\workspace\agent-knowledge-hook\agent-knowledge`

Expected: 全部通过。

- [ ] **Step 4: 提交前确认无 BOM**

Run:

```powershell
Get-ChildItem -Recurse agent-knowledge, docs\superpowers -File | Where-Object { $_.Extension -in ".md",".js",".json",".ps1",".sh" } | ForEach-Object { $bytes = Get-Content -Encoding Byte -TotalCount 3 $_.FullName; if ($bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) { $_.FullName } }
```

Expected: 无输出。

- [ ] **Step 5: 精确暂存本次文件**

Run:

```powershell
git add agent-knowledge .opencode\command\knowledge.before-task.md .opencode\command\knowledge.record-fix.md AGENT.md docs\superpowers\specs\2026-07-06-agent-knowledge-hook-design.md docs\superpowers\plans\2026-07-06-agent-knowledge-hook.md
```

Expected: 只暂存本次相关文件。

- [ ] **Step 6: 中文提交**

Run:

```powershell
git commit -m "新增 AI 团队知识库命令式钩子"
```

Expected: 生成中文提交信息的提交。
