# Fix Resolution Lifecycle 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Every behavior change follows RED-GREEN and preserves UTF-8 without BOM.

**Goal:** 建立 targeted fix 的“修改正式知识—校验变化—归档审计”闭环，阻止它被通用 `promote` 复制成第二份正式知识。

**Architecture:** 保持零第三方运行时依赖。`record-fix` 为每条 fix 分配 UUID；targeted fix 同步记录已确认目标的 SHA-256。`resolve-fix` 使用固定路径锁和显式状态机，把 source 依次转换为同 inode survivor、独立只读 snapshot、resolved 审计记录；任何冲突都保留全部工件，不根据自由文本自动合并。`doctor` 只扩展 targeted fix 元数据检查。

**Tech Stack:** Node.js ESM、`node:test`、PowerShell 5.1、Markdown/frontmatter、GitHub Actions。

**Authoritative design:** `docs/superpowers/specs/2026-07-13-fix-resolution-lifecycle-design.md`

**Follow-up plan:** `docs/superpowers/plans/2026-07-13-agent-knowledge-ci-lock-diagnostics.md` 独立处理最小 CI 与孤儿锁诊断，不改变本规格的生命周期状态机。

**Execution note:** 当前 `main` 工作区已有同一优化链路的未提交修改。本计划直接在当前工作区执行，不创建 worktree、不自动暂存、不提交 Git；每次修改只触及本计划列出的文件和必要说明。

**Success criteria:**

- 新 fix 均有 UUID `fix_id`；targeted fix 同时有目标基线 `target_hash`，且目标读取、路径校验和哈希来自同一份原始字节。
- targeted fix 不能 `promote`；目标未变化不能 `resolve-fix`；目标变化后能形成 survivor、snapshot 和 resolved 三工件，inbox 不再保留旧 source。
- 并发、中断、路径链接、同名冲突和晚到写入均不覆盖或丢失 source；完成态不依赖 target 当前状态。
- legacy targeted fix 只有显式 `--confirm-legacy` 才能关闭。
- `doctor` 能报告 targeted fix 元数据问题，保持只读。
- 完整测试、覆盖率、版本库示例知识库 doctor、适配器检查、`git diff --check` 和 UTF-8 无 BOM 检查全部通过；私有团队知识库存在时只作非阻塞环境检查。

---

### Task 1: `record-fix` 身份与目标基线

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 写 `fix_id` / `target_hash` 失败测试**

覆盖独立 fix、targeted fix、同日同标题两次创建和中文标题。断言：完整 UUID 存于 frontmatter；文件名带去连字符后的 12 位前缀；targeted fix 的 `target_hash` 等于目标原始 UTF-8 字节 SHA-256；独立 fix 不写 `target_hash`。

- [x] **Step 2: 写 target 路径安全失败测试**

覆盖目标不是 `knowledge/` confirmed、目标文件链接逃逸、父目录 junction 逃逸、非 `.md` 和非普通文件。保持“inbox 草稿直接修改”的既有错误语义。

- [x] **Step 3: 运行聚焦测试并确认 RED**

```powershell
node --test --test-name-pattern="fix_id|target_hash|target realpath" tests/agent-knowledge.test.js
```

- [x] **Step 4: 实现最小 GREEN**

引入 `createHash('sha256')`，新增统一字节哈希 helper。让 `validateFixTarget` 返回规范化相对路径与同次读取的原始内容/哈希；`recordFix` 生成 UUID，并将身份前缀写入文件名。不得通过二次读取产生 target 与 hash 竞态。

- [x] **Step 5: 复跑聚焦测试**

### Task 2: `resolve-fix` 状态机基础与 happy path

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 写 source、target 和内部路径约束失败测试**

覆盖三个允许分类、非法目录、source symlink、非 pending、缺 target、目标未变化，以及首次关闭时 target 被删除、target 链接逃逸、target 非普通 Markdown、target 非 confirmed。另分别把 `work/`、survivor/snapshot/resolved 的父目录替换为 junction/symlink 逃逸，断言命令在创建锁、移动 source 或写归档前拒绝。最后覆盖目标修改后的成功路径，断言：目标正文没有被命令改写；旧 inbox source 消失；三个 archive 工件路径、frontmatter 字段和完整正文正确。

增加故障注入：初次安全检查结束后，分别在 claim 容器创建、survivor、snapshot 临时写入/发布、resolved 临时写入/发布前把对应父目录替换为外部 junction，断言写入点重新拒绝且外部目录没有工件。另覆盖 claim 容器 mkdir 成功后、source rename 前容器被替换成外部 junction，必须在二次 `lstat/realpath` 复核时拒绝，source 保持原位。

