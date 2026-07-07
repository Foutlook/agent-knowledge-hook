# Agent Knowledge Hook

面向 Codex、Claude、OpenCode 等 AI 编程工具的团队知识库命令式钩子。

它解决的问题是：AI 在分析需求、BUG 或技术方案时，不能只靠临时代码搜索，还需要先读取团队已经确认过的业务知识、服务边界、历史坑和人工纠错记录，避免反复踩同一个问题。

## 快速使用

从仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\ak.ps1 task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

如果希望在当前 PowerShell 会话里直接使用 `ak`：

```powershell
Set-Alias ak C:\workspace\agent-knowledge-hook\agent-knowledge\bin\ak.ps1
ak check poseidon
ak refresh poseidon "同步本次需求变化"
ak bug "学习报告统计口径错误"
ak rule "聚合接口实体集合和映射来源必须一致"
```

底层 CLI 也可以直接调用：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

Windows PowerShell 包装器：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\agent-knowledge.ps1 before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

搜索知识库：

```powershell
node agent-knowledge/bin/agent-knowledge.js search "RPC 本地依赖"
```

真实团队知识建议放在私有知识库仓库中，再用 `--knowledge-root` 指向它：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "分析 graph-service 实体归属" --knowledge-root C:\workspace\team-agent-knowledge
```

也可以通过环境变量固定知识库位置：

```powershell
$env:AGENT_KNOWLEDGE_ROOT = "C:\workspace\team-agent-knowledge"
node agent-knowledge/bin/agent-knowledge.js search "graph-service 项目职责"
```

## 命令使用姿势

以下命令都可以用 `node agent-knowledge/bin/agent-knowledge.js ...` 调用；如果已把包装器加入 PATH，也可以直接使用 `agent-knowledge ...`。

日常使用优先使用短命令 `ak`：

| 短命令 | 等价动作 |
| --- | --- |
| `ak task <任务描述>` | `before-task <任务描述>` |
| `ak search <关键词>` | `search <关键词>` |
| `ak projects` | 列出知识库项目索引里的项目 |
| `ak check <项目名>` | 自动解析项目路径和知识文件后执行 `check-stale` |
| `ak refresh <项目名> [说明]` | 自动解析项目路径和知识文件后执行 `refresh-project` |
| `ak bug <标题>` | `record-fix --type bug --title <标题>` |
| `ak prd <标题>` | `record-fix --type prd --title <标题>` |
| `ak tech <标题>` | `record-fix --type tech --title <标题>` |
| `ak rule <规则标题> [--confirmed]` | `add-rule <规则标题> [--confirmed]` |
| `ak raw <原始参数>` | 透传到底层 `agent-knowledge` CLI |

| 命令 | 什么时候用 | 是否写文件 |
| --- | --- | --- |
| `before-task <任务描述>` | Codex / Claude / OpenCode 开始分析需求、BUG 或技术方案前调用 | 否 |
| `search <关键词>` | 临时查找某条规则、服务关系、历史坑或项目说明 | 否 |
| `add-rule <规则标题>` | 人工发现一条“不成文规则”，先进入待确认区 | 是，写入 `inbox/rules/` |
| `add-rule <规则标题> --confirmed` | 规则已经由代码、线上问题或团队共识确认 | 是，写入 `knowledge/rules/` |
| `record-fix --type <bug\|prd\|tech> --title <标题>` | 修复 BUG、纠正 PRD 或纠正技术方案后沉淀经验 | 是，写入对应 `inbox/` 目录 |
| `check-stale --project-root <项目路径> --knowledge-file <知识文件>` | 检查某个项目说明是否落后于项目当前 Git HEAD | 否 |
| `refresh-project --project-root <项目路径> --knowledge-file <知识文件>` | 人工或 AI 已核对正文后，刷新项目知识元数据 | 是，更新指定知识文件 |

任务开始前读取知识：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "修复 queryEntityGraph 实体图谱 ownerId 为空" --knowledge-root C:\workspace\team-agent-knowledge
```

按关键词搜索知识：

```powershell
node agent-knowledge/bin/agent-knowledge.js search "聚合接口 数据源一致" --knowledge-root C:\workspace\team-agent-knowledge
```

新增待确认规则草稿：

