# 命令说明单一来源设计

## 1. 背景

`agent-knowledge` 的命令名称、参数格式、短命令别名、用途、写文件属性和 JSON 支持范围目前分散在 Node CLI、PowerShell 包装器、中文帮助、两份 README、工具适配器和测试中。新增 `resolve-fix`、`sync-adapters` 与 `doctor` 后，详细帮助已经更新，但根 README 仍保留旧命令表和旧纠偏流程，说明人工同步多份结构化命令说明已经产生实际漂移。

本次优化只解决“结构化命令契约重复维护”问题。业务背景、使用边界、风险解释和操作流程仍由人工编写，不把整份 README 或长篇帮助变成生成文件。

## 2. 目标

- 用一份机器可读契约维护 CLI 命令和 `ak` 短命令的结构化说明。
- CLI `--help` 与 PowerShell 基础帮助直接读取同一契约。
- README 和中文帮助中的命令表只从契约生成，不再手工维护。
- 提供只读漂移检查，新增或修改命令后遗漏同步时由 CI 阻断。
- 生成过程只改明确标记的区块，保留区块外全部人工内容。
- 保持零第三方运行时依赖、PowerShell 5.1 兼容和 UTF-8 无 BOM。

## 3. 非目标

- 不自动生成整个 README、AGENT 规则或每个命令的长篇业务说明。
- 不把 `record-fix`、`resolve-fix` 的审核边界压缩成机器字段并替代人工说明。
- 不把 CLI 主分发和 PowerShell `switch` 全面改造成配置驱动路由。
- 不顺带拆分现有 3225 行核心文件或 4916 行测试文件。
- 不增加新的业务命令、知识生命周期或知识库数据格式。
- 不自动提交、推送或修改私有 `team-agent-knowledge`。

## 4. 方案比较与决策

### 4.1 JSON 契约 + 标记区块生成（采用）

使用 JSON 保存命令元数据。Node 负责校验、渲染和同步；PowerShell 5.1 可以直接用 `ConvertFrom-Json` 读取同一文件。README 与中文帮助只在生成标记之间更新。

优点：跨 Node/PowerShell、容易评审、无第三方依赖、生成边界清楚。缺点：需要维护契约校验和区块生成器。

### 4.2 JS 命令注册表（不采用）

把命令元数据放在 JS 模块。Node 使用方便，但 PowerShell 无法直接读取，仍需调用 Node 或维护额外导出格式，削弱跨入口的单一来源价值。

### 4.3 保留多份文档，仅做相互校验（不采用）

CI 解析多个现有文件并比较。改动较小，但每次变更仍要人工修改多份内容，校验器还要理解不同文档格式，没有消除根因。

## 5. 契约文件

新增：

```text
agent-knowledge/command-contract.json
```

顶层结构：

```json
{
  "version": 1,
  "cliCommands": [],
  "akCommands": []
}
```

### 5.1 CLI 命令字段

每个 `cliCommands` 条目包含：

```json
{
  "id": "resolve-fix",
  "name": "resolve-fix",
  "args": "--file <path> [--confirm-legacy]",
  "summary": "校验 targeted fix 已合并并归档审计工件",
  "writeMode": "always",
  "jsonOutput": false
}
```

字段约束：

- `id`：稳定、唯一、非空；本阶段与 `name` 相同，但保留稳定身份以避免未来仅因展示名变化破坏引用。
- `name`：唯一 CLI 命令名，只允许小写字母、数字和连字符。
- `args`：只描述命令名之后的参数；无参数时使用空字符串。
- `summary`：单行中文简述，不能包含换行。
- `writeMode`：只能是 `never`、`always`、`conditional`。
- `jsonOutput`：布尔值，表示该命令是否支持结构化 JSON 输出。

### 5.2 `ak` 短命令字段

每个 `akCommands` 条目包含：

```json
{
  "id": "resolve",
  "name": "resolve",
  "args": "<文件> [--confirm-legacy]",
  "summary": "确认 targeted fix 已合入目标并归档审计",
  "writeMode": "always",
  "jsonOutput": false,
  "aliases": [],
  "mapsTo": "resolve-fix"
}
```

