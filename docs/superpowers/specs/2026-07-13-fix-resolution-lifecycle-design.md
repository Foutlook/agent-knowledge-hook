# Fix Resolution Lifecycle Design

## 1. 背景

当前 `record-fix --target` 能把人工纠偏关联到一条已确认知识，但后续只有通用 `promote`：它会把 fix 自身移动到 `knowledge/`，不会确认目标正式知识已经吸收纠偏结果。这会让同一结论同时存在于目标规则和独立 fix 中，也无法区分“已经合并”与“仅记录了纠偏”。

本设计建立面向已确认知识的闭环：先由人工或 Agent 修改目标正式知识，再由工具校验目标版本确实发生变化，最后归档 fix。工具不尝试理解自由文本并自动进行语义合并。

## 2. 目标

- 创建带 `target` 的 fix 时记录目标知识的基线哈希。
- 只有目标正式知识已经变化后，才能关闭该 fix。
- 已解决 fix 离开 `inbox/`，但不进入 `knowledge/` 检索范围。
- 带 `target` 的 fix 不允许通过通用 `promote` 形成第二份正式知识。
- 并发执行、归档冲突或中途失败时不覆盖文件、不丢失待确认源记录。
- 为旧版、缺少基线哈希的 targeted fix 提供显式人工确认通道。

## 3. 非目标

- 不根据 fix 的自由文本自动修改 Markdown 章节。
- 不把 fix 的“人工纠正后的结论”自动附加到目标正文。
- 不把目标文件的任意变化等同于语义正确；最终内容仍由人工审核负责。
- 本阶段不实现 CI、遗留锁诊断或大规模模块拆分；这些作为后续独立阶段。
- 不防御拥有知识库同等写权限、故意绕过 source-specific 锁，并在最后一次 `realpath/lstat` 复核与紧随其后的单个文件系统调用之间替换工具私有 `work/` / `archive/` 路径的主动攻击。零依赖 Node 路径 API 不提供可移植的 `openat/renameat2` 目录句柄语义；支持边界是所有协作工具进程遵守同一锁协议，同时对预存链接和每个实际写入点前已经发生的路径置换重新拒绝。

## 4. 方案比较与决策

### 方案 A：人工合并 + 哈希校验 + 归档（采用）

`record-fix` 保存目标基线哈希。人工或 Agent 修改目标后，`resolve-fix` 校验目标仍是正式知识且哈希已经变化，再归档 fix。

优点是不会对自由文本做错误合并，不会由工具覆盖并发修改，符合“非平凡生产变更需要人工理解”的边界。缺点是哈希只能证明目标变化，不能证明语义一定正确，因此命令必须在人工确认后执行。

### 方案 B：完整文件原子替换（不采用）

`apply-fix` 接收一份完整的新目标文件，校验基线后替换正式知识。自动化程度更高，但容易把修订期间的并发修改整体覆盖，且调用方需要管理额外 replacement 文件。

### 方案 C：按 Markdown 章节自动合并（不采用）

工具解析 fix 和规则章节并生成补丁。现有文档是自由文本，章节语义不稳定，自动合并难以证明正确，维护成本和误修改风险最高。

## 5. 数据模型

### 5.1 新建 targeted fix

`record-fix --target knowledge/...` 在 fix frontmatter 中增加：

```yaml
fix_id: <UUID>
target: knowledge/rules/example.md
target_hash: <目标文件原始 UTF-8 字节的 SHA-256 小写十六进制>
```

所有新 fix（包括不带 target 的独立 fix）都写入唯一 `fix_id`，文件名在可读标题后附带 `fix_id` 去除连字符后的前 12 位十六进制，避免已归档记录释放 inbox 文件名后，同日同标题的新 fix 再次撞到旧归档；frontmatter 中始终保留完整 UUID 作为权威身份。

`target_hash` 与 `target` 从同一次目标文件读取结果产生。目标必须位于当前知识库真实路径内、是 `.md` 文件，并且 `status: confirmed`。

