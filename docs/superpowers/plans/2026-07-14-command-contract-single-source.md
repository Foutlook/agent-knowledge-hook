# Command Contract Single Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一份经过严格校验的命令契约驱动 Node CLI 帮助、PowerShell 基础帮助和三处文档命令区块，并通过只读 CI 门禁阻止命令说明再次漂移。

**Architecture:** 新增 `command-contract.json` 保存 CLI 与 `ak` 命令元数据，由独立模块负责加载、校验、渲染和生成区块替换；现有 CLI 继续保留业务路由，只增加帮助渲染与 `sync-command-docs` 编排；PowerShell 继续保留短命令路由，但用严格 UTF-8 读取契约生成基础帮助。测试从真实 Node/PowerShell 路由提取命令集合，与契约做双向相等校验。

**Tech Stack:** Node.js ESM、Node 内置 test runner、PowerShell 5.1、JSON、GitHub Actions

---

## 文件范围

- 新增：`agent-knowledge/command-contract.json`
- 新增：`agent-knowledge/lib/command-contract.js`
- 新增：`agent-knowledge/tests/command-contract.test.js`
- 修改：`agent-knowledge/bin/agent-knowledge.js`
- 修改：`agent-knowledge/bin/ak.ps1`
- 修改：`README.md`
- 修改：`agent-knowledge/README.md`
- 修改：`agent-knowledge/help/ak.zh-CN.txt`
- 修改：`.github/workflows/agent-knowledge-ci.yml`
- 不修改：父仓库、`team-agent-knowledge`、业务规则和命令行为

## Task 1：建立命令契约、校验器和确定性渲染器

**Files:**

- Create: `agent-knowledge/tests/command-contract.test.js`
- Create: `agent-knowledge/command-contract.json`
- Create: `agent-knowledge/lib/command-contract.js`

- [ ] **Step 1：先写合法契约和渲染快照测试**

在 `tests/command-contract.test.js` 中先导入尚不存在的模块，并覆盖：

```js
import {
  loadCommandContract,
  renderAkCommandTable,
  renderCliCommandList,
  renderCliCommandTable,
  renderCliUsage,
} from '../lib/command-contract.js';
```

断言真实契约加载成功、数组顺序不被排序，并锁定三种文档区块和 CLI 命令列表的完整输出；测试数据至少包含 `|`，证明 Markdown 渲染为 `\|`。

- [ ] **Step 2：运行聚焦测试并确认 RED**

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: FAIL，原因是 `lib/command-contract.js` 或 `command-contract.json` 尚不存在，而不是测试语法错误。

- [ ] **Step 3：新增完整命令契约**

`cliCommands` 按当前权威展示顺序登记：

```text
before-task, search, add-rule, record-fix, check-stale,
refresh-project, resolve-fix, promote, list-pending,
sync-adapters, doctor, sync-command-docs
```

`akCommands` 登记：

```text
task      aliases=[before,before-task] mapsTo=before-task
search    aliases=[s]                  mapsTo=search
projects  aliases=[]                   mapsTo=wrapper:projects
check     aliases=[stale]              mapsTo=check-stale
refresh   aliases=[]                   mapsTo=refresh-project
bug       aliases=[]                   mapsTo=record-fix
prd       aliases=[]                   mapsTo=record-fix
tech      aliases=[]                   mapsTo=record-fix
rule      aliases=[]                   mapsTo=add-rule
promote   aliases=[]                   mapsTo=promote
resolve   aliases=[]                   mapsTo=resolve-fix
pending   aliases=[]                   mapsTo=list-pending
adapters  aliases=[]                   mapsTo=sync-adapters
doctor    aliases=[]                   mapsTo=doctor
raw       aliases=[]                   mapsTo=wrapper:raw
```

其中 `raw`、`adapters` 使用 `writeMode: "conditional"`；所有 JSON 文本按真实帮助含义填写，不扩展命令语义。

- [ ] **Step 4：实现仅支持合法路径的最小加载和渲染模块**

模块至少导出：

