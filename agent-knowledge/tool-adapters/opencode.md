# OpenCode 接入说明

OpenCode 通过仓库内的命令文件接入团队知识库钩子：

- `.opencode/command/knowledge.before-task.md`：用于分析需求、BUG 或技术方案前。AI 接收任务描述后先从仓库根目录运行 `node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"`，读取输出中的必须阅读项，再继续分析和执行。
- `.opencode/command/knowledge.record-fix.md`：用于人工纠正 PRD 理解、技术方案或 BUG 分析之后。AI 从仓库根目录调用 `node agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>"` 生成 `inbox/` 记录，并在最终答复里提示记录路径。

执行原则与其他工具一致：

- 分析需求、BUG、技术方案前运行 `agent-knowledge before-task "<任务描述>"`。
- 如果团队后续安装了全局 `agent-knowledge`，裸命令只是简写；未安装时使用仓库内稳定入口 `node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"`。
- 如果输出“必须阅读”，先读完再给结论。
- 发生人工纠错后使用 `record-fix`；未安装全局命令时使用 `node agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>"`。
- 不能把 `inbox/` 内容当成强规则直接套用；`inbox/` 是待确认缓冲区，`knowledge/` 才是已确认知识区。
