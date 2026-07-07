# AI 团队知识库命令式钩子

`agent-knowledge/` 用来沉淀团队里的长期业务规则、服务边界、历史坑和人工纠错结论。它解决的问题是：AI 在分析需求、BUG 或技术方案时，不能只靠临时搜索代码，还要先读取团队已经确认过的隐性知识，避免重复踩同一个数据源、参数或服务边界错误。

第一版采用命令式钩子：不同 AI 工具在关键节点调用同一条本地命令，再按输出读取 Markdown 知识文件。知识文件仍然可被 `rg`、Git diff 和代码评审直接审查。

当前版本已经提供知识库目录、模板、种子知识、Node 核心命令和跨平台包装器。

## 日常短命令

日常使用优先使用 PowerShell 短命令包装器 `ak.ps1`。它会自动解析知识库根目录，并根据项目名找到项目路径和项目知识文件：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\ak.ps1 check poseidon
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\ak.ps1 refresh poseidon "同步本次需求变化"
```

如果希望当前 PowerShell 会话里直接输入 `ak`，可以设置别名：

```powershell
Set-Alias ak C:\workspace\agent-knowledge-hook\agent-knowledge\bin\ak.ps1
ak task "分析实体图谱 ownerId 为空"
ak check poseidon
ak refresh poseidon "同步本次需求合并后的模块变化"
ak bug "学习报告统计口径错误"
ak rule "聚合接口实体集合和映射来源必须一致"
```

短命令清单：

| 短命令 | 作用 |
| --- | --- |
| `ak task <任务描述>` | 任务开始前检索知识，等价于 `before-task` |
| `ak search <关键词>` | 搜索知识库 |
| `ak projects` | 列出项目索引中已登记的项目 |
| `ak check <项目名>` | 自动执行项目知识过期检查 |
| `ak refresh <项目名> [说明]` | 自动刷新项目知识元数据 |
| `ak bug <标题>` | 记录 BUG 纠错到 inbox |
| `ak prd <标题>` | 记录 PRD 纠错到 inbox |
| `ak tech <标题>` | 记录技术方案纠错到 inbox |
| `ak rule <规则标题> [--confirmed]` | 新增规则草稿或确认规则 |
| `ak raw <原始参数>` | 透传到底层 CLI |

`ak check <项目名>` 和 `ak refresh <项目名>` 依赖项目知识文件中的 `project_root`，或 `knowledge/service-map/workspace-projects.md` 中的项目路径。真实团队使用时，推荐设置 `AGENT_KNOWLEDGE_ROOT` 或把 `team-agent-knowledge` 与 `agent-knowledge-hook` 放在同一工作区下。

## 命令语法

以下示例说明命令职责和调用时机。如果团队尚未安装全局 `agent-knowledge` 命令，可以从仓库根目录使用 `node agent-knowledge/bin/agent-knowledge.js ...`，或在 Windows 上使用 `.\agent-knowledge\bin\agent-knowledge.ps1 ...`。

完整命令清单：

```text
agent-knowledge before-task <text>
agent-knowledge search <text>
agent-knowledge add-rule <title> [--confirmed]
agent-knowledge record-fix --type <bug|prd|tech> --title <title>
agent-knowledge check-stale --project-root <path> --knowledge-file <path>
agent-knowledge refresh-project --project-root <path> --knowledge-file <path> [--summary <text>]
```

通用选项：

```text
--knowledge-root <path>
```

如果没有传 `--knowledge-root`，命令会优先读取环境变量 `AGENT_KNOWLEDGE_ROOT`；如果环境变量也不存在，则使用当前工具目录内置的示例知识库。

## 命令使用姿势

### before-task

任务开始前先检索相关知识：

```powershell
agent-knowledge before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

`before-task` 的输出会把结果分成“必须阅读”和“可能相关”。AI 工具应先阅读必须阅读项，再进入代码分析。这个命令只读知识库，不写文件。

在 Codex 的 `AGENTS.md` 中可以配置成固定动作：

```markdown
Before analyzing a requirement, bug, or technical plan, run:

`node C:\workspace\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js before-task "<任务描述>" --knowledge-root C:\workspace\team-agent-knowledge`
```

### search

主动搜索历史知识：

```powershell
agent-knowledge search "实体图谱 实体归属"
```

`search` 适合临时查找某个关键词、服务关系、历史坑或项目说明。它只输出匹配文件和摘要，不写文件。

### add-rule

补充一条团队规则草稿：

```powershell
agent-knowledge add-rule "聚合接口实体集合和映射来源必须一致"
```