```js
export function validateCommandContract(contract) {}
export async function loadCommandContract(filePath) {}
export function renderCliUsage(contract) {}
export function renderAkBasicUsage(contract) {}
export function renderAkCommandTable(contract) {}
export function renderCliCommandTable(contract) {}
export function renderCliCommandList(contract) {}
```

这一步只实现让真实合法契约和渲染快照通过所需的最小加载、基础结构读取与渲染，不提前实现下一步尚无失败测试覆盖的重复项、别名冲突、枚举和映射校验。

- [ ] **Step 5：补全部非法契约参数化测试并确认 RED**

逐项复制合法最小契约后只破坏一个条件，覆盖：未知版本、重复 `id`、重复命令名、别名与主命令冲突、别名相互冲突、非法 `writeMode`、非法布尔值、未知 `mapsTo`、非白名单 `wrapper:*`、CR/LF/反引号。

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: 合法契约和渲染测试 PASS；每类尚未实现的严格校验至少有对应用例 FAIL，且失败来自非法契约未被拒绝。

- [ ] **Step 6：实现完整严格校验并验证 GREEN**

补齐 `version === 1`、顶层数组、字段类型、命令格式、单行/无反引号文本、`writeMode`、布尔值、`id/name` 唯一、`ak` 主命令和别名展开后全局唯一，以及 `mapsTo` 只指向真实 CLI 或 `wrapper:projects` / `wrapper:raw`。错误必须包含条目和字段上下文。

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: PASS，渲染快照、顺序、转义和全部非法契约用例通过。

- [ ] **Step 7：提交契约基础**

```powershell
git add agent-knowledge/command-contract.json agent-knowledge/lib/command-contract.js agent-knowledge/tests/command-contract.test.js
git commit -m "建立命令说明统一契约"
```

## Task 2：让 CLI 帮助读取契约，并锁定真实路由一致性

**Files:**

- Modify: `agent-knowledge/bin/agent-knowledge.js:2842`
- Modify: `agent-knowledge/tests/command-contract.test.js`

- [ ] **Step 1：先写 CLI 帮助和 Node 路由双向一致性测试**

测试通过子进程运行：

```powershell
node bin/agent-knowledge.js --help
```

断言退出 0、命令顺序等于 `cliCommands`、`sync-command-docs` 只出现一次。再从 `main` 的 `if (command === '<name>')` 顶层分支提取实际路由，断言它与契约 `cliCommands[].name` 集合相等；分别构造“源码多一个路由”和“契约多一个命令”的纯函数用例，证明两个方向都会报错。

提取器必须先用括号/花括号深度定位 `main` 的顶层分发区域，再逐个消费当前允许的 `if (command === '<literal>')` 结构；除 help 分支外，任何顶层引用 `command` 却不符合该结构的分发语句都要报“未知路由结构”，不能忽略。另加一个把分支改成 `switch (command)` 或查表分发的测试，确认提取器会失败并要求同步更新契约测试。

- [ ] **Step 2：运行聚焦测试并确认 RED**

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: FAIL，旧 `usage()` 仍为硬编码，且实际路由尚无 `sync-command-docs`。

- [ ] **Step 3：用契约渲染 CLI 命令说明**

在 `agent-knowledge.js` 中从固定工具目录加载契约；`usage()` 的全局选项和环境变量继续手写，命令列表改用 `renderCliUsage(contract)`。主函数只加载一次契约并将结果传给帮助渲染，契约非法时明确退出非零。

为下一任务预留真实顶层分支：

```js
if (command === 'sync-command-docs') {
  // 下一任务接入严格参数解析和同步实现。
}
```

不要改变其它命令的参数解析和执行顺序。

- [ ] **Step 4：验证帮助和路由契约 GREEN**

Run:

```powershell
node --test tests/command-contract.test.js
node bin/agent-knowledge.js --help
```

Expected: 测试 PASS；帮助中命令顺序和契约一致，无第二份硬编码完整命令表。

- [ ] **Step 5：提交 CLI 帮助改造**

```powershell
git add agent-knowledge/bin/agent-knowledge.js agent-knowledge/tests/command-contract.test.js
git commit -m "统一CLI帮助与命令路由校验"
```

