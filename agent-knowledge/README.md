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
Set-Alias ak <workspace-root>\agent-knowledge-hook\agent-knowledge\bin\ak.ps1
ak help
ak help check
ak task "分析实体图谱 ownerId 为空"
ak check poseidon
ak refresh poseidon "同步本次需求合并后的模块变化"
ak bug "学习报告统计口径错误"
ak resolve inbox/fixes/<纠错文件>.md
ak rule "聚合接口实体集合和映射来源必须一致"
ak doctor --json
```

`ak help` 会直接输出中文详细帮助；`ak help <命令>` 或 `<命令> --help` 会输出单条命令的用途、适用场景、是否写文件和底层动作：

```powershell
ak help refresh
ak check --help
ak rule --help
```

短命令清单：

以下结构化命令区块由命令契约自动生成，请勿手工修改。

<!-- BEGIN GENERATED: AK_COMMAND_TABLE -->
| 短命令 | 作用 |
| --- | --- |
| `ak task <任务描述>` | 任务开始前检索相关知识 |
| `ak search <关键词>` | 主动搜索知识库 |
| `ak projects` | 列出知识库项目索引中的项目 |
| `ak check <项目名>` | 检查项目知识文件是否落后于项目当前 HEAD |
| `ak refresh <项目名> [说明]` | 刷新项目知识文件的元数据和刷新记录 |
| `ak bug <标题> [--target <文件>]` | 记录 BUG 纠错到 inbox |
| `ak prd <标题> [--target <文件>]` | 记录 PRD 纠偏到 inbox |
| `ak tech <标题> [--target <文件>]` | 记录技术方案纠偏到 inbox |
| `ak rule <规则标题> [--confirmed]` | 新增规则草稿或确认规则 |
| `ak promote <inbox文件>` | 晋升普通草稿或不带 target 的独立 fix |
| `ak resolve <文件> [--confirm-legacy]` | 确认 targeted fix 已合入目标并归档审计 |
| `ak pending` | 列出 inbox 下待确认条目 |
| `ak adapters [--check]` | 同步或只读检查 OpenCode 命令适配器 |
| `ak doctor [--json]` | 检查知识库结构、引用、证据和适配器漂移 |
| `ak raw <原始参数>` | 透传到底层 agent-knowledge CLI |
<!-- END GENERATED: AK_COMMAND_TABLE -->

`ak check <项目名>` 和 `ak refresh <项目名>` 依赖项目知识文件中的 `project_root`，或 `knowledge/service-map/workspace-projects.md` 中的项目路径。真实团队使用时，推荐设置 `AGENT_KNOWLEDGE_ROOT` 或把 `team-agent-knowledge` 与 `agent-knowledge-hook` 放在同一工作区下。

## 命令语法

以下示例说明命令职责和调用时机。如果团队尚未安装全局 `agent-knowledge` 命令，可以从仓库根目录使用 `node agent-knowledge/bin/agent-knowledge.js ...`，或在 Windows 上使用 `.\agent-knowledge\bin\agent-knowledge.ps1 ...`。

完整命令清单：

<!-- BEGIN GENERATED: CLI_COMMAND_LIST -->
```text
agent-knowledge before-task <text> [--json]
agent-knowledge search <text> [--json]
agent-knowledge add-rule <title> [--confirmed]
agent-knowledge record-fix --type <bug|prd|tech> --title <title> [--target <path>]
agent-knowledge check-stale --project-root <path> --knowledge-file <path> [--deep] [--json]
agent-knowledge refresh-project --project-root <path> --knowledge-file <path> [--summary <text>]
agent-knowledge resolve-fix --file <path> [--confirm-legacy]
agent-knowledge promote --file <path>
agent-knowledge list-pending
agent-knowledge sync-adapters [--check]
agent-knowledge doctor [--json]
agent-knowledge sync-command-docs [--check] --repository-root <path>
```
<!-- END GENERATED: CLI_COMMAND_LIST -->

通用选项：

```text
--knowledge-root <path>
--repository-root <path>
--json
```

如果没有传 `--knowledge-root`，命令会优先读取环境变量 `AGENT_KNOWLEDGE_ROOT`；如果环境变量也不存在，则使用当前工具目录内置的示例知识库。

命令是否支持 `--json` 由统一命令契约维护，以本页上方生成命令清单中的 `[--json]` 标记为准。其中 `doctor --json` 无论检查通过还是发现 error，都会在 stdout 输出唯一的合法 JSON 对象，便于自动化管线直接解析。

CLI 会先按命令契约严格校验参数。未知参数、重复参数、缺失参数值、意外的位置参数，以及当前命令不支持的全局参数都会在任何业务读写前被拒绝。

兼容说明：`ak.ps1` 会给短命令统一注入 `--knowledge-root`，因此 `sync-adapters` 接受但不使用该参数；适配器模板仍只从 `--repository-root` 指向的工具仓库读取。

## 命令使用姿势

### before-task

任务开始前先检索相关知识：

```powershell
agent-knowledge before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