默认写入 `inbox/rules/`。这是为了让新规则先经过人工确认，避免把一次临时判断或个人偏好直接变成强规则。

如果规则已经由代码、接口契约、线上问题或团队共识确认，可以直接写入 `knowledge/rules/`：

```powershell
agent-knowledge add-rule "禁止在循环中逐条远程查询" --confirmed
```

写入后的 Markdown 只是模板，仍需要补充适用范围、证据和例外情况。

### record-fix

记录一次 BUG、PRD 或技术方案纠错：

```powershell
agent-knowledge record-fix --type bug --title "实体图谱 ownerId 为空"
```

`record-fix` 会根据 `--type` 写入不同的待确认目录：

| `--type` | 写入目录 | 典型用途 |
| --- | --- | --- |
| `bug` | `inbox/fixes/` | 记录一次 BUG 修复的失败点、原因、修复和验证方式 |
| `prd` | `inbox/prd-corrections/` | 记录 PRD 口径、字段、流程或边界被纠正的情况 |
| `tech` | `inbox/tech-solution-corrections/` | 记录技术方案设计、数据源、接口或性能策略被纠正的情况 |

这些记录进入 inbox 后，不会自动成为长期规则。需求上线或问题闭环后，再由人工整理到 `knowledge/`。

### check-stale

检查某个项目说明是否落后于项目当前 HEAD：

```powershell
agent-knowledge check-stale --project-root C:\workspace\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --knowledge-root C:\workspace\team-agent-knowledge
```

`check-stale` 会读取知识文件 frontmatter 中的 `last_scanned_commit`，再对比 `--project-root` 当前 `git rev-parse HEAD`。如果两者不同，输出“可能过期”；如果缺少 `last_scanned_commit`，也会提示需要刷新。它只做检测，不会自动覆盖人工知识。

常见使用时机：

- 开始处理某个项目相关任务前，先确认项目说明是否可能过期。
- 项目依赖、模块结构、Facade、Controller、Mapper 或关键业务入口发生变化后，用它提醒是否需要更新知识库。
- 多个项目都有关联时，对每个项目说明分别执行一次。

### refresh-project

在人工或 Codex 已完成正文核对后，刷新项目知识文件的元数据：

```powershell
agent-knowledge refresh-project --project-root C:\workspace\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --summary "同步 Facade 和模块结构变化" --knowledge-root C:\workspace\team-agent-knowledge
```

`refresh-project` 会更新 `updated`、`project_root`、`last_scanned_commit`，并在正文末尾追加“刷新记录”。它不会自动重写项目说明正文；正文里的业务规则、接口关系和证据链仍需要由 Codex 或人工基于当前代码确认后再修改。

推荐顺序：

1. 先运行 `check-stale`。
2. 如果提示可能过期，阅读当前代码、README、POM、路由、Facade、DTO、Mapper 或前端入口。
3. 手动或由 Codex 更新知识文件正文。
4. 正文确认后运行 `refresh-project`。
5. 将知识库变更提交到私有知识库仓库。

不要在没有核对正文的情况下只运行 `refresh-project`，否则 `last_scanned_commit` 会显示已刷新，但正文仍可能是旧内容。

### --knowledge-root 与环境变量

如果真实团队知识与工具仓库分离，使用 `--knowledge-root` 指向私有知识库根目录：

```powershell
node C:\workspace\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js before-task "分析 graph-service 实体归属" --knowledge-root C:\workspace\team-agent-knowledge
```

也可以设置环境变量，之后命令会默认使用该知识库：

```powershell
$env:AGENT_KNOWLEDGE_ROOT = "C:\workspace\team-agent-knowledge"
node C:\workspace\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js search "graph-service 项目职责"
```

`before-task` 和 `search` 的结果只提供知识入口。AI 仍必须沿真实调用链确认失败点、最终数据源和关键参数，不能因为搜索命中就直接改代码。

## 推荐工作流

一次完整任务可以按这个节奏使用：

1. `before-task`：开始前读取团队知识，尤其是强规则和项目索引。
2. `check-stale`：任务涉及具体项目说明时，检查知识文件是否落后于项目 HEAD。
3. 代码分析：回到真实项目确认入口、入参、最终数据源和赋值点。
4. 更新正文：如果项目结构、服务边界或业务规则变化，先改知识文件正文。
5. `refresh-project`：正文确认后刷新 `last_scanned_commit` 和刷新记录。
6. `record-fix`：如果开发中被纠正了 BUG、PRD 或技术方案，写入 inbox。
7. `add-rule`：如果形成长期规则，先进入 inbox；确认后再进入 `knowledge/rules/`。

