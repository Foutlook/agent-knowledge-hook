# AI 团队知识库命令式钩子

`agent-knowledge/` 用来沉淀团队里的长期业务规则、服务边界、历史坑和人工纠错结论。它解决的问题是：AI 在分析需求、BUG 或技术方案时，不能只靠临时搜索代码，还要先读取团队已经确认过的隐性知识，避免重复踩同一个数据源、参数或服务边界错误。

第一版采用命令式钩子：不同 AI 工具在关键节点调用同一条本地命令，再按输出读取 Markdown 知识文件。知识文件仍然可被 `rg`、Git diff 和代码评审直接审查。

当前版本已经提供知识库目录、模板、种子知识、Node 核心命令和跨平台包装器。

## 命令语法

以下示例说明命令职责和调用时机。如果团队尚未安装全局 `agent-knowledge` 命令，可以从仓库根目录使用 `node agent-knowledge/bin/agent-knowledge.js ...`，或在 Windows 上使用 `.\agent-knowledge\bin\agent-knowledge.ps1 ...`。

任务开始前先检索相关知识：

```powershell
agent-knowledge before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

主动搜索历史知识：

```powershell
agent-knowledge search "实体图谱 实体归属"
```

补充一条团队规则草稿：

```powershell
agent-knowledge add-rule "聚合接口实体集合和映射来源必须一致"
```

记录一次 BUG、PRD 或技术方案纠错：

```powershell
agent-knowledge record-fix --type bug --title "实体图谱 ownerId 为空"
```

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

结果：`tests/*.test.js` 全部通过，17 个测试全部成功。测试覆盖 `add-rule` 默认写入临时 `rootDir` 下的 `inbox/rules/`，`--knowledge-root` / `AGENT_KNOWLEDGE_ROOT` 指向分离知识库，以及 `record-fix` 输出到临时目录下的纠错目录，验证过程不会污染真实 `agent-knowledge/inbox`。

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