`before-task` 的输出会把结果分成“必须阅读”和“可能相关”。AI 工具应先阅读必须阅读项，再进入代码分析。这个命令只读知识库，不写文件。

检索增强说明：

- **同义词查询组**：`synonyms.json` 维护业务术语别名（如 `队列↔排队↔queue`、`错题本↔错题↔wrong-question`）。同一组内的大小写变体和多个别名只按一个查询意图计分，避免扩展词重复抬高覆盖率。中文短语还会按相邻 2-gram 切分（如 `队列为空` → `队列`），使长句里的关键词也能被召回。
- **查询组覆盖率排序**：结果先按「命中的查询组比例（coverage）」排序，再按标题/文件名整词精确命中加权，最后按累计得分。这样整词精确命中的文件不会被长正文靠零散词堆砌反超。
- **必须阅读分级**：只有 `knowledge/` 下的已确认知识，且查询组覆盖率不低于 50%，并由标题、文件名、frontmatter 高置信命中，或正文至少命中两个查询组且正文覆盖率不低于 60%，才进入“必须阅读”；最多 5 项，其余结果保留为“可能相关”。
- **命中摘要**：每项附带首个命中关键词附近的 `摘要`，减少逐一打开文件的成本。
- **任务时过期提示**：若知识文件 frontmatter 带有 `project_root` 与 `last_scanned_commit`，且项目 HEAD 已变，会在该项后标注 `⚠可能过期`，提醒先 `refresh-project`。

在 Codex 的 `AGENTS.md` 中可以配置成固定动作：

```markdown
Before analyzing a requirement, bug, or technical plan, run:

`node <workspace-root>\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js before-task "<任务描述>" --knowledge-root <workspace-root>\team-agent-knowledge`
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
agent-knowledge record-fix --type bug --title "实体图谱 ownerId 为空" --target knowledge/rules/entity-graph.md
```

先判断被纠正对象的生命周期：

- `inbox/` 中尚未确认的 `draft` / `pending` 草稿，直接修改原草稿，不额外创建 fix。
- 已进入 `knowledge/` 的正式知识，或独立的业务分析、BUG 结论、已输出技术方案被纠正时，才创建 fix。
- 已知被纠正的知识文件时使用 `--target` 建立关联；目标是未确认草稿时，命令会拒绝创建 fix，并提示直接修改原草稿。
- 不得让同一结论同时以原草稿和 fix 两种待确认形态重复存在。

`record-fix` 会根据 `--type` 写入不同的待确认目录：

| `--type` | 写入目录 | 典型用途 |
| --- | --- | --- |
| `bug` | `inbox/fixes/` | 记录一次 BUG 修复的失败点、原因、修复和验证方式 |
| `prd` | `inbox/prd-corrections/` | 记录 PRD 口径、字段、流程或边界被纠正的情况 |
| `tech` | `inbox/tech-solution-corrections/` | 记录技术方案设计、数据源、接口或性能策略被纠正的情况 |