字段约束与 CLI 命令相同，并增加：

- `aliases`：可选的字符串数组，登记 PowerShell 已支持但不进入主命令表的别名。例如 `task` 登记 `before`、`before-task`，`search` 登记 `s`，`check` 登记 `stale`。别名使用与命令名相同的格式约束。
- `mapsTo`：只能是已登记的 CLI 命令名，或封闭集合中的 `wrapper:projects`、`wrapper:raw`。`projects` 由 PowerShell 读取项目索引，`raw` 透传任意底层参数，因此不伪造不存在的固定 CLI 命令。除这两个值外不接受其它 `wrapper:*` 标识。
- `raw` 的 `writeMode` 为 `conditional`，因为是否写文件取决于透传命令。
- `adapters` 的 `writeMode` 为 `conditional`，因为 `--check` 只读、同步模式写文件。

### 5.3 契约校验

加载契约时必须一次性校验：

- 顶层版本、数组和所有必填字段存在且类型正确。
- `id`、`name` 在各自命令集合内唯一；`akCommands` 的所有主命令名和别名在展开后全局唯一，别名不能等于任何主命令名或其它别名。
- 命令名、`writeMode`、单行文本和布尔字段合法。
- `mapsTo` 指向已登记的 CLI 命令，或严格等于 `wrapper:projects` / `wrapper:raw`。
- 不接受未知顶层版本；错误信息指出具体命令和字段。

契约数组顺序就是所有帮助和文档表格的权威展示顺序，生成器不能自行按名称排序。`id`、`name`、`args`、`summary` 不允许 CR、LF 或反引号；Markdown 表格渲染时把字段中的 `|` 转义为 `\|`。这些限制保证代码围栏、行式 CLI 帮助和 Markdown 表格都能确定性生成。

契约非法时，CLI 帮助、文档同步和 PowerShell 基础帮助都应明确失败，不能退回另一份静态完整命令表掩盖问题。

## 6. 代码边界

新增一个聚焦模块：

```text
agent-knowledge/lib/command-contract.js
```

职责：

- 读取并校验 `command-contract.json`。
- 渲染 CLI 使用说明。
- 渲染 `ak` 基础使用说明。
- 渲染 README / 中文帮助需要的 Markdown 或文本区块。
- 替换并校验生成标记，返回预期文件内容，不直接决定业务命令行为。

现有 `agent-knowledge.js` 继续负责：

- 实际命令处理和参数解析。
- 调用契约模块生成 `--help`。
- 实现 `sync-command-docs` 的文件读取、只读比较和原子写入。

现有 `ak.ps1` 继续负责短命令路由，但基础命令总览从 JSON 契约渲染，不再保留完整硬编码 `$BasicUsage` 命令清单。详细帮助仍读取 `help/ak.zh-CN.txt`。

实际路由不会完全配置化。契约只成为“命令说明”的权威来源；现有 CLI 和 PowerShell 行为测试继续证明命令路由与契约一致。

### 6.1 路由与契约双向一致性

“文档由契约生成”不能发现新增实际路由却遗漏契约的情况，因此测试必须从两个入口的真实路由源码提取命令集合并与契约做集合相等校验：

- Node CLI：从 `main` 中既有的 `if (command === '<name>')` 顶层分支提取实际 CLI 命令；`--help` 不是业务命令，不进入集合。
- PowerShell：从 `ak.ps1` 的顶层短命令 `switch` case 提取实际主命令和别名；`help` 和 `default` 作为控制分支排除。契约侧使用每个 `akCommands[].name` 与 `aliases` 的并集比较，生成的主命令表仍只展示 `name`。
- 比较必须双向进行：实际路由多出的命令说明“遗漏契约”，契约多出的命令说明“文档宣称了未实现命令”，两者都使测试失败。
- 提取器只接受当前明确的路由书写形式；未来重构分发结构时，必须同时更新这一契约一致性测试，不能静默跳过无法识别的分支。

该测试是实现结构约束，不把路由改成配置驱动，也不替代每个命令已有的行为测试。

