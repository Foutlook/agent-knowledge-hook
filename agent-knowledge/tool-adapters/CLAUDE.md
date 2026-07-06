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

如果输出中出现“必须阅读”，必须先按路径读完所有必须阅读项，再给出分析结论、技术方案或代码修改建议。

发生人工纠错后，使用 `record-fix` 沉淀到 `inbox/`：

```powershell
.\agent-knowledge\bin\agent-knowledge.ps1 record-fix --type bug --title "<纠错标题>"
```

对应的 Node fallback 是：

```powershell
node agent-knowledge/bin/agent-knowledge.js record-fix --type bug --title "<纠错标题>"
```

`--type` 可选 `bug`、`prd`、`tech`，分别用于 BUG 分析纠错、PRD 理解纠错和技术方案纠错。

注意：`inbox/` 是待确认缓冲区，不能把其中内容当成强规则直接套用；只有 `knowledge/` 下已经确认的知识，才可作为团队知识库的稳定约束，但仍需结合真实代码路径、接口契约和数据源验证。