这些记录进入 inbox 后，不会自动成为长期规则。带 `--target` 的 targeted fix 会同时记录目标正式知识的基线哈希；`--target` 可以省略，用于没有对应知识文件、需要作为独立知识候选保留的纠偏。

两类 fix 的最终动作不同：

- targeted fix：人工或 Codex 基于证据修改原 `target`，审核语义正确后执行 `resolve-fix`；绝不能执行 `promote`，否则会制造第二份正式知识。
- 不带 `target` 的独立 fix：人工确认它应成为独立长期知识后，才沿用 `promote`。

目标哈希变化只能证明文件字节发生过变化，哈希变化不等于语义正确，也不能证明纠偏已被完整吸收；执行 `resolve-fix` 前仍必须人工审核目标正文。

### resolve-fix

关闭已经由正式知识吸收的 targeted fix：

```powershell
agent-knowledge resolve-fix --file inbox/tech-solution-corrections/<纠偏文件>.md
ak resolve inbox/tech-solution-corrections/<纠偏文件>.md
```

推荐顺序：

1. 阅读 targeted fix 的证据、失败点和纠偏结论。
2. 人工或由已获授权的 Codex 工作流直接修改 `target` 指向的 `knowledge/` 正式知识。
3. 完整审核目标正文，确认纠偏已经正确合入；不要只看 Git diff 或哈希变化。
4. 对原 inbox 路径执行 `resolve-fix`。命令校验目标仍是 confirmed 且当前哈希不同于记录基线，但不会自动改写或语义合并目标。

成功后生成三个互相配合、但都不属于可检索正式知识的工件：

- `archive/source-survivors/<分类>/<文件>`（source survivor）：与处理中的 source 保持同一 inode，用于承接旧文件句柄可能产生的晚到写入，便于发现并发冲突。
- `archive/resolved-sources/<分类>/<文件>`（source snapshot）：独立 inode 的只读字节快照，固定本次审计实际采用的纠偏原文。
- `archive/resolved/<分类>/<文件>`（resolved audit）：`status: resolved` 的审计记录，保存目标基线/关闭哈希、source hash 和上述工件路径。

旧版 targeted fix 如果缺少 `target_hash`，默认不能关闭。只有人工已经确认目标吸收了纠偏时，才显式执行：

```powershell
ak resolve inbox/<分类>/<旧纠偏文件>.md --confirm-legacy
```

命令中断或报告恢复/冲突状态时，不要手工删除、移动或晋升 `work/`、survivor、snapshot、resolved 工件；保留现场并用同一个 source 路径重试。若工件内容不一致、source 路径被复用或命令明确要求人工处理，应先人工审核全部保留版本再决定后续动作。

### check-stale

检查某个项目说明是否落后于项目当前 HEAD：

```powershell
agent-knowledge check-stale --project-root <workspace-root>\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --knowledge-root <workspace-root>\team-agent-knowledge
```

`check-stale` 会读取知识文件 frontmatter 中的 `last_scanned_commit`，再对比 `--project-root` 当前 `git rev-parse HEAD`。如果两者不同，输出“可能过期”；如果缺少 `last_scanned_commit`，也会提示需要刷新。它只接受当前知识库 `knowledge/` 下、`status: confirmed` 的真实 Markdown 普通文件；越界路径以及通过 symlink / junction 逃逸真实根目录的路径会被拒绝。它只做检测，不会自动覆盖人工知识。

加上 `--deep` 后会做**深度过期**检测：读取 frontmatter 的 `evidence_files`（逗号分隔的相对路径列表），用 `git diff --name-only <last_scanned_commit>..HEAD` 与变更文件求交集。即使 HEAD 已变，只要知识依赖的源文件没动就未必需要刷新；反之若依赖文件被改，则精确报出命中项。

```powershell
agent-knowledge check-stale --project-root <workspace-root>\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --deep --knowledge-root <workspace-root>\team-agent-knowledge
```

