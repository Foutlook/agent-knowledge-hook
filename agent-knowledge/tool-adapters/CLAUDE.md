# Claude 接入片段

在本仓库中，分析需求、BUG 或技术方案前，先运行团队知识库钩子：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 before-task "<任务描述>"
```

如果 PowerShell 执行策略限制脚本，可使用：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\agent-knowledge.ps1 before-task "<任务描述>"
```

也可以从仓库根目录使用稳定 Node 入口：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"
```

如果真实团队知识放在分离的私有知识库，必须显式指定知识库根目录：

```powershell
node <workspace-root>\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js before-task "<任务描述>" --knowledge-root <workspace-root>\team-agent-knowledge
```

也可以使用环境变量 `AGENT_KNOWLEDGE_ROOT` 指向私有知识库根目录；该目录应直接包含 `knowledge/` 和 `inbox/`。

如果输出中出现“必须阅读”，必须先按路径读完所有必须阅读项，再给出分析结论、技术方案或代码修改建议。

发生人工纠错后，先判断被纠正对象的生命周期：未确认的 `inbox/` 草稿直接修改，不额外创建 fix；已确认知识、业务分析结论、BUG 结论或已输出技术方案被纠正时，才使用 `record-fix`。不得让同一结论同时以原草稿和 fix 两种待确认形态重复存在。

已知被纠正的知识文件时，通过 `--target` 明确关联：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 record-fix --type bug --title "<纠错标题>" --target "<知识文件>"
```

对应的 Node fallback 是：

```powershell
node agent-knowledge/bin/agent-knowledge.js record-fix --type bug --title "<纠错标题>" --target "<知识文件>"
```

分离私有知识库时，纠错记录也必须写入私有知识库：

```powershell
node <workspace-root>\agent-knowledge-hook\agent-knowledge\bin\agent-knowledge.js record-fix --type bug --title "<纠错标题>" --target "<知识文件>" --knowledge-root <workspace-root>\team-agent-knowledge
```

`--type` 可选 `bug`、`prd`、`tech`，分别用于 BUG 分析纠错、PRD 理解纠错和技术方案纠错。如果 `--target` 指向 `inbox/` 中的 `draft` 或 `pending` 文件，命令会拒绝创建 fix，并提示直接修改原草稿。

带 `--target` 的 targeted fix 创建后，先由人工或 Claude 基于证据修改并完整审核目标正式知识，再执行：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 resolve-fix --file <inbox纠偏文件> [--confirm-legacy]
```

targeted fix 绝不能 `promote`；只有不带 `target` 的独立 fix，才能在确认应成为独立长期知识后沿用 `promote`。目标哈希变化只证明字节变化，不证明语义正确。`--confirm-legacy` 只用于缺少 `target_hash` 且已经人工确认的旧记录。

成功关闭会生成承接晚到写入的 source survivor、独立只读 source snapshot 和 resolved 审计记录。`archive/` 与 `work/` 不参与知识检索、必须阅读或待确认清单。失败时保留恢复工件并用同一 source 路径重试；内容冲突或路径复用必须人工审核，不得手工删除或晋升现场。

注意：`inbox/` 是待确认缓冲区，不能把其中内容当成强规则直接套用；只有 `knowledge/` 下已经确认的知识，才可作为团队知识库的稳定约束，但仍需结合真实代码路径、接口契约和数据源验证。