## Task 3：实现安全的生成区块引擎和同步命令

**Files:**

- Modify: `agent-knowledge/lib/command-contract.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/command-contract.test.js`

- [ ] **Step 1：先写纯区块替换 RED 测试**

为 `replaceGeneratedBlock(source, blockName, generated)` 写测试，覆盖：

- LF 文件保持 LF；CRLF 文件保持 CRLF。
- 标记外前后内容逐字节不变。
- 缺失、重复、颠倒、嵌套标记明确失败。
- 混合换行明确失败。
- 同一输入重复生成字节级相同。

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: FAIL，模块尚未导出替换函数。

- [ ] **Step 2：实现不写文件的区块替换函数并验证 GREEN**

实现要点：先检测全文件换行风格，再验证指定标记恰好一对且不与其它生成标记嵌套；只返回新字符串和 `changed` 状态，不在库函数内写文件。

- [ ] **Step 3：先写 `sync-command-docs` 集成 RED 测试**

在临时仓库建立三份带标记目标，覆盖：

- `--check` 有漂移退出 1、列出文件和区块、文件字节不变，且不产生临时文件/锁/目录。
- 同步模式只写漂移文件，再次运行无写入且字节不变。
- 任一目标标记非法时，预检失败，前面目标也未修改。
- 拒绝位置参数、重复 `--check`、未知参数、`--knowledge-root`、`--json`。
- 缺少或重复 `--repository-root` 明确失败。

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: FAIL，命令尚未实现。

- [ ] **Step 4：实现同步编排和严格参数边界**

在 CLI 中固定三个目标与区块映射，先读取并预检所有文件，再决定写入。同步模式复用现有 `writeFileAtomic`，只写 `changed === true` 的文件；检查模式完全只读。该命令不调用知识库目录初始化，也不进入锁逻辑。

- [ ] **Step 5：验证同步命令 GREEN**

Run:

```powershell
node --test tests/command-contract.test.js
node --check bin/agent-knowledge.js
node --check lib/command-contract.js
```

Expected: 全部 PASS；失败场景无部分写入，检查模式无副作用。

- [ ] **Step 6：提交同步引擎**

```powershell
git add agent-knowledge/lib/command-contract.js agent-knowledge/bin/agent-knowledge.js agent-knowledge/tests/command-contract.test.js
git commit -m "增加命令文档同步与漂移检查"
```

## Task 4：迁移三份文档到受控生成区块

**Files:**