常见使用时机：

- 开始处理某个项目相关任务前，先确认项目说明是否可能过期。
- 项目依赖、模块结构、Facade、Controller、Mapper 或关键业务入口发生变化后，用它提醒是否需要更新知识库。
- 多个项目都有关联时，对每个项目说明分别执行一次。

### refresh-project

在人工或 Codex 已完成正文核对后，刷新项目知识文件的元数据：

```powershell
agent-knowledge refresh-project --project-root <workspace-root>\reasearch-hub --knowledge-file knowledge/domain/project-reasearch-hub.md --summary "同步 Facade 和模块结构变化" --knowledge-root <workspace-root>\team-agent-knowledge
```

`refresh-project` 会更新 `updated`、`project_root`、`last_scanned_commit`，并在正文末尾追加“刷新记录”。它只接受当前知识库 `knowledge/` 下、`status: confirmed` 的真实 Markdown 普通文件，并在取得写锁后重新校验真实路径，避免检查与写入之间目标被替换。它不会自动重写项目说明正文；正文里的业务规则、接口关系和证据链仍需要由 Codex 或人工基于当前代码确认后再修改。

推荐顺序：

1. 先运行 `check-stale`。
2. 如果提示可能过期，阅读当前代码、README、POM、路由、Facade、DTO、Mapper 或前端入口。
3. 手动或由 Codex 更新知识文件正文。
4. 正文确认后运行 `refresh-project`。
5. 将知识库变更提交到私有知识库仓库。

不要在没有核对正文的情况下只运行 `refresh-project`，否则 `last_scanned_commit` 会显示已刷新，但正文仍可能是旧内容。

### promote

把 inbox 下已经确认的普通草稿或不带 `target` 的独立 fix 晋升为已确认知识：移动到 `knowledge/` 下对应的子目录（映射规则为 `inbox/<sub>/file.md` → `knowledge/<sub>/file.md`），并把 frontmatter 的 `status` 改为 `confirmed`。

```powershell
agent-knowledge promote --file inbox/rules/2026-07-09-aggregation-rule.md
```

`promote` 只接受 `inbox/` 下的真实 Markdown 普通文件；若误传 `knowledge/` 下的文件会报错。源文件和目标目录都会校验真实路径，目标目录链中存在 symlink / junction 时会在创建子目录或写文件前拒绝。带非空 `target` 的 targeted fix 会在任何写入前被拒绝：这类纠偏必须先修改目标正式知识，再执行 `resolve-fix`。普通规则草稿和不带 `target` 的独立 fix 仍可在人工确认后晋升。晋升后原 inbox 文件会被删除，新文件落在 `knowledge/` 对应目录。如果团队还有「项目索引」或「规则索引」需要同步引用，晋升后可人工补一条索引引用。

典型节奏：规则草稿或独立 fix 在 `inbox/` 沉淀一段时间后，由人工确认其长期有效性，再用 `promote` 晋升；targeted fix 则通过 `resolve-fix` 关闭，不得为了清理 inbox 而晋升。

### list-pending

列出 `inbox/` 下所有待确认条目，便于发现堆积：

```powershell
agent-knowledge list-pending
```

输出每行包含相对路径、`status`、`type` 与 `updated`，方便判断哪些条目已挂起过久、需要确认或清理。

### sync-adapters

同步或检查 OpenCode 命令适配器：

```powershell
agent-knowledge sync-adapters --repository-root <agent-knowledge-hook仓库>
agent-knowledge sync-adapters --check --repository-root <agent-knowledge-hook仓库>
```

适配器的唯一模板来源固定为 `<repository-root>/agent-knowledge/templates/opencode/`，安装目标固定为 `<repository-root>/.opencode/command/`。`--knowledge-root` 不参与模板或目标解析，避免私有知识库位置改变适配器来源。`--check` 只读比较，不同步文件；发现目标缺失或内容漂移时退出 1。