## knowledge 与 inbox

`knowledge/` 存放已经确认长期有效的知识，包括规则、业务知识、历史坑和服务映射。这里的内容可以作为任务分析的强约束，但仍要结合实际代码路径验证。

`inbox/` 存放待确认材料，包括规则草稿、纠错记录、PRD 纠偏和技术方案纠偏。这里的内容是缓冲区，不能直接当成长期规则套用，必须经过人工确认后再整理进 `knowledge/`。

`add-rule` 默认写入 `inbox/rules/`，原因是新规则通常还没有经过代码、接口契约、线上问题或团队共识验证。先进入 inbox 可以避免把一次临时判断或个人偏好沉淀成仓库级强规则。

推荐把工具仓库和真实知识仓库分离：

```text
agent-knowledge-hook
= CLI、模板、适配说明、脱敏示例和测试

team-agent-knowledge
= 真实项目说明、服务关系、业务规则、历史坑和纠错记录
```

私有知识库根目录可以直接包含 `knowledge/` 和 `inbox/`：

```text
team-agent-knowledge/
  knowledge/
    service-map/
    domain/
    rules/
    pitfalls/
  inbox/
    rules/
    fixes/
    prd-corrections/
    tech-solution-corrections/
```

## 目录说明

- `bin/`：跨工具命令入口。
- `templates/`：规则、纠错记录和业务知识模板。
- `knowledge/rules/`：已确认的工程或业务规则。
- `knowledge/pitfalls/`：已确认的历史坑。
- `knowledge/domain/`：已确认的业务知识。
- `knowledge/service-map/`：已确认的服务、接口和本地仓库映射。
- `inbox/rules/`：待确认规则草稿。
- `inbox/fixes/`：待确认 BUG 修复记录。
- `inbox/prd-corrections/`：待确认 PRD 纠偏记录。
- `inbox/tech-solution-corrections/`：待确认技术方案纠偏记录。
- `tool-adapters/`：不同 AI 工具的接入说明。
- `tests/`：命令和知识库行为测试。

## 跨平台入口

统一入口命令叫 `agent-knowledge`。不同平台可以使用对应包装器调用同一套核心逻辑：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 before-task "<任务描述>"
```

```bash
./agent-knowledge/bin/agent-knowledge.sh before-task "<任务描述>"
```

也可以在本地直接调用 Node 入口：

```powershell
node agent-knowledge\bin\agent-knowledge.js search "RPC 本地依赖"
```

无论从 Codex、Claude 还是 OpenCode 调用，都应遵循同一规则：先读 `before-task` 输出的必须阅读项，再分析代码；发生人工纠错后，用 `record-fix` 或模板把证据链沉淀到 `inbox/`。

## 本地验证

2026-07-06 在 Windows PowerShell 环境完成以下验证。以下命令均从仓库根目录执行，例如：

```powershell
cd C:\workspace\agent-knowledge-hook
```

```powershell
Push-Location agent-knowledge
npm.cmd run test
Pop-Location
```

结果：`tests/*.test.js` 全部通过，19 个测试全部成功。测试覆盖 `add-rule` 默认写入临时 `rootDir` 下的 `inbox/rules/`，`--knowledge-root` / `AGENT_KNOWLEDGE_ROOT` 指向分离知识库，`check-stale` 检测知识文件落后于项目 HEAD，`refresh-project` 刷新知识文件项目元数据，以及 `record-fix` 输出到临时目录下的纠错目录，验证过程不会污染真实 `agent-knowledge/inbox`。

PowerShell 直接执行 `.ps1` 可能被执行策略拦截，因此本地验证使用 `-ExecutionPolicy Bypass` 显式运行包装器：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\agent-knowledge.ps1 before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

结果：输出关键词包含 `queryEntityGraph`、`实体图谱`、`ownerId`，必须阅读项命中 `knowledge/rules/aggregation-data-source-consistency.md`，可能相关项也按待确认知识标识输出。

```powershell
node agent-knowledge\bin\agent-knowledge.js search "RPC 本地依赖"
```

结果：命中 `knowledge/service-map/rpc-local-dependency-map.md`。

```powershell
$extensions = @('.md', '.js', '.json', '.ps1', '.sh')
Get-ChildItem -Path agent-knowledge -Recurse -File |
  Where-Object { $extensions -contains $_.Extension.ToLowerInvariant() } |
  Where-Object {
    $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
    $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  }
```

结果：未发现带 UTF-8 BOM 的 `.md`、`.js`、`.json`、`.ps1`、`.sh` 文件。
