# AI 团队知识库命令式钩子设计

## 1. 背景

AI 工具可以快速阅读代码结构，但很难自动还原团队里的隐性知识，例如：

1. 多个服务之间真实的数据来源和调用边界。
2. 历史上踩过的坑，以及为什么当时选择某个实现。
3. PRD、技术方案、BUG 修复过程中被人工纠正过的问题。
4. 不成文但需要长期遵守的业务规则和工程约束。

如果这些知识只存在于人脑、聊天记录或一次性评审意见里，不同 AI 或不同开发者会反复踩同一个坑。需要建立一条轻量通路，让 AI 在任务开始前能读取相关知识，并在纠错后把经验沉淀回知识库。

## 2. 目标

第一版采用命令式钩子方案，目标是：

1. 提供一套可被 Codex、Claude、OpenCode 等工具共同调用的本地命令。
2. 让任务开始前的知识读取变成固定动作，而不是靠 AI 临时想起。
3. 支持人工主动补全不成文规则、业务知识、服务关系。
4. 支持 PRD 纠偏、技术方案纠偏、BUG 修复后的经验记录。
5. 所有知识以 Markdown 存储，便于审查、搜索、diff 和提交。

## 3. 非目标

第一版不做以下事情：

1. 不建设服务端知识库或 Web 后台。
2. 不引入向量数据库、embedding 或联网检索。
3. 不自动判定一条纠错记录是否应该成为长期知识。
4. 不依赖某个 AI 工具私有的 hook 生命周期。
5. 不把扫描出来的代码结构当成业务知识的替代品。

## 4. 总体方案

建立仓库内共享目录 `agent-knowledge/`，提供一个跨工具命令 `agent-knowledge`。Codex、Claude、OpenCode 只需要在各自的规则入口里约定何时调用该命令。

建议目录：

```text
agent-knowledge/
  README.md
  bin/
    agent-knowledge.ps1
  knowledge/
    rules/
    pitfalls/
    domain/
    service-map/
  inbox/
    fixes/
    prd-corrections/
    tech-solution-corrections/
  templates/
    rule.md
    fix-record.md
    domain-note.md
  tool-adapters/
    AGENTS.md
    CLAUDE.md
    opencode.md
```

各目录职责：

1. `bin/` 放可执行脚本，是所有工具调用的唯一实现入口。
2. `knowledge/` 放已经确认的长期知识。
3. `inbox/` 放待人工确认或待上线后归档的纠错记录。
4. `templates/` 放人工补知识和 AI 记录问题时使用的结构化模板。
5. `tool-adapters/` 放不同 AI 工具的接入说明，可复制到 `AGENTS.md`、`CLAUDE.md` 或 `.opencode/command/`。

## 5. Hook 能力如何工作

这里的 hook 不是指必须接入某个工具的私有回调 API，而是指“在 AI 工作流的关键节点强制执行一条统一命令”。这样可以避免 Codex、Claude、OpenCode 各写一套逻辑。

### 5.1 任务开始前：before-task

AI 接到任务后，先运行：

```powershell
agent-knowledge before-task "用户任务或问题描述"
```

命令会做三件事：

1. 从任务描述、当前目录、可选文件路径中提取关键词，例如服务名、接口名、业务名、模块名。
2. 在 `knowledge/` 下按标签、标题、文件名和正文进行本地搜索。
3. 输出两类结果：必须阅读项和可能相关项。

输出示例：

```text
必须阅读：
- agent-knowledge/knowledge/service-map/rpc-local-dependency-map.md
- agent-knowledge/knowledge/pitfalls/queryEntityGraph-source-split.md

可能相关：
- agent-knowledge/knowledge/rules/aggregation-data-source-consistency.md

执行要求：
- 先阅读必须阅读项，再分析代码。
- 结论必须说明失败点、实际数据源、关键参数和为什么修复足够。
```

AI 工具随后按输出读取对应文件，再进入代码分析。这个动作解决的是“AI 开始干活前不知道有哪些历史坑”的问题。

### 5.2 人工主动补全：add-rule

当团队想把不成文规则写入知识库时，运行：

```powershell
agent-knowledge add-rule "聚合接口必须保持实体集合和映射来源一致"
```

命令根据模板生成一份草稿，默认放到 `knowledge/rules/` 或 `inbox/`。草稿必须包含：