### doctor

对 `knowledge/` 和 `inbox/` 下的 Markdown 做只读健康检查，并精确跳过说明文件 `inbox/README.md`：

```powershell
agent-knowledge doctor --knowledge-root <知识库根目录> --repository-root <agent-knowledge-hook仓库>
ak doctor --json
```

检查范围包括 UTF-8 BOM、frontmatter、目录对应的 `status`、全局重复标题、`target` 引用、targeted fix 的 `target_hash` / `fix_id`、`project_root` / 逗号分隔的 `evidence_files`，以及 OpenCode 适配器漂移。`doctor` 还会只读诊断 `knowledge/`、`inbox/` 下的相邻 `*.md.lock` / `*.md.lock.reclaim`，以及固定目录 `work/locks/resolve/` 中名称为 64 位小写十六进制哈希的 `.lock` / `.lock.reclaim`；`notes.lock`、备份后缀和非哈希 resolve 文件不属于锁扫描范围。合法锁内容必须是完整的 `PID:RFC4122-UUID`，末尾可以没有换行或只有一个 LF / CRLF；活进程持有的合法锁不报告，PID 已退出或内容无法严格解析时给出 warning。锁扫描不跟随 symlink / junction，也不会越出知识库真实根。只有 `<repository-root>/.opencode/command/` 目录已经存在时才检查适配器；模板仍固定来自 `agent-knowledge/templates/opencode/`。`archive/` 与 `work/` 不进入知识正文扫描，`work/` 仅检查上述固定锁目录。

问题严重级别和退出码：

- `error`：`utf8_bom`、`missing_frontmatter`、`invalid_status`、`broken_target`、`invalid_target_hash`、`invalid_fix_id`、`adapter_drift`。存在任一 error 时 `ok=false`，进程退出 1。
- `warning`：`duplicate_title`、`missing_project_root`、`missing_evidence_file`、`missing_target_hash`、`orphan_lock`、`invalid_lock`。只有 warning 时 `ok=true`，进程退出 0；`missing_target_hash` 表示旧版 targeted fix 关闭时需要显式 `--confirm-legacy`。
- 检查不会修复、晋升、删除或重写任何文件。

锁恢复与人工排查边界：

- 普通主锁只有在新的调用成功持有相邻 reclaim guard、锁内容严格匹配 `PID:RFC4122-UUID` 且 owner PID 已退出时，才会按既有流程自动恢复；PID-only、BOM、额外内容或非法 UUID 都不会被删除。
- orphan reclaim guard 不会自动删除。缺少可移植的 compare-and-unlink 语义时，自动回收 guard 可能产生 ABA 并误删后继进程的新 guard，因此后续锁获取会安全超时并保留现场。
- `LOCK_TIMEOUT` 只表示在等待时间内无法安全取得锁，不表示该锁可以直接删除。先停止或确认没有相关任务运行，再用 `doctor` 核对锁路径和 PID，检查相邻恢复工件及锁内容，并在团队协调后人工处理；不要在无法确认 token 所属任务时强制解锁。

### --json

支持 `[--json]` 的命令以本页上方生成命令清单为准，启用后输出结构化结果：

```powershell
agent-knowledge search "graph-service 实体归属" --json
agent-knowledge doctor --json
```

各字段含义：

- `before-task` / `search`：顶层 `queryTerms`（原始查询词）、`expandedTerms`（同义词与中文 2-gram 展开词）；`results[].mustRead`、`mustReadReason`（分级原因）、`coverage`（查询组命中比例）、`matched` / `total`、`matchedTerms`、`reasonCodes`（命中字段）、`stale`、`staleReason`、`snippet`、`hits`。兼容字段 `keywords` 保留，并返回实际展开词。
- `check-stale`：`scannedCommit`、`currentCommit`、`stale`、`reason`，以及 `--deep` 时的 `deep.hitFiles` 等。
- `doctor`：`ok`、`checkedFiles` 与按 `file + code + message` 稳定排序的 `issues`。检查通过或失败时，stdout 都只输出一个合法 JSON 对象。