覆盖 source rename 抛出 `EBUSY/EACCES`：source 保持原位，本次安全创建且仍为空的 claim 容器被清理，下一次调用可以重试；容器非空或真实路径已变化时不得清理。故障注入不得把“同权限恶意进程在最后一次复核与紧随的 syscall 之间绕过锁替换工具私有目录”当作可移植支持范围。

- [x] **Step 2: 运行 happy-path 聚焦测试并确认 RED**

```powershell
node --test --test-name-pattern="resolveFix happy|resolveFix unchanged|resolveFix source" tests/agent-knowledge.test.js
```

- [x] **Step 3: 实现安全路径和固定状态路径 helper**

新增：

- source 相对路径规范化与三个固定分类映射；
- `lstat().isFile()` + lexical/realpath 双重边界检查；
- 安全创建并复核 `work/`、`archive/` 祖先与父目录；
- 以规范化 source 路径 SHA-256 生成固定锁名；
- claim、survivor、snapshot、resolved 路径推导。

source 输入只做词法规范化与固定分类校验，内部目录 realpath 检查完成前不得创建锁或移动 source；source 文件、frontmatter 和 target 内容校验必须在持锁识别状态后，仅对首次认领分支执行，不能阻断 claim/snapshot/archive 恢复态。

- [x] **Step 4: 实现 `resolveFix` happy path**

严格按设计状态机实现：

1. 只规范化 source 路径、推导工件并安全加锁，持锁后先识别恢复状态；
2. 仅在没有任何恢复工件的首次认领态，读取 source 并预检新格式 target 与基线变化；
3. 独占创建确定性空 claim 容器，再把 source 单次原子 rename 到容器内固定 `source.md`；认领后再次校验 target；恢复态直接从 claim/snapshot/归档继续，不读取同名 source；
4. claim 硬链接到 survivor，先 unlink claim 再强制 survivor 只读；
5. 从 survivor 独占发布不同 inode 的 snapshot，并强制只读；
6. 从 snapshot 构造 resolved，独占发布；
7. 发布前后逐字节比较 survivor 与 snapshot。

非平凡分支添加“为什么保留/为何不能自动恢复”的注释，不改动无关注释。

- [x] **Step 5: 运行聚焦测试并确认 GREEN**

### Task 3: 恢复、冲突和幂等完成

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 写状态组合失败测试**

至少覆盖：

- claim + recreated source：旧 claim 优先，新 source 不动；
- claim 文件 + recreated source：旧 claim 优先，新 source 不动；空 claim 容器 + source：安全清理空容器后重试；非空异常容器或空容器但 source 缺失：保留现场并报错；
- source 已缺失但 claim 存在：可从 claim 重试；旧 claim 与 frontmatter 无效的新 source 并存：仍优先旧 claim，不预检或修改新 source；
- claim + same-inode survivor：先移除 claim 再恢复只读；
- claim + different-inode survivor：保留两者并报冲突；
- survivor-only、survivor + snapshot：可继续；
- survivor-only、survivor + snapshot 尚未发布 resolved 时，target 被删除、改为非 confirmed、链接逃逸或内容哈希回退到基线：重新校验并拒绝，所有恢复工件保留；
- snapshot-only、archive-only：不完整状态报错且不删除；
- 完成态残留 same/different inode claim；
- 归档存在但正文截断；
- 归档发布后 target 再修改、删除或失去 confirmed：幂等完成不读取当前 target；
- 同名 source 路径复用：旧完成态不吞掉新 source。

- [x] **Step 2: 写故障注入和晚到写入失败测试**

通过可注入的文件操作覆盖：survivor `chmod` 失败后重试、snapshot 发布后 `chmod` 前中断、resolved 发布前/后 survivor 改写、发布失败、unlink 失败。另在 target 预检通过后、claim 建立前后改变 target，断言认领前失败时 source 原位不动，认领后二次校验失败时 claim 被保留且不会反向写回或触碰并发重建的 source。断言纠偏内容至少存在于 source/claim/survivor/snapshot 之一，且错误完成态不能返回成功。

- [x] **Step 3: 运行恢复聚焦测试并确认 RED**

```powershell
node --test --test-name-pattern="resolveFix recovery|resolveFix conflict|resolveFix late write|resolveFix idempotent" tests/agent-knowledge.test.js
```

- [x] **Step 4: 实现显式状态识别与幂等校验**

完成态必须：

- 先处理残留 claim，再强制 survivor/snapshot 只读；
- 校验三工件普通文件、realpath 和 inode 关系；
- 用 snapshot 完整字节重建 resolved 规范载荷并逐字节比较；
- 仅使用已持久化 target/resolved 哈希，不查询当前 target；
- survivor 晚到写入与 snapshot 不一致时报告冲突并保留全部工件。