## 7. 生成目标与标记

本阶段生成以下结构化区块：

| 文件 | 区块 |
| --- | --- |
| `README.md` | `AK_COMMAND_TABLE`、`CLI_COMMAND_TABLE` |
| `agent-knowledge/README.md` | `AK_COMMAND_TABLE`、`CLI_COMMAND_LIST` |
| `agent-knowledge/help/ak.zh-CN.txt` | `AK_COMMAND_TABLE` |

标记格式：

```markdown
<!-- BEGIN GENERATED: AK_COMMAND_TABLE -->
...只允许生成器维护...
<!-- END GENERATED: AK_COMMAND_TABLE -->
```

约束：

- 每个目标区块必须恰好有一对开始和结束标记。
- 标记缺失、重复、顺序颠倒或嵌套时直接报错，不修改文件。
- 只替换标记之间的内容，标记和区块外字节保持原样。
- 读取目标后检测其现有换行风格：文件仅含 CRLF 时生成区块使用 CRLF；仅含 LF 时使用 LF；混合换行直接拒绝，不做全文件规范化。区块外字节和原换行保持原样，避免生成混合换行或扩大 diff。
- 新增的契约和 JS 文件使用 LF；所有新写文件均为 UTF-8 无 BOM。
- 相同契约重复同步必须字节级幂等。

生成格式固定如下：

- `AK_COMMAND_TABLE`：列为“短命令、作用”，行顺序等于 `akCommands` 数组顺序。
- `CLI_COMMAND_TABLE`：列为“命令、什么时候用、是否写文件”，行顺序等于 `cliCommands` 数组顺序；写入列由 `writeMode` 映射为固定中文文本。
- `CLI_COMMAND_LIST`：每行由 `name + 可选空格 + args` 组成，不做宽度对齐，避免字段长度变化导致无关空格 diff。
- 所有 Markdown 单元格按第 5.3 节转义，渲染快照测试锁定完整输出。

`AGENT.md`、工具适配器的业务规则段落和 README 的流程解释不纳入生成区块。OpenCode 文件仍沿用现有 `sync-adapters` 模板单一来源，不把两套生成机制混在一起。

## 8. 命令行为

新增底层维护命令：

```text
agent-knowledge sync-command-docs [--check] --repository-root <path>
```

不增加新的 `ak` 别名；需要手工执行时可使用底层命令或 `ak raw`，CI 直接调用底层命令。

### 8.1 同步模式

1. 从工具包内固定位置读取并校验契约。
2. 根据固定仓库布局解析三个目标文件，`--knowledge-root` 不参与解析。
3. 读取全部目标并先完成所有标记校验。
4. 只有全部目标都可安全生成后，逐个使用现有原子写入能力更新发生漂移的文件。
5. 未发生漂移的文件不重写。
6. 输出已同步文件和区块；任何失败返回非零。

标记预检避免在后一个文件标记非法时先修改前一个文件。跨多个文件不承诺事务回滚，但单文件写入必须原子；失败后再次运行可以幂等收敛。

### 8.2 `--check` 模式

- 完全只读，不创建目录、临时文件或锁。
- 比较每个目标的当前区块与契约生成结果。
- 无漂移退出 0；存在漂移列出文件和区块并退出 1。
- 契约或标记非法同样退出 1。

### 8.3 参数边界

- 只接受零个位置参数和唯一可选的 `--check`。
- 使用现有全局 `--repository-root`；重复或未知参数拒绝。
- `--knowledge-root` 对该命令无效并拒绝，避免把私有知识库误当工具仓库。
- 不支持 `--json`，本阶段不增加未请求的机器输出格式。

## 9. CLI 与 PowerShell 帮助

### 9.1 Node CLI

现有硬编码命令行列表改为从 `cliCommands` 渲染。全局选项和环境变量说明可以继续由 CLI 代码维护，因为它们不是命令条目；命令表本身不能再手工复制。

### 9.2 PowerShell

`ak help` 的长篇内容仍来自 `ak.zh-CN.txt`。该文件顶部命令总览由生成标记维护；后续各命令的业务说明保持人工编写。