### --knowledge-root 与环境变量

如果真实团队知识与工具仓库分离，使用 `--knowledge-root` 指向私有知识库根目录：

```powershell
node <workspace-root>\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js before-task "分析 graph-service 实体归属" --knowledge-root <workspace-root>\team-agent-knowledge
```

也可以设置环境变量，之后命令会默认使用该知识库：

```powershell
$env:AGENT_KNOWLEDGE_ROOT = "<workspace-root>\team-agent-knowledge"
node <workspace-root>\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js search "graph-service 项目职责"
```

`before-task` 和 `search` 的结果只提供知识入口。AI 仍必须沿真实调用链确认失败点、最终数据源和关键参数，不能因为搜索命中就直接改代码。

## 推荐工作流

一次完整任务可以按这个节奏使用：

1. `before-task`：开始前读取团队知识，尤其是强规则和项目索引。
2. `check-stale`：任务涉及具体项目说明时，检查知识文件是否落后于项目 HEAD。
3. 代码分析：回到真实项目确认入口、入参、最终数据源和赋值点。
4. 更新正文：如果项目结构、服务边界或业务规则变化，先改知识文件正文。
5. `refresh-project`：正文确认后刷新 `last_scanned_commit` 和刷新记录。
6. 纠错记录：未确认草稿被纠正时直接修改原草稿；正式知识被纠正时创建 targeted fix；独立业务结论被纠正时创建不带 `target` 的 fix。
7. 纠错关闭：targeted fix 先修改并审核目标，再执行 `resolve-fix`；独立 fix 只有在确认应成为独立长期知识后才执行 `promote`。
8. `add-rule`：如果形成长期规则，先进入 inbox；确认后再进入 `knowledge/rules/`。

## knowledge 与 inbox

`knowledge/` 存放已经确认长期有效的知识，包括规则、业务知识、历史坑和服务映射。这里的内容可以作为任务分析的强约束，但仍要结合实际代码路径验证。

`inbox/` 存放待确认材料，包括规则草稿、纠错记录、PRD 纠偏和技术方案纠偏。这里的内容是缓冲区，不能直接当成长期规则套用。普通草稿和独立 fix 经人工确认后可整理进 `knowledge/`；targeted fix 必须把结论合入原目标并通过 `resolve-fix` 关闭。

`archive/` 存放 `resolve-fix` 产生的 source survivor、只读 source snapshot 和 resolved 审计记录；`work/` 存放锁与可恢复的处理中状态。两者都不参与 `before-task` / `search` 检索、必须阅读列表或 `list-pending`，也不能当成第二份正式知识。出现失败时保留这些工件，是为了让同一路径重试和人工冲突审核有完整证据。

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
  archive/
    source-survivors/
    resolved-sources/
    resolved/
  work/
    resolving/
    locks/
```

## 后续 MCP 服务化思路

当前版本采用命令式钩子，适合先把知识库维护流程跑稳。后续如果希望把 `agent-knowledge` 独立成一个知识库服务，可以在现有 CLI 外面增加一层 MCP Server，把常用命令包装成 AI 可发现、可调用的工具。

建议的 MCP 工具设计：

| MCP tool | 对应能力 |
| --- | --- |
| `before_task(task_description)` | 调用 `before-task`，在任务开始前返回必须阅读项和可能相关项 |
| `search_knowledge(keyword)` | 调用 `search`，按关键词检索规则、项目说明、历史坑和服务映射 |
| `list_projects()` | 调用 `ak projects`，列出项目索引中已登记的项目 |
| `check_project_knowledge(project_name)` | 调用 `ak check <项目名>`，检查项目知识是否可能过期 |
| `refresh_project_knowledge(project_name, summary)` | 调用 `ak refresh <项目名> <说明>`，在正文已核对后刷新元数据 |
| `record_bug_fix(title, detail)` | 调用 `record-fix --type bug`，把 BUG 纠错写入 `inbox/fixes/` |
| `record_prd_correction(title, detail)` | 调用 `record-fix --type prd`，把需求口径纠偏写入 `inbox/prd-corrections/` |
| `record_tech_correction(title, detail)` | 调用 `record-fix --type tech`，把技术方案纠偏写入 `inbox/tech-solution-corrections/` |
| `resolve_targeted_fix(file, confirm_legacy)` | 在目标正文已人工审核后调用 `resolve-fix`，归档 targeted fix 的 survivor、snapshot 与 resolved 审计记录 |
| `add_rule_draft(title, detail)` | 调用 `add-rule`，默认写入 `inbox/rules/` |

推荐架构：

```text
AI 工具 / Agent
  -> Knowledge MCP Server
  -> agent-knowledge CLI / ak.ps1
  -> team-agent-knowledge
     -> knowledge/  已确认长期知识
     -> inbox/      待确认纠偏、规则和补充材料
