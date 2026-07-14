# OpenCode 接入说明

OpenCode 通过仓库内的命令文件接入团队知识库钩子：

- `.opencode/command/knowledge.before-task.md`：用于分析需求、BUG 或技术方案前。AI 接收任务描述后先运行 `node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"`；真实知识库分离时加上 `--knowledge-root <私有知识库根目录>`，读取输出中的必须阅读项，再继续分析和执行。
- `.opencode/command/knowledge.record-fix.md`：用于已确认知识、PRD 理解、技术方案或 BUG 分析结论被纠正之后。未确认的 `inbox/` 草稿应直接修改，不额外创建 fix。已知被纠正的正式知识时调用 `node agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>" --target "<知识文件>"`；真实知识库分离时加上 `--knowledge-root <私有知识库根目录>`。随后由人工或 OpenCode 修改并审核目标，再用 `resolve-fix --file <inbox纠偏文件>` 关闭 targeted fix。

执行原则与其他工具一致：

- 分析需求、BUG、技术方案前运行 `agent-knowledge before-task "<任务描述>"`。
- 如果团队后续安装了全局 `agent-knowledge`，裸命令只是简写；未安装时使用仓库内稳定入口 `node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"`。
- 如果真实团队知识放在分离的私有知识库，使用 `--knowledge-root` 或 `AGENT_KNOWLEDGE_ROOT` 指向该目录。
- 如果输出“必须阅读”，先读完再给结论。
- 发生人工纠错后先判断对象状态：未确认草稿直接修改；已确认知识或独立业务结论被纠正时使用 `record-fix`。不得让同一结论同时以原草稿和 fix 两种待确认形态重复存在。
- targeted fix 绝不能 `promote`；先修改并审核目标，再执行 `resolve-fix`。只有不带 `target` 的独立 fix 才能在人工确认后沿用 `promote`。哈希变化只证明字节变化，不证明纠偏语义正确。
- `--confirm-legacy` 只用于缺少 `target_hash` 且已人工确认目标吸收纠偏的旧记录。成功关闭会生成 source survivor、独立只读 source snapshot 和 resolved 审计记录；`archive/` 与 `work/` 不参与检索、必须阅读或待确认清单。
- 关闭失败时保留恢复工件并用同一 source 路径重试；工件冲突或 source 路径复用必须人工审核，不得手工删除、移动或晋升现场。
- 不能把 `inbox/` 内容当成强规则直接套用；`inbox/` 是待确认缓冲区，`knowledge/` 才是已确认知识区。