当详细帮助文件缺失时，`ak.ps1` 使用 `command-contract.json` 生成基础短命令总览。契约缺失或非法时明确报错，不保留另一套完整静态命令表作为降级。

PowerShell 5.1 不能依赖默认代码页读取无 BOM UTF-8。`ak.ps1` 必须使用显式、严格的 UTF-8 解码器读取契约，例如通过 `System.IO.File.ReadAllText` 传入无 BOM、遇到非法字节抛错的 `System.Text.UTF8Encoding`，再交给 `ConvertFrom-Json`。测试契约中的中文 `summary` 必须逐字出现在 PowerShell 基础帮助输出中，不能只检查进程退出码或 BOM。

## 10. CI 门禁

在 `.github/workflows/agent-knowledge-ci.yml` 增加只读步骤：

```text
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
```

顺序建议放在测试之后、`sync-adapters --check` 之前。现有 workflow contract 测试同步验证：

- 命令文档漂移检查存在。
- 使用 `--check`。
- 不执行自动同步。
- 不访问私有知识库。
- Node 和 PowerShell 实际路由集合与契约集合双向一致。

## 11. 测试策略

所有新行为遵循 RED-GREEN：

1. 契约加载：合法契约成功，重复命令/别名、别名与主命令冲突、非法 `writeMode`、非白名单 `wrapper:*`、错误 `mapsTo`、未知版本拒绝。
2. CLI 帮助：命令表来自契约，新增维护命令只定义一次即可出现在 `--help`。
3. 路由一致性：从 Node 与 PowerShell 实际路由源码提取命令，分别验证“路由多出”和“契约多出”都会失败。
4. 标记替换：只替换指定区块，前后人工内容逐字节保留；LF 与 CRLF 目标分别保持原换行，混合换行拒绝。
5. 标记错误：缺失、重复、颠倒时无文件被写入。
6. `--check`：漂移时退出 1 且目标文件字节不变；一致时退出 0。
7. 同步模式：修复漂移、跳过无变化文件、重复执行字节级幂等。
8. 渲染快照：固定三种区块的列、顺序、写入属性映射和 Markdown 转义。
9. PowerShell：基础帮助用严格 UTF-8 读取契约，中文 `summary` 逐字正确；`ak help` 命令总览与契约一致；PowerShell 5.1 参数边界保持严格。
10. 仓库一致性：三个已提交目标执行 `sync-command-docs --check` 通过。
11. CI contract：workflow 包含只读命令文档漂移门禁和路由双向一致性测试。
12. 编码：新增和修改文件保持 UTF-8 无 BOM。
13. 回归：145 项既有测试、适配器检查和 `doctor` 继续通过。

每个行为先增加最小失败测试并确认失败原因是能力缺失，再实现最小代码使其通过；不能先写生成器后补测试。

## 12. 迁移步骤

1. 添加失败测试，约定契约结构、渲染结果和 `sync-command-docs` 行为。
2. 新增契约和校验/渲染模块，使单元测试通过。
3. CLI `--help` 改读契约，并实现同步/检查命令。
4. 给三个文档目标加入生成标记，初始生成内容必须与当前已确认命令说明语义一致。
5. `ak.ps1` 基础帮助改读契约。
6. 更新 CI 和 workflow contract 测试。
7. 运行同步检查、全量测试、覆盖率、适配器检查、`doctor`、PowerShell 解析、diff 和 BOM 检查。

迁移不删除区块外现有说明，不调整命令语义，不修改私有知识库。

## 13. 成功标准

- 修改一个命令的结构化说明时，只需要更新 `command-contract.json`。
- CLI `--help`、PowerShell 基础帮助、两份 README 命令区块和中文帮助总览都反映同一契约；PowerShell 实际别名与契约 `aliases` 双向一致。
- 任一生成区块被手工改坏后，`sync-command-docs --check` 稳定失败且不写文件。
- 运行同步命令只修复生成区块，人工内容不变。
- CI 能阻止命令契约与已提交文档再次漂移。
- 现有命令行为、知识生命周期、适配器同步和私有知识库边界不发生变化。
