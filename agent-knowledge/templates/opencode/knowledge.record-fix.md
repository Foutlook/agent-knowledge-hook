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
3. Determine the corrected object's lifecycle before creating anything:
   - If a known target is an `inbox/` draft or pending item, edit that original draft directly and do not create a fix.
   - If a known target is confirmed knowledge under `knowledge/`, create the fix with `--target <confirmed knowledge file>`.
   - If the correction is an independent conclusion with no existing target, create the fix without `--target`.
4. When a fix is required, run from the repository root:

   ```bash
   node agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>" [--target <confirmed knowledge file>]
   ```

   If the team later installs a global `agent-knowledge` command, `agent-knowledge record-fix --type <bug|prd|tech> --title "<纠错标题>"` is only a shorthand for the stable repository-local Node entry.
   If real team knowledge is stored in a separated private knowledge repository, append `--knowledge-root <私有知识库根目录>` or use `AGENT_KNOWLEDGE_ROOT`.

   ```bash
   node C:/workspace/agent-knowledge-hook/agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>" [--target <confirmed knowledge file>] --knowledge-root C:/workspace/team-agent-knowledge
   ```

5. Read the command output and capture the generated `inbox/` path.
6. If the fix has a `target`, review the correction evidence and the confirmed target end to end, then edit that target manually or with the user's authorized Codex workflow. The tool must not infer a semantic Markdown merge from the fix text.
7. After human review confirms that the target has absorbed the correction, close the targeted fix with:

   ```bash
   node agent-knowledge/bin/agent-knowledge.js resolve-fix --file <generated inbox fix path>
   ```

   Append `--knowledge-root <私有知识库根目录>` for a separated knowledge repository. Use `--confirm-legacy` only for an old targeted fix that lacks `target_hash`, and only after explicitly confirming that the target already contains the correction.
8. If the fix has no `target`, it remains an independent fix. It may use `promote` only after the user explicitly confirms that it should become standalone long-term knowledge.
9. In the final response, report the generated path and whether the record still needs target editing, targeted resolution, or independent promotion.

## Constraints

- Do not create a second pending fix for an `inbox/` draft or pending item; update the original draft instead.
- Use `record-fix --target` only for confirmed knowledge. Independent conclusions may omit `--target`.
- The generated fix belongs in `inbox/` first because it is pending confirmation.
- A targeted fix must never use `promote`; update its target and close it with `resolve-fix`.
- An independent fix may use `promote` only when the user explicitly requests confirmed standalone knowledge curation.
- A changed target hash proves only that the bytes changed; it does not prove that the correction is semantically correct. Human review remains required.
- If `resolve-fix` reports a recovery or conflict state, preserve the reported `work/` and `archive/` artifacts, rerun the same source path when instructed, and request human review instead of deleting or moving artifacts manually.
- A successful resolution keeps three audit artifacts: the source survivor carries late writes to the claimed inode, the separate read-only source snapshot fixes the reviewed source bytes, and the resolved audit records the persisted hashes and artifact paths.
- `archive/` audit artifacts and `work/` recovery state are not searchable confirmed knowledge or pending knowledge.
- Do not treat existing `inbox/` content as a strong rule without human confirmation.