- Modify: `README.md`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/help/ak.zh-CN.txt`
- Modify: `agent-knowledge/tests/command-contract.test.js`

- [ ] **Step 1：先写真实仓库一致性测试并确认 RED**

测试在仓库根运行：

```powershell
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
```

测试最终断言命令成功；此时先运行应因当前文档尚无完整标记而 RED，且失败原因必须指向缺失标记。

- [ ] **Step 2：给目标位置加入唯一生成标记**

严格加入：

- 根 `README.md`：`AK_COMMAND_TABLE`、`CLI_COMMAND_TABLE`
- `agent-knowledge/README.md`：`AK_COMMAND_TABLE`、`CLI_COMMAND_LIST`
- `agent-knowledge/help/ak.zh-CN.txt`：`AK_COMMAND_TABLE`

只把既有结构化命令表/列表放入标记；业务流程、风险边界、示例和解释保留为人工内容。补一段简短维护说明，指出结构化区块由契约生成，不应手改。

- [ ] **Step 3：运行生成器并审查最小 diff**

Run:

```powershell
node bin/agent-knowledge.js sync-command-docs --repository-root ..
git diff -- README.md agent-knowledge/README.md agent-knowledge/help/ak.zh-CN.txt
```

Expected: 只出现标记、契约生成区块和必要维护说明；区块外原有说明与评论不丢失。

- [ ] **Step 4：验证真实仓库已收敛且幂等**

先检查收敛，再记录文件哈希、重复同步并比较：

```powershell
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
$targets = @('..\README.md', 'README.md', 'help\ak.zh-CN.txt')
$before = @{}; foreach ($target in $targets) { $before[$target] = (Get-FileHash -Algorithm SHA256 $target).Hash }
node bin/agent-knowledge.js sync-command-docs --repository-root ..
$after = @{}; foreach ($target in $targets) { $after[$target] = (Get-FileHash -Algorithm SHA256 $target).Hash }
foreach ($target in $targets) { if ($before[$target] -ne $after[$target]) { throw "重复同步修改了 $target" } }
```

执行第二个命令前，用 `Get-FileHash -Algorithm SHA256` 记录三份目标的哈希；执行后重新计算并逐一比较，哈希必须完全相同。`git diff` 仅用于审查待提交内容，不使用 `git diff --exit-code` 判断尚未暂存文件的幂等性，也不能误丢弃待提交文档。

- [ ] **Step 5：运行聚焦测试并提交文档迁移**

```powershell
node --test tests/command-contract.test.js
git add README.md agent-knowledge/README.md agent-knowledge/help/ak.zh-CN.txt agent-knowledge/tests/command-contract.test.js
git commit -m "迁移命令说明到统一生成区块"
```

## Task 5：让 PowerShell 基础帮助严格读取同一契约

**Files:**

- Modify: `agent-knowledge/bin/ak.ps1:1-80`
- Modify: `agent-knowledge/tests/command-contract.test.js`

- [ ] **Step 1：先写 PowerShell 基础帮助与路由 RED 测试**

测试复制 `ak.ps1` 和契约到临时工具目录、故意不放 `help/ak.zh-CN.txt`，运行 `help` 后逐字断言中文 `summary` 和主命令顺序。再覆盖非法 UTF-8 契约必须非零退出，不能乱码或静默降级。

复用 Task 1 的合法最小契约，参数化生成 PowerShell 语义非法样本，至少覆盖：未知版本、重复 CLI 名称、`ak` 别名与主命令冲突、重复别名、非法 `writeMode`、非布尔 `jsonOutput`、未知 CLI `mapsTo` 和非白名单 `wrapper:*`。每个样本运行 `ak.ps1 help` 都必须非零退出，stderr 指向相应字段，且 stdout 不出现静态降级命令表。

从 `ak.ps1` 顶层 `switch ($command)` 的当前复合分支提取主命令和别名，排除 help/default 控制分支，断言实际集合等于 `akCommands[].name + aliases`；分别证明源码多出和契约多出都会失败。提取器用花括号深度消费 switch 的每个顶层 case，只允许字符串 case 和 `{ $_ -in @('...') }` 复合 case；任何其它 case 形式或未消费的顶层 selector 都明确失败。增加一个改成未知 case 写法的测试，证明不会静默漏掉路由。

- [ ] **Step 2：运行聚焦测试并确认 RED**

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: FAIL，`Write-Usage` 仍包含硬编码命令清单，且非法 UTF-8/语义非法契约尚未被严格拒绝。

- [ ] **Step 3：实现严格 UTF-8 契约读取和基础帮助渲染**

在 `ak.ps1` 增加固定契约路径，并使用：

```powershell
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$json = [System.IO.File]::ReadAllText($CommandContractFile, $utf8)
$contract = $json | ConvertFrom-Json
```

PowerShell 侧增加聚焦的 `Assert-CommandContract`，对基础帮助会读取的同一份契约执行与 Node 等价的语义校验：`version === 1`、数组和必填字段类型、命令名格式、单行/无反引号文本、合法 `writeMode`、布尔 `jsonOutput`、`id/name` 唯一、`ak` 主命令与别名展开后唯一，以及 `mapsTo` 只能指向已登记 CLI 或两个白名单 wrapper。不要因为实现语言不同放宽契约；任一非法项都明确失败且不输出静态降级清单。`Write-Usage` 只保留固定标题/调用格式，从 `akCommands` 逐项输出主命令，不展示 alias 为独立行；详细帮助存在时继续用 `Get-Content -Encoding UTF8`。

- [ ] **Step 4：验证 PowerShell 帮助、别名和语法 GREEN**

Run:

```powershell
node --test tests/command-contract.test.js
powershell -NoProfile -Command "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'bin/ak.ps1'), [ref]$null, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors; exit 1 }"
powershell -NoProfile -ExecutionPolicy Bypass -File bin/ak.ps1 help
```

Expected: 测试与语法解析 PASS；中文显示正确；现有别名行为不变。

- [ ] **Step 5：提交 PowerShell 帮助改造**

```powershell
git add agent-knowledge/bin/ak.ps1 agent-knowledge/tests/command-contract.test.js
git commit -m "统一短命令基础帮助来源"
```

## Task 6：增加 CI 漂移门禁

**Files:**

- Modify: `.github/workflows/agent-knowledge-ci.yml`
- Modify: `agent-knowledge/tests/command-contract.test.js`

- [ ] **Step 1：先写 workflow contract RED 测试**

读取 workflow 并断言：

- 测试步骤之后存在 `sync-command-docs --check --repository-root ..`。
- 它位于 `sync-adapters --check` 之前。
- 不出现无 `--check` 的 CI 自动同步。
- 不传 `--knowledge-root`，不访问私有知识库。

Run:

```powershell
node --test tests/command-contract.test.js
```

Expected: FAIL，workflow 尚无新门禁。

- [ ] **Step 2：加入只读 CI 步骤并验证 GREEN**

在 `Run tests` 后增加：

```yaml
- name: Check generated command documentation
  run: node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