1. 规则名称。
2. 适用范围。
3. 为什么存在这条规则。
4. 正例和反例。
5. 相关代码、接口或历史问题链接。

非显而易见的业务规则必须写明来源，避免把个人偏好沉淀成团队规则。

### 5.3 纠错反哺：record-fix

当 PRD、技术方案或 BUG 修复过程中发生人工纠错时，运行：

```powershell
agent-knowledge record-fix
```

命令生成一条待归档记录，默认进入 `inbox/fixes/`、`inbox/prd-corrections/` 或 `inbox/tech-solution-corrections/`。

纠错记录必须包含：

1. 问题现象。
2. 错误判断或错误方案。
3. 人工纠正后的结论。
4. 证据链：失败点、实际调用链、最终数据源、关键参数。
5. 最小修复方式。
6. 后续是否应沉淀为长期规则。

这一步不会自动把所有纠错都变成正式知识。`inbox/` 是缓冲区，避免把一次临时判断污染成长期规则。

### 5.4 检索：search

当 AI 或人需要主动查历史知识时，运行：

```powershell
agent-knowledge search "实体图谱 实体归属"
```

命令只做本地检索，优先返回 `knowledge/` 中已确认内容，再返回 `inbox/` 中待确认记录。第一版不做语义检索，避免引入额外服务和不可审查结果。

## 6. 工具接入方式

### 6.1 Codex

在仓库级 `AGENTS.md` 中加入规则：

1. 分析需求、BUG、技术方案前，必须运行 `agent-knowledge before-task "<任务描述>"`。
2. 如果输出了必须阅读项，必须先读完再给结论或改代码。
3. 当修复中发生人工纠正，结束前必须运行 `agent-knowledge record-fix` 或按模板补充记录。

### 6.2 Claude

在 `CLAUDE.md` 中加入同样规则，或提供一个 `/knowledge-before-task` 命令文件。Claude 不需要理解脚本内部细节，只负责按阶段调用命令并读取输出文件。

### 6.3 OpenCode

在 `.opencode/command/` 下增加知识库命令说明，例如：

```text
.opencode/command/knowledge.before-task.md
.opencode/command/knowledge.record-fix.md
```

OpenCode 的命令文件只描述调用时机和命令参数，实际逻辑复用 `agent-knowledge.js`；`agent-knowledge.ps1` 和 `agent-knowledge.sh` 只作为不同平台的包装器。

## 7. 知识文件格式

每个知识文件采用 Markdown，建议包含简单 frontmatter：

```markdown
---
title: 聚合接口数据源一致性
tags: [aggregation, datasource, graph]
scope: backend
services: [graph-service, catalog-service]
status: confirmed
updated: 2026-07-06
---

# 聚合接口数据源一致性

## 规则

聚合接口中，响应实体集合和映射数据必须来自同一上游关系范围，除非代码、查询或接口契约证明两个来源完全一致。

## 为什么

不同 Facade 返回的实体范围可能不同，混用会导致映射字段为空或错配。

## 证据

- 失败点：
- 实际数据源：
- 关键参数：
- 最小修复：
```

## 8. 质量约束

1. 知识库文件必须使用 UTF-8 无 BOM。
2. AI 不能只因为搜索命中就直接改代码，仍需沿真实调用链验证。
3. `knowledge/` 只放已确认长期有效的规则和知识。
4. `inbox/` 内容默认是待确认材料，不能当成强规则直接套用。
5. 每条 BUG 类经验必须写清证据链，避免变成模糊口号。
6. 不允许用兜底逻辑掩盖数据源不一致、参数不一致或职责边界错误。

## 9. 第一版验收标准

第一版完成后应满足：

1. 在 Codex、Claude、OpenCode 中都能看到明确的接入说明。
2. 任务开始前能通过 `before-task` 查到相关知识文件。
3. 人工可以用模板补充规则、业务知识和历史坑。
4. BUG 修复或方案纠偏后能生成结构化记录到 `inbox/`。
5. 所有知识文件可被 `rg`、Git diff 和代码评审直接审查。

## 10. 后续演进

后续可以在第一版稳定后再考虑：

1. 增加索引文件，减少每次全文扫描成本。
2. 增加 `promote` 命令，把 `inbox/` 记录转为正式知识。
3. 增加 CI 检查，确保知识文件格式和 UTF-8 编码正确。
4. 增加向量检索，但必须保留 Markdown 原文作为最终证据来源。
