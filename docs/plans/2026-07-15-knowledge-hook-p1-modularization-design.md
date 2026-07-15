# 知识库钩子 P1 行为保持型模块化设计

## 1. 背景

P0 已完成 CLI 严格参数校验、知识文件真实路径闭环和 mustRead v2，并由 243 项测试锁定行为。当前主要维护风险已经从输入安全转为代码组织：

- `agent-knowledge/bin/agent-knowledge.js` 为 3695 行，命令入口、查询算法、文件安全、生命周期、纠偏恢复、doctor 和仓库维护逻辑混在同一文件。
- `agent-knowledge/tests/agent-knowledge.test.js` 为 5429 行，多个功能域共享一个测试文件，定位和评审成本持续增长。
- 当前活跃团队知识只有 8 个 Markdown，扫描性能不是优先瓶颈，不应提前引入索引、缓存或 MCP。

本阶段采用计划评审路径：只做行为保持型结构拆分，不夹带检索算法、错误语义、锁语义或知识格式变化。

## 2. 目标

- 把单体 CLI 按稳定职责拆为明确模块，形成单向依赖。
- 保持 `bin/agent-knowledge.js` 作为现有公共入口，并兼容当前测试和外部导入。
- 先用现有单体测试保护生产代码迁移，再按功能域拆分测试。
- 每次只迁移一个闭环模块，定向测试和全量测试均通过后再继续。
- 降低后续增加命令、检索策略或生命周期校验时的修改面和循环依赖风险。

## 3. 当前证据链

### 3.1 公共入口

- Node CLI：`agent-knowledge/bin/agent-knowledge.js`
- PowerShell 包装器：`agent-knowledge/bin/agent-knowledge.ps1`、`agent-knowledge/bin/ak.ps1`
- Shell 包装器：`agent-knowledge/bin/agent-knowledge.sh`
- OpenCode 适配器：`.opencode/command/`
- 程序化导出：测试和内部调用从 `bin/agent-knowledge.js` 导入 `searchKnowledge`、`addRule`、`recordFix`、`checkStale`、`refreshProject`、`resolveFix`、`promote`、`listPending`、`doctor`、`syncAdapters`、`writeUniqueFile`、`writeFileAtomic` 等函数。

### 3.2 真实调用链

```text
bin 入口
  -> CLI 全局参数解析与命令级参数解析
  -> 命令路由
  -> 检索 / 知识生命周期 / targeted fix / doctor / 仓库维护
  -> Markdown、frontmatter、真实路径、Git HEAD、模板和文件锁
  -> stdout/stderr、退出码或文件副作用
```

### 3.3 最终数据源与副作用

- 检索数据源：知识库 `knowledge/`、`inbox/`、`synonyms.json`。
- 过期判断数据源：知识 frontmatter 与项目 `git rev-parse HEAD`。
- 生命周期副作用：写入 inbox/knowledge、原子替换、相邻锁、晋升移动。
- targeted fix 副作用：`work/` 锁和恢复状态、`archive/` survivor/snapshot/resolved 审计工件。
- 仓库维护数据源与副作用：命令契约、模板、README 生成区块、OpenCode 适配器。

### 3.4 守卫条件与真实依赖

本次不删除或改写任何守卫。参数校验、真实路径校验、`status` 校验、target hash、锁 owner/token 和工件一致性检查都属于现有可观察契约，迁移后必须原样保留。

## 4. 方案比较

### 4.1 一次性整体拆分

优点是快速缩短主文件；缺点是移动范围过大，生产逻辑和测试结构同时变化时难以定位回归。不采用。

### 4.2 只拆测试

风险最低，但不能解决生产代码职责混杂和后续功能修改面过大的核心问题。不采用。

### 4.3 渐进式垂直拆分

先锁定公共契约和行为基线，再提取基础能力，随后逐个迁移业务模块，最后迁移 CLI 和拆分测试。每一步都可单独回退和验证。采用本方案。

## 5. 目标模块与职责

| 文件 | 职责 |
| --- | --- |
| `bin/agent-knowledge.js` | shebang、兼容 re-export、调用 CLI runner |
| `lib/cli.js` | 命令路由、参数解析、文本/JSON 输出、退出码 |
| `lib/knowledge-files.js` | 知识根解析、Markdown 收集与解析、frontmatter、真实路径、原子文件操作 |
| `lib/locks.js` | 相邻文件锁、锁内容解析与 owner 判断；不改变锁范围或超时 |
| `lib/retrieval.js` | 查询词组、同义词、评分、mustRead 分类、摘要、检索时过期提示 |
| `lib/lifecycle.js` | add-rule、record-fix、check-stale、refresh-project、promote、list-pending |
| `lib/resolve-fix.js` | targeted fix 校验、claim、恢复、发布和审计工件 |
| `lib/doctor.js` | 知识、引用、证据、锁和适配器健康检查 |
| `lib/repository-maintenance.js` | 命令文档与适配器同步/漂移检查 |
| `lib/command-contract.js` | 保持现状，继续作为命令契约解析与渲染来源 |