```

Run:

```powershell
node --test tests/command-contract.test.js
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
```

Expected: PASS。

- [ ] **Step 3：提交 CI 门禁**

```powershell
git add .github/workflows/agent-knowledge-ci.yml agent-knowledge/tests/command-contract.test.js
git commit -m "增加命令说明漂移CI门禁"
```

## Task 7：全量回归、编码检查和最终审查

**Files:**

- Verify only unless a focused defect is found

- [ ] **Step 1：运行全量测试**

```powershell
npm.cmd test
```

Expected: 原有 145 项测试无回归，新测试全部通过；Windows 文件符号链接测试允许保持既有单项 skip，不允许新增 skip 或 fail。

- [ ] **Step 2：运行覆盖率并核对没有明显回落**

```powershell
node --test --experimental-test-coverage tests/*.test.js
```

Expected: 全部测试通过；重点检查新模块的错误分支，整体覆盖率不应因新代码出现无测试的大幅下降。

- [ ] **Step 3：运行维护命令与静态语法检查**

```powershell
node --check bin/agent-knowledge.js
node --check lib/command-contract.js
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
node bin/agent-knowledge.js doctor --repository-root ..
powershell -NoProfile -Command "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'bin/ak.ps1'), [ref]$null, [ref]$errors) > $null; if ($errors.Count -gt 0) { $errors; exit 1 }"
```

Expected: 全部退出 0，且检查命令不写文件。

- [ ] **Step 4：检查 UTF-8 无 BOM、换行和范围**

检查所有新增/修改文本文件前三字节均不是 `EF BB BF`；确认契约和新 JS 使用 LF，既有文档保持原换行类型，无混合换行。审查：

```powershell
git diff --check
git status -sb
git diff --stat origin/main...HEAD
git diff origin/main...HEAD -- . ':(exclude)docs/superpowers/specs/2026-07-14-command-contract-single-source-design.md' ':(exclude)docs/superpowers/plans/2026-07-14-command-contract-single-source.md'
```

Expected: 无尾随空白、无父仓库和私有知识库变化、改动仅覆盖本计划文件范围。

- [ ] **Step 5：对照成功标准做人工审查**

手工确认：

- 改一个契约字段后，五个帮助/文档入口均由同一来源反映。
- 手改任一生成区块后，`--check` 失败且不写文件。
- 实际 Node/PowerShell 路由任一侧新增或删减时，集合测试失败。
- 区块外业务说明、注释和流程没有丢失。
- 未把实际命令分发重构为配置驱动，未引入第三方依赖。

- [ ] **Step 6：仅在修复了最终审查发现的问题时提交**

若最终审查产生必要修复，先增加能够复现的失败测试，再做最小修复并提交：

```powershell
git add <仅本次修复文件>
git commit -m "修正命令说明统一来源回归问题"
```

若没有文件变化，不创建空提交。
