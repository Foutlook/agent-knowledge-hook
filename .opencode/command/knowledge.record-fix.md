---
description: Record a human correction after PRD, technical-plan, or bug-analysis feedback.
---

## User Input

```text
$ARGUMENTS
```

Use the user input as the correction summary or title.

## When To Use

Use this command after a human corrects AI output about:

- PRD interpretation or requirement scope.
- Technical solution design, boundaries, or data source assumptions.
- BUG analysis, failure point, call chain, or fix direction.

## Workflow

1. Classify the correction type:
   - `prd` for PRD or requirement understanding corrections.
   - `tech` for technical solution corrections.
   - `bug` for BUG analysis or fix-direction corrections.
2. Generate a concise correction title from `$ARGUMENTS`.
3. From the repository root, run:

   ```bash
   node agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>"
   ```

   If the team later installs a global `agent-knowledge` command, `agent-knowledge record-fix --type <bug|prd|tech> --title "<纠错标题>"` is only a shorthand for the stable repository-local Node entry.
   If real team knowledge is stored in a separated private knowledge repository, append `--knowledge-root <私有知识库根目录>` or use `AGENT_KNOWLEDGE_ROOT`.

   ```bash
   node C:/workspace/agent-knowledge-hook/agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>" --knowledge-root C:/workspace/team-agent-knowledge
   ```

4. Read the command output and capture the generated `inbox/` path.
5. In the final response, tell the user the correction has been recorded and include the generated record path.

## Constraints

- The generated record belongs in `inbox/` first because it is pending confirmation.
- Do not promote the correction into `knowledge/` unless the user explicitly asks for confirmed knowledge curation.
- Do not treat existing `inbox/` content as a strong rule without human confirmation.