独立业务纠偏不传 `--target`，不写 `target_hash`，仍可沿现有通用晋升流程处理。

### 5.2 已解决 fix

归档时更新 frontmatter：

```yaml
status: resolved
updated: YYYY-MM-DD
resolved_at: YYYY-MM-DD
resolved_target_hash: <目标当前 SHA-256>
source: inbox/tech-solution-corrections/example.md
source_survivor: archive/source-survivors/tech-solution-corrections/example.md
source_snapshot: archive/resolved-sources/tech-solution-corrections/example.md
source_hash: <独立只读字节快照的 SHA-256>
```

保留原 `target` 和 `target_hash`，使归档记录能够说明从哪个目标版本演进到哪个版本。

旧版 targeted fix 缺少 `target_hash` 时，只有显式传入 `--confirm-legacy` 才允许归档，并增加：

```yaml
legacy_confirmed: true
```

旧版 fix 同时缺少 `fix_id` 时，工具用 `规范化 source 相对路径 + NUL + 独立 snapshot 原始字节` 的 SHA-256 生成确定性的 `legacy-<hash>` 身份。snapshot 发布前发生的晚到写入属于本次待定 source，身份尚未定稿；snapshot 独占发布后字节和 legacy 身份同时固定。相同 snapshot 重试会得到同一身份。归档路径会永久占用原 source 相对路径对应的归档名；如果人工重新创建同名 legacy source，工具拒绝处理并要求先重命名，不能把它误认为旧记录重试。

## 6. 命令与路径

底层命令：

```text
agent-knowledge resolve-fix --file <inbox纠偏文件> [--confirm-legacy]
```

短命令：

```text
ak resolve <inbox纠偏文件> [--confirm-legacy]
```

只接受以下来源目录：

- `inbox/fixes/`
- `inbox/prd-corrections/`
- `inbox/tech-solution-corrections/`

归档路径保持原分类，并把“保活 inode”和“不可变审计快照”拆成两个工件：

```text
inbox/<分类>/<文件名>.md
  -> archive/source-survivors/<分类>/<文件名>.md  # 与 claim 同 inode，承接晚到写入
  -> archive/resolved-sources/<分类>/<文件名>.md  # 独立 inode 的只读字节快照
  -> archive/resolved/<分类>/<文件名>.md          # status: resolved 的审计记录
```

新 fix 的文件名已经包含唯一 fix ID，因此归档路径不会仅依赖“日期 + 标题”。旧 fix 沿用原文件名，但完成一次归档后不允许复用同一 source 路径。

`archive/` 不参与现有知识检索、必须阅读、待确认清单或正式知识规则匹配。`source-survivors/` 负责保证旧文件句柄的晚到写入不会丢失；`resolved-sources/` 固化本次归档采用的时间点字节。两者都不是第二份知识。

处理中的 source 使用确定性 claim 路径：

```text
inbox/<分类>/<文件名>.md
  -> work/resolving/<分类>/<文件名>.claim/source.md
```

`<文件名>.claim/` 是工具独占创建的确定性私有容器。容器创建成功时内部为空，随后 source 通过单次原子 rename 进入固定 `source.md`，因此 rename 不会覆盖既有 claim 文件。`work/` 同样不参与知识检索和待确认清单。确定性路径使进程中断后再次执行同一命令可以恢复，而不是遗失隐藏的随机临时文件。

锁不直接拼接用户输入。工具先把规范化后的 source 相对路径计算为 SHA-256，再使用固定位置：

```text
work/locks/resolve/<source-path-sha256>.lock
```

只有 `work/locks/resolve/` 和 `work/resolving/<分类>/` 已被安全创建、且所有已有祖先与最终父目录的真实路径仍在知识库根内后，才允许创建锁或移动 source。

## 7. 处理流程

### 7.1 `record-fix`