- [x] **Step 5: 实现 legacy 显式确认**

缺 `target_hash` 默认拒绝；只有 `--confirm-legacy` 才允许。缺 `fix_id` 时使用“规范化 source 相对路径 + NUL + 本次独立 snapshot 的原始字节”的 SHA-256 生成稳定 legacy 身份；增加 snapshot 发布前晚到写入、跨 survivor/snapshot 中断重试的身份稳定性测试，断言 snapshot 一旦发布 identity 不再漂移。完成归档后同一 legacy source 路径禁止复用。

- [x] **Step 6: 运行恢复聚焦测试并确认 GREEN**

### Task 4: `promote`、`doctor`、CLI 与 PowerShell 契约

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/bin/ak.ps1`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 写 targeted promote 与 doctor 失败测试**

断言带非空 `target` 的 inbox fix 被 `promote` 拒绝且 source 不变；独立 fix 保持既有晋升行为。doctor 覆盖 `missing_target_hash` warning、`invalid_target_hash` error、`invalid_fix_id` error，并继续忽略 `archive/`、`work/`。

- [x] **Step 2: 写 CLI / PowerShell 严格参数失败测试**

覆盖：

```text
agent-knowledge resolve-fix --file <path> [--confirm-legacy]
ak resolve <path> [--confirm-legacy]
```

缺 file、未知参数、重复/空参数均不得写文件。PowerShell 只透传一个 file 和可选 flag。

- [x] **Step 3: 运行聚焦测试并确认 RED**

- [x] **Step 4: 实现命令、输出与检查**

导出 `resolveFix`；增加严格命令专用解析；文本输出明确 source、snapshot、resolved。`promote` 在任何临时文件或目标目录写入前检查 `target`。doctor 只扫描当前知识文件，不修改 archive/work。

- [x] **Step 5: 运行聚焦测试并确认 GREEN**

### Task 5: 文档与适配器生命周期同步

**Files:**
- Modify: `../AGENTS.md`
- Modify: `AGENT.md`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/help/ak.zh-CN.txt`
- Modify: `agent-knowledge/tool-adapters/AGENTS.md`
- Modify: `agent-knowledge/tool-adapters/CLAUDE.md`
- Modify: `agent-knowledge/tool-adapters/opencode.md`
- Modify: `agent-knowledge/templates/opencode/knowledge.record-fix.md`
- Modify: `.opencode/command/knowledge.record-fix.md`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`

- [x] **Step 1: 更新唯一模板来源**

明确：inbox 草稿直接改；正式知识创建 targeted fix；人工/Codex 修改 target 后执行 `resolve-fix`；targeted fix 绝不 `promote`；独立 fix 才能沿用 promote。

- [x] **Step 2: 同步实际 OpenCode 命令**

先修改模板，再运行：

```powershell
node bin/agent-knowledge.js sync-adapters --repository-root ..
```

不得手工制造模板与目标差异。

- [x] **Step 3: 更新帮助、README 和 Agent 指令**

记录命令、三工件含义、legacy 边界、失败恢复和人工审核责任。不要把 archive 当检索知识，也不要暗示哈希变化等于语义正确。

- [x] **Step 4: 运行适配器检查与文档相关测试**

### Task 6: 完整验证与完成审计

**Files:**
- Verify all modified files.

- [x] **Step 1: 运行完整测试**

```powershell
npm.cmd test
```

- [x] **Step 2: 运行覆盖率**

```powershell
node --experimental-test-coverage --test tests/*.test.js
```

关键状态分支必须有测试；整体 line coverage 不低于当前 91.36%，branch coverage 不低于当前 79.90%。

- [x] **Step 3: 运行 CLI、适配器和 doctor 验证**

```powershell
node --check bin/agent-knowledge.js
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
node bin/agent-knowledge.js doctor --repository-root ..
powershell -ExecutionPolicy Bypass -File bin/ak.ps1 doctor
```

若本机存在 `C:\idea_workspace_tob\team-agent-knowledge`，额外运行一次只读 doctor 作为非阻塞环境检查；版本库示例知识库 doctor 才是可重复门禁。

- [x] **Step 4: 验证差异和编码**

运行 `git diff --check`；逐一检查新增/修改文本首三字节，确保 UTF-8 无 BOM；PowerShell 5.1 能解析包装器；工作区不存在 resolve 临时文件、测试残留锁或被误改的业务知识正文。

- [x] **Step 5: 需求逐项审计**

以本计划 Success criteria 和权威设计每个状态/命令/工件为清单，逐项记录测试或命令证据。任何缺失、间接或范围不足的证据都视为未完成，继续修复后再结束。
