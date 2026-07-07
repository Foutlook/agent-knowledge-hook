# AGENTS 接入片段

在本仓库中，分析需求、BUG 或技术方案前，先运行团队知识库钩子：

```bash
agent-knowledge before-task "<任务描述>"
```

如果本机未安装全局 `agent-knowledge` 命令，从仓库根目录使用稳定 Node 入口：

```bash
node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"
```

如果真实团队知识放在分离的私有知识库，必须显式指定知识库根目录：

```bash
node C:/workspace/agent-knowledge-hook/agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>" --knowledge-root C:/workspace/team-agent-knowledge
```

也可以使用环境变量 `AGENT_KNOWLEDGE_ROOT` 指向私有知识库根目录；该目录应直接包含 `knowledge/` 和 `inbox/`。

如果输出中出现“必须阅读”，必须先按路径读完所有必须阅读项，再给出分析结论、技术方案或代码修改建议。

发生人工纠错后，使用 `record-fix` 沉淀到 `inbox/`：

```bash
agent-knowledge record-fix --type bug --title "<纠错标题>"
```

未安装全局命令时，从仓库根目录使用：

```bash
node agent-knowledge/bin/agent-knowledge.js record-fix --type bug --title "<纠错标题>"
```

分离私有知识库时，纠错记录也必须写入私有知识库：

```bash
node C:/workspace/agent-knowledge-hook/agent-knowledge/bin/agent-knowledge.js record-fix --type bug --title "<纠错标题>" --knowledge-root C:/workspace/team-agent-knowledge
```

`--type` 可选 `bug`、`prd`、`tech`，分别用于 BUG 分析纠错、PRD 理解纠错和技术方案纠错。

注意：`inbox/` 是待确认缓冲区，不能把其中内容当成强规则直接套用；只有 `knowledge/` 下已经确认的知识，才可作为团队知识库的稳定约束，但仍需结合真实代码路径、接口契约和数据源验证。