```powershell
node agent-knowledge/bin/agent-knowledge.js add-rule "聚合接口实体集合和映射来源必须一致" --knowledge-root C:\workspace\team-agent-knowledge
```

新增已确认规则：

```powershell
node agent-knowledge/bin/agent-knowledge.js add-rule "禁止在循环中逐条远程查询" --confirmed --knowledge-root C:\workspace\team-agent-knowledge
```

记录一次纠错。`--type bug` 写入 `inbox/fixes/`，`--type prd` 写入 `inbox/prd-corrections/`，`--type tech` 写入 `inbox/tech-solution-corrections/`：

```powershell
node agent-knowledge/bin/agent-knowledge.js record-fix --type bug --title "实体图谱 ownerId 为空" --knowledge-root C:\workspace\team-agent-knowledge
```

检查知识文件是否落后于项目当前 HEAD：

```powershell
node agent-knowledge/bin/agent-knowledge.js check-stale --project-root C:\workspace\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --knowledge-root C:\workspace\team-agent-knowledge
```

`check-stale` 只读取知识文件 frontmatter 里的 `last_scanned_commit` 并对比项目当前 `git rev-parse HEAD`，不会改写知识库。

刷新项目知识文件的元数据：

```powershell
node agent-knowledge/bin/agent-knowledge.js refresh-project --project-root C:\workspace\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --summary "同步 Facade 和模块结构变化" --knowledge-root C:\workspace\team-agent-knowledge
```

`refresh-project` 会更新 `updated`、`project_root`、`last_scanned_commit`，并追加“刷新记录”。它不会自动重写项目说明正文；正文里的业务边界、接口关系和证据链仍需要先由 Codex 或人工基于当前代码确认。

## 推荐工作流

1. 任务开始：运行 `before-task`，先读输出里的必须阅读项。
2. 涉及某个项目说明：运行 `check-stale` 判断知识文件是否落后于项目 HEAD。
3. 如果过期：让 Codex 或人工基于当前代码更新知识文件正文。
4. 正文确认后：运行 `refresh-project` 更新 `last_scanned_commit` 和刷新记录。
5. 开发过程中被纠正：用 `record-fix` 写入纠错 inbox。
6. 发现长期有效规则：先用 `add-rule` 进 `inbox/rules/`，确认后再整理进 `knowledge/rules/`。

## 知识库位置

默认情况下，命令会使用工具仓库内置的 `agent-knowledge/` 目录。真实团队使用时，推荐把知识库分离成私有仓库：

```text
agent-knowledge-hook
= CLI、模板、适配说明、脱敏示例和测试

team-agent-knowledge
= 真实项目说明、服务关系、业务规则、历史坑和纠错记录
```

分离后用 `--knowledge-root <path>` 或 `AGENT_KNOWLEDGE_ROOT` 指向私有知识库根目录。私有知识库根目录下应包含 `knowledge/` 和 `inbox/`。

## 跨平台入口

Node 入口：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "分析学习流程问题"
```

Windows PowerShell 包装器：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\agent-knowledge.ps1 before-task "分析学习流程问题"
```

macOS / Linux Shell 包装器：

```bash
./agent-knowledge/bin/agent-knowledge.sh before-task "分析学习流程问题"
```

短命令包装器当前提供 PowerShell 版本：

```powershell
.\agent-knowledge\bin\ak.ps1 check poseidon
.\agent-knowledge\bin\ak.ps1 refresh poseidon "同步本次需求变化"
```

## 项目结构

- `agent-knowledge/`：核心 CLI、模板、知识库和测试。
- `agent-knowledge/knowledge/`：脱敏示例知识；真实团队知识建议放入私有知识库。
- `agent-knowledge/inbox/`：脱敏示例缓冲区；真实纠错记录建议写入私有知识库的 `inbox/`。
- `agent-knowledge/tool-adapters/`：Codex / Claude / OpenCode 接入说明。
- `.opencode/command/`：OpenCode 命令入口。
- `docs/superpowers/`：设计文档和实施计划。
- `AGENT.md`：通用 AI 使用规范和知识库钩子入口规则。

## 验证

```powershell
Push-Location agent-knowledge
npm.cmd run test
Pop-Location
```

当前测试覆盖关键词提取、搜索排序、路径推导、分离知识库根目录、过期检测、项目刷新、写入目录、纠错记录模板和 UTF-8 无 BOM 写入。