1. 解析并验证 `target` 的词法路径和 `realpath`，拒绝符号链接或 junction 逃逸。
2. 读取目标完整 UTF-8 内容。
3. 校验目标位于 `knowledge/` 且 `status: confirmed`。
4. 对本次读取的原始字节计算 SHA-256。
5. 生成 UUID `fix_id`，文件名包含其短前缀。
6. 将 `fix_id`、`target` 与 `target_hash` 一起写入新 fix。

### 7.2 人工合并

人工或 Agent 根据已确认结论直接修改 `target` 指向的正式知识。该阶段必须理解目标正文和纠偏证据，工具不自动修改目标。

### 7.3 `resolve-fix`

1. 先只规范化并验证用户传入的 source 词法路径，只允许三个固定 inbox 分类下的 `.md` 路径；根据规范化相对路径推导 claim、快照、归档和哈希锁路径。此时不要求 inbox source 必须存在，也不读取其内容，因为恢复态中的 source 通常已经移走。
2. 安全创建并验证 `work/locks/resolve/`、`work/resolving/<分类>/`、`archive/source-survivors/<分类>/`、`archive/resolved-sources/<分类>/` 与 `archive/resolved/<分类>/`。所有已有祖先、最终父目录及其 `realpath` 必须位于知识库真实根内，不允许 junction/symlink 逃逸。完成这些检查后才获取固定锁路径的跨进程锁；初次检查不能替代实际写入前复核，创建 claim 容器、发布 survivor、写 snapshot 临时文件、发布 snapshot/resolved 前都必须重新验证对应真实父目录。
3. 持锁后按 `resolved archive > immutable snapshot > source survivor > claim container > source` 的顺序识别状态。claim 容器已存在时优先恢复其内部固定 `source.md`，绝不创建第二个容器，也不读取或预检同名 inbox source；每次读取 claim、survivor、快照或归档前，都重新验证 `realpath`、`.md` 扩展和 `lstat().isFile()`。
4. 只有 claim 容器、survivor、快照和归档都不存在、准备首次认领时，才读取并校验 inbox source 普通文件/frontmatter，并对有基线哈希的新格式 target 做无副作用预检。目标不存在、越界、不是 confirmed、不是普通 Markdown 或哈希未变化时 source 原位不动。预检通过后用非递归 `mkdir` 独占创建确定性的空 claim 容器；mkdir 后、rename 前必须重新用 `lstat/realpath` 确认容器仍是知识库真实根内的普通空目录，不能是被替换的 junction/symlink。确认后把 source 单次原子 rename 到容器内固定 `source.md`。因为目标位于本次独占创建并复核为空的私有目录内，遵守同一锁协议的进程无法预置或覆盖 claim 文件。rename 后再次验证 claim 的类型、真实路径和原始字节。rename 自身失败时 source 保持原位；若本次创建的容器仍是知识库内普通空目录则安全删除以允许重试，容器已变化或非空则保留现场并报告。source 与全部恢复工件都不存在时拒绝。
5. 从 claim 读取并解析内容，验证原 source 分类、frontmatter `status: pending` 且存在 `target`。有 `target_hash` 时校验 64 位十六进制；无 `target_hash` 时必须显式 `--confirm-legacy`。有 `fix_id` 时校验 UUID；无 `fix_id` 时只标记为待定 legacy 身份，不在独立 snapshot 发布前生成或缓存最终 ID。
6. claim 建立后再次验证目标真实路径、`.md` 类型和 `status: confirmed`，计算当前 SHA-256。哈希未变化则拒绝。该二次校验关闭预检到认领之间的 target 变化窗口；二次校验失败时保留确定性 claim 供原命令重试，不把 claim 写回 inbox。
7. 目标验证通过后，先重新验证 survivor 父目录真实路径，再使用硬链接把 claim 独占发布到 `archive/source-survivors/<分类>/<文件名>`。硬链接成功后先移除 claim 文件和空 claim 容器，再把 survivor 设为只读并通过 `stat.mode & 0o222 === 0`（或平台等价检查）确认；该顺序避免 Windows 因只读属性无法 unlink。硬链接保证移除 claim 只减少一个文件名：旧文件句柄的晚到写入仍由 survivor 持有。文件系统不支持同卷硬链接时安全失败并保留 claim，不做复制降级；只读设置或确认失败时保留 survivor 并允许重试。
8. `survivor 存在、snapshot 不存在` 时，必须先幂等执行并确认 survivor 只读，再从 survivor 读取完整原始字节。写 snapshot 临时文件前和用硬链接独占发布到 `archive/resolved-sources/<分类>/<文件名>` 前都重新验证 snapshot 父目录真实路径；发布后移除临时路径，再幂等执行并确认 snapshot 只读。snapshot 与 survivor 必须是不同 inode。重新读取 snapshot 验证完整字节和 SHA-256 后，再读取 survivor；两者字节不一致时保留两个版本并报并发写入冲突，不发布 resolved 归档。
9. `survivor + snapshot 存在、resolved archive 不存在` 时，必须先幂等执行并确认 survivor、snapshot 都是只读，再从 snapshot 解析身份和 target 字段并再次执行第 5、6 步校验；重新计算 snapshot 的 `source_hash`，缺 `fix_id` 时此时才用“规范化 source 相对路径 + NUL + snapshot 原始字节”生成最终 legacy 身份。发布前再次确认 survivor 完整字节仍等于 snapshot。基于 snapshot 构造 `resolved` 审计内容，增加 `source_survivor` 和 `source_snapshot`；写临时文件前和独占硬链接发布前都重新验证 resolved 父目录真实路径。发布后再次读取 survivor 和 snapshot：只有两者仍完全一致，当前调用才返回成功；否则保留三个工件并报告晚到写入冲突，不能声称本次纠偏已经完整关闭。
10. `snapshot 存在、archive 不存在、claim 不存在` 的恢复态必须执行第 9 步，不得回头读取 claim。snapshot 存在但 survivor 缺失属于不完整状态，保留现有工件并报错。
11. 如果调用开始时已存在完整归档、独立 snapshot 和 survivor，先执行第 7.5 节的幂等校验，不重新读取当前 target；因此目标后续再次变化、删除或失去 confirmed 状态，不影响已完成记录的身份判断。

