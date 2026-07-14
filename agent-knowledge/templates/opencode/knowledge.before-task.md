---
description: Run the team knowledge hook before analyzing a requirement, bug, or technical plan.
---

## User Input

```text
$ARGUMENTS
```

You **MUST** treat the user input as the task description.

## Workflow

1. Receive the task description from `$ARGUMENTS`. If it is empty, ask the user for the concrete requirement, BUG, or technical-plan topic before proceeding.
2. From the repository root, run:

   ```bash
   node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"
   ```

   Replace `<任务描述>` with the task description from `$ARGUMENTS`. If the team later installs a global `agent-knowledge` command, `agent-knowledge before-task "<任务描述>"` is only a shorthand for the stable repository-local Node entry.
   If real team knowledge is stored in a separated private knowledge repository, append `--knowledge-root <私有知识库根目录>` or use `AGENT_KNOWLEDGE_ROOT`.

   ```bash
   node C:/workspace/agent-knowledge-hook/agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>" --knowledge-root C:/workspace/team-agent-knowledge
   ```

3. Inspect the command output. If it contains “必须阅读”, read every listed required item before continuing.
4. Continue requirement analysis, BUG analysis, technical-plan review, or implementation only after the required knowledge has been read.

## Constraints

- `before-task` output is a knowledge entry point, not a replacement for code investigation.
- `inbox/` entries are pending materials and must not be applied as strong rules directly.
- `knowledge/` entries are confirmed team knowledge, but still need to be checked against the real code path, API contract, query, or data source involved in the current task.