依赖方向固定为：

```text
bin -> cli -> 功能模块 -> knowledge-files / locks
                           -> command-contract（仅仓库维护和 CLI 帮助）
```

约束：

- 功能模块不得反向依赖 `cli` 或 `bin`。
- 功能模块之间不互相调用；共享基础能力只进入 `knowledge-files` 或 `locks`。
- `resolve-fix` 的恢复状态机保持集中，不拆成大量跨文件私有步骤。
- 不为了减少行数创建通用框架、基类、插件机制或抽象工厂。

## 6. 迁移顺序

1. 补充公共导出契约、典型 CLI 输出/退出码和文件副作用的 characterization test。
2. 提取 `knowledge-files` 与 `locks`，保持函数体、错误文本和调用参数不变。
3. 迁移 `retrieval`，验证排序、mustRead、JSON 和真实样例。
4. 迁移 `repository-maintenance`，验证生成区块和适配器字节级行为。
5. 迁移 `lifecycle`，验证路径、状态、原子写入和相邻锁。
6. 迁移 `resolve-fix`，完整运行关闭、恢复、并发和工件安全测试。
7. 迁移 `doctor`，验证 issue code、顺序、退出码和只读性。
8. 迁移 `cli`，让 `bin` 变为薄入口并 re-export 既有公共 API。
9. 生产代码稳定后，提取 `tests/test-helpers.js`，再把单体测试按 retrieval、lifecycle、resolve-fix、doctor、repository-maintenance、cli 拆分；保留 `command-contract.test.js`。

## 7. 行为保持边界

以下内容不得变化：

- 命令名、参数、未知/重复/缺值校验、帮助文本和全局参数兼容矩阵。
- stdout、stderr、退出码、JSON 字段与字段含义。
- `bin/agent-knowledge.js` 的现有程序化导出。
- 查询分词、同义词组、评分、排序、mustRead 阈值和 5 项上限。
- 知识目录、frontmatter、模板、文件名、时间戳和刷新记录格式。
- 原子写入、相邻锁、resolve 锁、超时、owner/token 和清理语义。
- targeted fix 的 target 校验、哈希、claim、survivor、snapshot、resolved 及恢复顺序。
- doctor 的 issue code、severity、排序、只读边界和适配器检查条件。
- PowerShell、Shell、OpenCode 和 CI 调用方式。

如迁移过程中发现必须改变以上任一项，停止实现并单独提交行为变更提案。

## 8. 测试拆分策略

- 生产代码迁移阶段继续使用现有单体测试，避免同时改变被测代码和测试组织。
- 测试拆分只移动测试及共享 helper，不重写断言、不合并测试名、不降低覆盖。
- 各测试必须继续使用独立临时目录；不得因多文件并发执行而共享可变测试状态。
- 对真实仓库执行的测试保持只读；写入行为继续限定在临时仓库。
- Windows 无权限创建文件 symlink 时，只允许原有对应测试跳过。

## 9. 风险与控制

- **循环依赖**：先固定依赖层级，功能模块不得导入 CLI/bin。
- **模块私有状态漂移**：`synonymsCache` 归 retrieval；临时文件序列归 knowledge-files；锁状态归 locks/resolve-fix，不复制状态。
- **入口执行两次**：只有 bin 判断直接执行并调用 runner；lib 模块导入不得产生 CLI 副作用。
- **错误文本变化**：尽量原样移动函数体，现有 CLI 失败测试继续按文本断言。
- **测试拆分后并发问题**：先验证测试独立性；若暴露共享测试状态，只修测试夹具，不改变生产语义。
- **注释丢失**：移动代码时保留所有相关注释，不清理范围外注释。

## 10. 验证与验收

每个迁移步骤至少执行对应定向测试，并在步骤结束运行全量：

```powershell
npm.cmd test
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
node bin/agent-knowledge.js doctor --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --repository-root ..
```

最终验收：

- 当前 243 项测试保持 0 失败；Windows 权限导致的 2 项 symlink 跳过可保留。
- 公共导出集合、CLI 文本/JSON、退出码和文件副作用与拆分前一致。
- 命令文档和适配器无漂移，真实团队知识库 doctor 通过。
- 典型查询的排序、mustRead 数量和解释字段保持一致。
- 所有修改文件为 UTF-8 无 BOM，`git diff --check` 通过。

## 11. 无法确定点

当前没有阻塞实施的业务不确定点。若模块迁移暴露依赖环或必须改变可观察行为，按行为变更门禁停止并重新评审，不在本重构中自行推断。