### 7.4 并发和中断恢复

- 同一 source 的所有 resolve 调用使用规范化 source 路径哈希对应的固定锁；两个进程不能同时认领、快照或发布同一 source 生命周期。
- claim 文件与 source 同时存在时，source 必然是原子 rename 后重新创建的新生命周期；始终处理旧 claim且绝不触碰新 source。任何分支都不覆盖 claim。
- claim 容器存在但内部 `source.md` 不存在时：若原 source 仍存在且容器为空，可安全删除空容器后重新认领；容器非空或 source 也不存在时保留现场并报不完整状态。
- claim 到 survivor 的独占硬链接先于 claim 路径移除；移除只减少一个文件名，不删除 inode 内容，因此不存在“最后一次哈希检查后写入被删除”的窗口。
- survivor 建立前发生失败：认领前的预检失败时 source 原位不动；claim 建立后的二次校验或发布失败时保留确定性 claim 容器并报告恢复路径，后续同一命令优先从 claim 重试。任何阶段都不把 claim 反向写回 inbox，避免覆盖或删除编辑器重建的 source。
- survivor 一旦建立，绝不再把 claim、survivor 或快照恢复到 inbox。后续失败从这些工件恢复，避免 resolved 归档与 pending source 反复切换。
- 如果 claim 和 survivor 同时存在，只有 `stat.dev` 与 `stat.ino` 都相同才允许移除 claim 路径并继续；不同则视为冲突，保留两者等待人工处理。移除 claim 后再设置 survivor 只读。
- snapshot 是从 survivor 字节独占发布的不同 inode 文件；发布 resolved 前后都校验 survivor 与 snapshot 完整字节一致。晚到写入永远保留在 survivor，并使当前调用失败，不会静默产生错误完成态。
- 归档或快照发生身份冲突时，绝不覆盖、删除或恢复任一文件。
- 新 fix 通过 UUID 文件名避免跨生命周期归档冲突；legacy source 路径完成归档后被视为保留路径，人工复用时直接报冲突。