```

服务化后仍应保留当前的审核边界：MCP 可以负责查询、生成草稿和写入 `inbox/`，但不要让 AI 在无人工确认的情况下直接把临时判断写入正式 `knowledge/`。`refresh_project_knowledge` 也只应在项目知识正文已经基于当前代码、接口契约、查询或调用链核对后执行，避免只刷新元数据却保留旧正文。

如果将来提供远程 MCP 服务，还需要补充鉴权、审计日志、写入权限控制、敏感信息脱敏和并发写入保护。对外暴露的工具名称、参数和返回值应保持稳定，让 Codex、Claude、OpenCode 或其他 Agent 可以共用同一套知识库维护能力。

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
- `archive/source-survivors/`：承接旧 source inode 晚到写入的保活工件，不参与检索。
- `archive/resolved-sources/`：本次关闭采用的独立只读 source snapshot，不参与检索。
- `archive/resolved/`：targeted fix 的 resolved 审计记录，不参与检索。
- `work/`：`resolve-fix` 的锁和中断恢复状态，不参与检索或待确认清单。
- `tool-adapters/`：不同 AI 工具的接入说明。
- `help/`：短命令的中文详细帮助文本。
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

无论从 Codex、Claude 还是 OpenCode 调用，都应遵循同一规则：先读 `before-task` 输出的必须阅读项，再分析代码；发生人工纠错后先判断对象状态，未确认草稿直接修改，正式知识用 targeted fix 关联并在目标审核后 `resolve-fix`，独立结论才走独立 fix 的 `promote` 流程。哈希变化不是语义审核的替代品。

## 本地验证

仓库的 GitHub Actions 会在 `push` 和 `pull_request` 时运行测试、只读检查命令文档与 OpenCode 适配器漂移，并对仓库打包的示例知识库执行 `doctor`。CI 不安装第三方依赖、不自动同步命令文档或适配器，也不访问工作区外的私有 `team-agent-knowledge`。

真实私有知识库只适合在具备访问权限的本地环境中额外执行只读 `doctor`，该结果属于非阻塞的环境检查，不作为跨环境 CI 门禁。

2026-07-14 在 Windows PowerShell 环境完成以下验证。以下命令均从仓库根目录执行，例如：

```powershell
cd <workspace-root>\agent-knowledge-hook
```

```powershell
Push-Location agent-knowledge
npm.cmd run test
Pop-Location
```

结果：全量测试零失败；`resolveFix source rejects a symlink` 文件 symlink 拒绝用例因 Windows 当前权限无法创建测试所需的文件 symlink 而跳过。测试覆盖安全新建与原子更新、命令文档与 OpenCode 适配器同步/漂移检查、`doctor` 结构与引用检查、CLI/PowerShell 参数边界、targeted fix 关闭与中断恢复、JSON 机读输出，以及原有检索、纠错、刷新、晋升和待确认清单流程；验证过程不会污染真实 `agent-knowledge/inbox`。

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
