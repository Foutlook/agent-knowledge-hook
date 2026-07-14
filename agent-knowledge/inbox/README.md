# inbox 待确认区

`inbox/` 是知识库的缓冲区，用来保存还没有被确认成长期规则的材料。

常见来源包括：

- `rules/`：人工或 AI 新补充的规则草稿。
- `fixes/`：BUG 修复过程中的人工纠错记录。
- `prd-corrections/`：PRD 理解被纠正后的记录。
- `tech-solution-corrections/`：技术方案被纠正后的记录。

读取 inbox 内容时必须保持谨慎：它能提示可能相关的历史背景，但不能直接作为强规则套用。

不同材料的确认路径不同：

- `rules/` 中的普通草稿，以及不带 `target` 的独立 fix，经过代码、接口契约、线上问题或团队共识验证后，可以用 `promote` 整理到 `knowledge/` 下。
- 带非空 `target` 的 targeted fix 不能 `promote`。应先把纠偏结论合入并完整审核原 `knowledge/` 目标，再用 `resolve-fix` 关闭，避免生成第二份正式知识。
- 如果被纠正对象本身仍是 `inbox/` 中的 `draft` / `pending` 草稿，直接修改原草稿，不要再创建一条 fix。

`resolve-fix` 产生的 `archive/` 审计工件和 `work/` 恢复状态不属于 inbox，也不参与检索、必须阅读或待确认清单。命令中断或报告冲突时应保留现场，并使用同一个 source 路径重试。

默认让 `add-rule` 写入 `inbox/rules/`，是为了先保留讨论和审查空间，避免把一次临时判断沉淀成长期团队规则。