### 7.5 完成态幂等校验

完成态不依赖 target 的当前内容，只验证三个已持久化工件，并先处理残留 claim：

1. survivor、snapshot 和归档都必须是知识库真实根内的普通 `.md` 文件，snapshot 与 survivor 必须是不同 inode，归档必须是 `status: resolved`。若 claim 容器仍存在，先检查容器内固定 `source.md`：它与 survivor 不同 inode 时保留全部工件并报冲突；同 inode 时先移除内部 claim 文件，再只在容器为空时移除容器。Windows 如需临时清除共享 inode 的只读属性才能 unlink，必须在 `finally` 中恢复 survivor 只读；unlink 失败则保留 claim 并返回失败。空 claim 容器或含未知文件的非空容器按第 7.4 节不完整状态处理，不能直接 stat 容器代替内部文件比较。
2. 残留 claim 处理完成后，再幂等设置并确认 survivor、snapshot 只读，不能把“创建时 chmod 过”当成持久状态假设。未确认只读前不得返回成功。
3. 重新计算 snapshot 完整原始字节的 SHA-256，必须等于归档 `source_hash`。survivor 当前字节也必须与 snapshot 相同；不同表示只读前持有的旧句柄发生了晚到写入，旧完成记录保持可审计，但该命令返回冲突并要求人工处理 survivor 新内容。
4. 归档的 `source`、`source_survivor`、`source_snapshot`、`fix_id`、`target`、`target_hash` 必须与规范化 source 路径和 snapshot 内容一致；`resolved_target_hash` 必须是合法 64 位十六进制，且不能等于 `target_hash`。
5. 工具使用 snapshot 正文和归档中已经持久化的 `updated`、`resolved_at`、`resolved_target_hash`、legacy 标记等字段重新构造规范化 resolved 内容，并与归档完整字节逐字节比较。只有完整载荷一致才视为幂等成功；frontmatter 身份相同但正文截断仍是冲突。
6. 若同名 source 又出现在 inbox，完成态仍保持不变，但命令拒绝吞掉新 source，提示这是 source 路径复用；新 source 必须重命名后单独处理。

## 8. `promote` 边界

`promote` 读取 source frontmatter。如果存在非空 `target`，直接拒绝，并提示：

1. 先修改目标正式知识；
2. 再执行 `resolve-fix`。

没有 `target` 的独立 fix、规则草稿或其他既有 inbox 条目仍保持原晋升行为。

## 9. `doctor` 扩展

对 `inbox/` 中带 `target` 的 pending fix 增加：

- `missing_target_hash` warning：缺少基线哈希，说明它是旧版记录，需要 `--confirm-legacy`。
- `invalid_target_hash` error：存在哈希但不是 64 位十六进制。
- `invalid_fix_id` error：存在 `fix_id` 但不是 UUID。

`archive/` 暂不纳入 doctor 主扫描，避免已归档审计记录影响当前知识健康结果。

## 10. 错误处理

- source 不在允许目录、不是普通 `.md` 文件、真实路径越界、状态不是 pending、缺少 target：拒绝且不写归档。
- 目标不存在、越界、通过链接逃逸、不是 Markdown、不是 confirmed 或哈希未变化：认领前预检失败时 source 原位不动；认领后二次校验失败时保留 claim；survivor 建立后保留 survivor/snapshot 等现有工件等待重试。
- 旧记录未显式确认：认领前拒绝，source 原位不动。
- work/ 或 archive/ 的已有祖先、父目录通过链接逃逸知识库：在创建锁或移动 source 前拒绝；如果是恢复态，则保留当前工件并报告路径。
- claim/survivor、survivor/snapshot、归档/snapshot 或复用 source 发生冲突：拒绝并保留全部工件，不自动恢复到 inbox。
- 归档发布失败：保留 survivor 和独立只读 snapshot；重试从 snapshot 继续，不依赖当前 source 或 claim。
- claim 后原 source 被重新创建：新 source 始终保持不变；旧 claim 或快照独立完成，两个生命周期不互相删除。

## 11. 测试策略

所有行为遵循 RED-GREEN：

- `recordFix` 写入唯一 `fix_id` 和正确 `target_hash`，同日同标题多轮记录不会与历史归档冲突，并拒绝 realpath 逃逸。
- 未修改目标时 `resolveFix` 失败且 source 不变。
- 修改目标后成功归档，目标正文不被命令再次修改。
- 非 confirmed 目标、非法哈希/UUID、非法 source 目录、source 文件链接和 source 父目录逃逸全部拒绝。
- legacy fix 默认拒绝，`--confirm-legacy` 后成功并记录标记。
- 归档冲突不覆盖；只有快照哈希、身份字段和完整规范化载荷全部匹配的既有归档支持幂等成功，且不读取当前 target。
- 并发 resolve 只产生一份归档且最终 source 消失。
- claim 与 source 同时存在时优先旧 claim，新 source 不被移动、删除或覆盖；进程中断后可从确定性 claim 恢复。
- claim 文件与 source 同时存在时，source 作为原子 rename 后的新记录完整保留；空 claim 容器按第 7.4 节恢复，不删除任何非空未知内容。
- claim 建立 survivor 后发生字节变化时，由于两个路径共享 inode，变化后的内容仍保留在 survivor；独立 snapshot 只在稳定读取后作为本次审计输入。
- claim 与 survivor 同时存在时只允许同 `dev/ino` 的幂等清理，不同 inode 必须保留两者并报冲突；Windows 必须先移除 claim 再设置 survivor 只读。
- survivor-only、survivor+snapshot 两种中断恢复态均可继续；snapshot-only 必须报不完整状态，不能无条件读取 claim。
- resolved 发布前后 survivor 发生晚到写入时当前调用失败，survivor 新内容、独立 snapshot 和 resolved 工件全部保留供人工判断。
- survivor 只读设置失败后中断、snapshot 发布后但只读设置前中断，两种恢复态都必须先重新设置并确认对应文件只读，未确认前不得发布或接受 resolved 完成态。
- 归档已发布后目标再次修改、删除或失去 confirmed 状态，重试仍通过持久化工件判断完成。
- 正文截断但 frontmatter 身份仍匹配的归档不能通过幂等校验。
- archive/work 目录的 junction/symlink 逃逸被拒绝，真实路径仍在知识库内的链接按既有边界允许。
- 初次内部路径检查后、claim/survivor/snapshot/resolved 实际发布前替换父目录为外部 junction/symlink 时，每个写入点都重新拒绝，外部目录不得出现工件。
- targeted fix 禁止 promote，独立 fix 仍可 promote。
- doctor 报告缺失/非法哈希并保持 severity 契约。
- Node CLI 与 PowerShell 短命令严格透传参数，未知参数不得触发写入。
- 完整测试、覆盖率、真实 doctor、适配器漂移和 UTF-8 无 BOM 检查保持通过。

## 12. 文档更新

同步更新：

- 工作区 `AGENTS.md` 与工具 `AGENT.md`；
- `agent-knowledge/README.md`、中文帮助和工具适配器说明；
- OpenCode `knowledge.record-fix` 模板及实际命令；
- 明确 targeted fix 的最终动作是 `resolve-fix`，不是 `promote`。
