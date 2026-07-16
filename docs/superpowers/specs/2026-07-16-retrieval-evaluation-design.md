# 知识库检索效果评测设计

## 1. 背景

现有知识库钩子已经通过单元测试覆盖关键词提取、同义词扩展、查询组覆盖率、排序、必读分级、摘要和过期提示。这些测试能够证明既定行为没有被意外改坏，但不能回答以下问题：

- 新分词策略是否减少误报的同时造成真实知识漏召回。
- `aliases`、`symbols`、`services`、`modules` 等结构化信号是否真正改善排序。
- Markdown 按章节检索是否降低阅读量，同时仍能定位到完整证据。
- 关联链接扩展和低置信二次查询带来的召回收益，是否值得它们增加的噪声与耗时。

后续检索改动不能再只依赖示例查询和直觉判断。必须先建立可重复的离线评测基线，同一知识语料、同一批真实任务和同一套人工标注分别运行改动前后版本，再根据指标与逐条差异决定是否接受改动。

## 2. 前提与边界

- 团队知识只包含 Markdown，不设计 PDF、Excel、OCR 或其他格式处理。
- `agent-knowledge-hook` 是可公开的通用工具仓；真实业务任务、知识正文和人工相关性标注不得进入该仓。
- `team-agent-knowledge` 是私有知识仓，负责保存真实评测套件、语料清单和经审核的基线报告。
- 评测只判断知识检索与排序效果，不替代真实代码调查，也不评价最终业务结论是否正确。
- 首期保持零运行时依赖，评测套件使用 JSON，不引入 YAML 解析库、数据库或向量服务。
- 评测过程对源知识库只读；临时隔离语料和输出报告只能写入显式目标目录或系统临时目录。

## 3. 目标

- 为每次检索算法改动提供可重复的改动前、改动后对比。
- 同时衡量必读精确率、必读召回率、前五召回、首条命中、排序质量、负例误报、确定性和耗时。
- 允许未来章节级检索接入同一套评测，而不要求首期先实现章节切分。
- 对每一条指标变化保留查询级差异，避免汇总分数掩盖关键业务回归。
- 检测评测语料或标注已经变化，禁止拿不同语料上的结果直接比较。
- 在通用工具仓中只保存脱敏合成语料和评测引擎测试，保护私有知识边界。

## 4. 非目标

- 不在本阶段修改现有分词、评分、必读判定或 Markdown 数据格式。
- 不引入持久化倒排索引、向量检索、MCP Server 或 Obsidian 查询语言。
- 不自动生成真实任务的相关性标注；标注必须由理解业务上下文的人审核。
- 不把耗时优化作为牺牲准确率的理由。
- 不把一次评测通过等同于可以跳过 IDE 和人工代码审核。

## 5. 方案比较与决策

### 5.1 继续增加示例单元测试

优点是实现最简单，适合锁定单个规则。缺点是每个用例通常只构造两三个文件，无法衡量真实语料上的整体排序、误报和指标权衡，也无法形成统一的新旧版本报告。

结论：继续保留单元测试，但不能作为效果评测的唯一依据。

### 5.2 离线标注集与基线报告

固定一份 Markdown 语料清单，为真实任务标注必读、相关和无关知识。改动前保存基线报告，改动后在相同语料上运行候选版本并比较指标和逐条差异。

优点是确定、可重复、可以在本地和 CI 使用；缺点是需要维护人工标注，知识正文变化后必须重新审核。

结论：采用，作为首期唯一效果门禁。

### 5.3 在线影子流量评测

记录日常任务和用户反馈，在线比较两个检索器。它能覆盖真实分布，但需要长期采集、隐私治理、稳定版本路由和人工反馈闭环，当前团队规模与工具成熟度不需要先承担这些复杂度。

结论：暂不采用；离线评测稳定后再讨论。

## 6. 公私仓职责

### 6.1 `agent-knowledge-hook`

保存：

- 评测套件 schema 校验。
- 语料指纹计算。
- 指标计算和基线比较。
- 文本与 JSON 报告格式化。
- 脱敏合成评测语料和自动化测试。
- CLI 命令契约和使用文档。

不得保存：

- 真实业务任务描述。
- 私有知识正文、路径之外的业务数据快照。
- 真实查询的人工相关性标注和报告。

### 6.2 `team-agent-knowledge`

建议新增不参与知识检索的目录：

```text
evaluation/
├── retrieval-suite.json
├── baselines/
│   └── baseline-20260716-cc0026f.json
└── results/
    └── candidate-20260716-next.json
```

`collectMarkdownFiles` 仍只扫描 `knowledge/` 和 `inbox/`，因此 `evaluation/` 不进入普通检索、必读列表或待确认清单。

`baselines/` 中经审核的基线报告提交到私有仓，`results/` 加入私有仓 `.gitignore`，只保存本地临时候选报告，避免候选结果长期堆积或被误当成已接受基线。

## 7. 评测语料固定

### 7.1 显式语料清单

评测套件不隐式使用知识库中的所有文件，而是保存参与评测的相对路径和 SHA-256：

```json
{
  "corpus": [
    {
      "path": "knowledge/domain/project-reasearch-hub.md",
      "sha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    },
    {
      "path": "knowledge/rules/example.md",
      "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    }
  ]
}
```

运行前必须验证文件存在、是知识库内普通 Markdown、真实路径未越界且摘要一致。任何文件缺失或摘要变化都视为语料漂移，评测失败并要求人工重新审核标注；不得静默刷新摘要。

### 7.2 隔离运行

评测器把清单中的文件复制到临时知识根并保留相对路径，再对临时根调用正式 `searchKnowledge`。这样可以避免未纳入标注的新文件、易变 `inbox/` 或本地临时文件影响排序，同时不会修改源知识库。

需要评估待确认材料干扰时，应把选定的 `inbox/` 文件显式加入语料清单和人工标注，而不是直接扫描实时 `inbox/`。

## 8. 查询与标注模型

### 8.1 查询分类

真实评测集首期建议包含 30～50 条任务，至少覆盖：

- `exact-symbol`：方法、类、表、字段或接口路径。
- `natural-chinese`：连续中文任务描述。
- `mixed-language`：中英文、代码标识混合。
- `synonym`：别名、历史名称、中英文同义词。
- `symptom-only`：只有业务现象，没有代码锚点。
- `cross-project`：需要多个项目知识。
- `ambiguous`：通用或可能有多种解释的查询。
- `negative`：知识库没有答案或所有文件都不应成为必读。

负例和弱相关查询合计不得少于查询总数的三分之一，否则必读精确率容易被高估。

### 8.2 三级相关性

每条查询必须把评测语料中的每个文件恰好标为一种：

- `required`：开始该任务前必须阅读；相关性等级 2。
- `related`：可以作为线索，但不应进入必读；相关性等级 1。
- `irrelevant`：不应影响分析；相关性等级 0。

这是穷尽式标注。评测器必须拒绝文件漏标、重复标注和标注未出现在语料清单中的情况，避免把“尚未标注”误当成“不相关”。

对于危害特别大的误报，可以把 `irrelevant` 中的文件同时列入 `criticalIrrelevant`；候选版本一旦把它判为必读，直接视为门禁失败。

### 8.3 章节标注

`required` 和 `related` 条目允许带可选 `heading`。当前文件级检索忽略它；未来结果返回章节后，评测器自动计算章节命中率。没有章节字段的查询不进入章节指标分母。

### 8.4 示例

```json
{
  "version": 1,
  "name": "team-agent-knowledge-retrieval",
  "corpus": [
    {
      "path": "knowledge/domain/project-reasearch-hub.md",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    },
    {
      "path": "knowledge/service-map/workspace-projects.md",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    },
    {
      "path": "knowledge/domain/project-poseidon.md",
      "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    }
  ],
  "queries": [
    {
      "id": "graph-chapter-owner-null",
      "category": "mixed-language",
      "query": "queryChapterPtGraph 返回的 chapterId 为空",
      "required": [
        {
          "path": "knowledge/domain/project-reasearch-hub.md",
          "heading": "图谱与章节入口"
        }
      ],
      "related": [
        {
          "path": "knowledge/service-map/workspace-projects.md"
        }
      ],
      "irrelevant": [
        "knowledge/domain/project-poseidon.md"
      ],
      "criticalIrrelevant": []
    }
  ]
}
```

## 9. 评测命令

新增一个一等 CLI 命令，名称为 `eval-retrieval`：

```powershell
node agent-knowledge/bin/agent-knowledge.js eval-retrieval `
  --suite C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json `
  --knowledge-root C:\idea_workspace_tob\team-agent-knowledge `
  --output C:\idea_workspace_tob\team-agent-knowledge\evaluation\results\candidate.json
```

与基线比较：

```powershell
node agent-knowledge/bin/agent-knowledge.js eval-retrieval `
  --suite C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json `
  --knowledge-root C:\idea_workspace_tob\team-agent-knowledge `
  --baseline C:\idea_workspace_tob\team-agent-knowledge\evaluation\baselines\baseline.json `
  --output C:\idea_workspace_tob\team-agent-knowledge\evaluation\results\candidate.json
```

选项：

- `--suite`：必填，评测套件 JSON。
- `--knowledge-root`：必填，私有知识库根目录。
- `--output`：可选；未提供时只输出文本摘要，不写报告。
- `--baseline`：可选；提供后执行指标和查询级差异比较。
- `--repeat`：可选，默认 3；用于检查确定性和采集多次引擎耗时，不包含 Node 进程冷启动时间。
- `--json`：可选，向标准输出写完整机读报告；未提供时标准输出只写简洁文本摘要，逐查询明细仅进入显式 `--output` 文件。

命令加入 `command-contract.json`，并同步 PowerShell 包装器、帮助文本、README、适配器和命令契约测试。评测命令只读知识源；只有显式 `--output` 才允许写报告。

## 10. 指标定义

### 10.1 必读精确率

使用全套查询的微平均：

```text
所有查询中被正确判为必读的 required 数量
÷ 所有查询返回的必读结果数量
```

`related` 被判为必读也属于误报。分母为零时不伪造满分，同时报告 `mustReadReturned = 0`，由召回指标判断是否完全未召回。

### 10.2 必读召回率

```text
所有查询中成功判为必读的 required 数量
÷ 所有查询标注的 required 数量
```

没有 `required` 的负例不进入召回分母，但单独进入负例误报指标。

### 10.3 Required Recall@5

对存在 `required` 的查询，计算前五个结果覆盖了多少必读文件，再做宏平均。它用于发现正确知识虽然被召回、但排序过低的问题。

### 10.4 MRR

每条查询取第一个 `required` 结果的排名倒数；未出现记 0，再对存在 `required` 的查询做平均。

### 10.5 nDCG@5

`required = 2`、`related = 1`、`irrelevant = 0`，按前五名计算折损累计增益并用理想排序归一化。该指标评价必读和相关知识的整体排序，不参与替代必读精确率。

### 10.6 负例误报

报告：

- 没有 `required` 的查询中，返回至少一个必读结果的查询数量和比例。
- `criticalIrrelevant` 被判为必读的总次数和具体查询。
- `irrelevant` 进入 Top 1 和 Top 5 的次数。

### 10.7 章节命中率

未来结果提供 `heading` 时，计算 Top 1 文件和章节同时等于标注目标的查询比例。首期结果没有章节字段时显示 `not_applicable`，不以 0 分处理。

### 10.8 确定性

`--repeat > 1` 时，同一查询每次返回的路径顺序、必读判定和原因必须一致。耗时允许变化，结果字段变化视为确定性失败。

### 10.9 延迟

记录每次 `searchKnowledge` 调用耗时，报告 `p50`、`p95` 和最大值。该指标不包含 Node 冷启动、套件读取、临时语料复制和报告写入，以免把检索器之外的噪声混入算法比较。

首期不估算 Token 或阅读字符数，因为当前检索器只返回摘要、尚没有统一的渐进阅读执行器。章节读取实现后，再通过明确的读取事件增加成本指标，不从文件大小推测。

## 11. 基线兼容与比较

每份报告必须包含：

- 工具 Git commit；工作树脏时同时记录 `dirty: true`。
- 套件文件 SHA-256。
- 按路径和内容摘要生成的语料指纹。
- Node 版本和操作系统。
- 查询数量、分类分布和语料文件数量。
- 汇总指标和逐查询结果。

候选报告与基线比较前，以下字段必须完全一致：

- 评测套件版本和套件摘要。
- 语料指纹。
- 查询 ID 集合。
- 指标版本。

不一致时拒绝比较，提示先在相同语料上重新生成基线；不得通过自动忽略漂移继续出具“提升”结论。

只有 `dirty: false` 的工具版本才能生成或提升为正式基线；候选版本允许工作树为脏，以支持开发过程中反复评测。Node 主版本、操作系统或 CPU 架构不一致时仍可比较检索质量，但延迟只作为提示，不执行性能门禁。

## 12. 门禁规则

首期采用相对基线门禁：

- `criticalIrrelevant` 必读次数必须为 0。
- 必读精确率不得下降。
- 必读召回率不得下降。
- Required Recall@5 不得下降。
- 负例中出现必读结果的查询数量不得增加。
- 不允许新增“某条查询的全部 required 都掉出 Top 5”的回归。
- MRR 和 nDCG@5 单项下降超过 `0.02` 时失败；小于等于 `0.02` 的下降仍需在报告中列出并人工审核。
- 在相同 Node 主版本、操作系统和 CPU 架构下，`p95` 引擎延迟不得增加超过 20%。
- 默认三次重复运行不允许任何确定性差异。

`95%` 必读精确率作为演进目标展示，但在基线尚未达到时不作为阻断所有增量改进的绝对门禁。任何基线更新必须先通过相对门禁和查询级人工审核。

## 13. 查询级差异报告

除汇总指标外，比较报告必须分别列出：

- 新增的正确必读。
- 新增的错误必读。
- 丢失的必读。
- 新进入 Top 5 的 required/related。
- 掉出 Top 5 的 required。
- Top 1 文件变化。
- `mustReadReason`、命中位置和命中词变化。
- 排名变化最大的查询。
- 延迟退化最大的查询。

文本报告先给结论和门禁状态，再给回归项，最后给提升项；不能只展示平均分提升而隐藏任一必读漏召回。

## 14. 受控实验流程

每次实验只修改一个主要因素：

1. 在改动前的工具提交上生成基线报告。
2. 保持套件和语料指纹不变。
3. 只实现一个实验变量，例如 `aliases/symbols`、章节切分或新中文分词。
4. 运行候选报告并与基线比较。
5. 人工审核所有新增错误必读、丢失必读和 Top 1 变化。
6. 通过后才能把候选报告提升为新基线。

不得把分词、元数据加权、章节切分和链接扩展合并成同一个无法归因的实验。后续组合实验应建立在各单项已经通过评测的基础上。

知识正文或标注变化后，旧基线自动失效。重新基线前必须审核变化是否改变了原查询的正确答案，而不是仅刷新哈希。

## 15. 错误处理与安全

- 套件文件必须是普通 JSON 文件，UTF-8 解码失败、BOM、非法 JSON、未知顶层字段或 schema 不匹配均明确失败。
- 查询 ID 必须唯一且稳定；查询文本不能为空。
- 语料和标注路径必须使用知识库相对 POSIX 路径，拒绝绝对路径、`..`、符号链接、目录链接逃逸和非 Markdown 文件。
- 临时隔离根创建失败时不运行任何查询；运行完成或失败后尽力清理本次临时目录。
- 需要写报告时必须显式提供 `--output`，且父目录必须已经存在；未提供时只输出摘要，不得猜测、自动创建或回退写入源知识目录。
- 报告写入采用同目录临时文件加原子替换，避免留下半写 JSON。
- 门禁失败与命令执行失败使用不同退出码，方便 CI 区分“效果退化”和“工具异常”。

## 16. 自动化测试

通用工具仓使用完全脱敏的合成语料覆盖：

- 合法套件、负例、多个 required 和三级相关性。
- 文件漏标、重复标注、路径不存在、摘要漂移和非法路径。
- 必读精确率、召回率、Recall@5、MRR、nDCG@5 和负例误报的手算夹具。
- 基线与候选套件摘要或语料指纹不一致时拒绝比较。
- 查询级新增误报、漏召回和排名变化报告。
- 多次运行结果一致性校验。
- 输出报告原子写入和失败时不污染源知识库。
- CLI 参数、命令契约、帮助文本和 PowerShell 包装器同步。
- 所有新增或修改文件保持 UTF-8 无 BOM。

真实私有评测套件不进入公开 CI。私有仓可在本地或私有 CI 调用公开评测器执行门禁。

## 17. 验收标准

- 能在不修改源知识库的前提下，对固定语料运行完整查询集并生成 JSON 报告。
- 同一工具版本、套件和语料重复运行得到一致排序与判定。
- 能拒绝语料漂移、标注不完整和不可比较的基线。
- 能同时报告汇总指标和所有查询级回归，且门禁失败返回明确退出码。
- 通用工具仓不包含任何真实业务查询、私有知识正文或真实评测报告。
- 在评测框架通过自身测试并生成当前版本基线之前，不开始修改正式检索算法。

## 18. 首期最小实现范围

设计评审后决定先验证评测方法本身，不一次实现第 7～16 节描述的完整目标形态。本节定义首期范围，并在首期实现中优先于前述目标形态：

- 不增加 `agent-knowledge` 正式命令、`ak.ps1` 短命令或 `command-contract.json` 条目；通过 `npm run eval:retrieval -- <参数>` 调用独立脚本。
- 私有套件只保存查询 ID、分类、查询文本、`required` 和可选 `related` 路径，不手工维护穷尽式 `irrelevant` 标注和逐文件 SHA-256。
- 运行时自动计算套件摘要和当前 `knowledge/`、`inbox/` Markdown 语料指纹。候选报告只有在两个摘要都与基线一致时才允许比较；首期不复制隔离语料。
- 首期只计算必读精确率、Required Recall@5、错误必读数量和 Top 1 命中率四个指标。
- 首期比较门禁只要求四个指标均不退化，并输出新增错误必读、掉出 Top 5 的 required 和 Top 1 变化。
- 不实现 MRR、nDCG、章节命中、重复运行确定性、延迟门禁、语料隔离复制和正式基线晋升流程。
- 通用工具仓提供脱敏套件模板和合成语料单测；真实查询套件仍由私有 `team-agent-knowledge/evaluation/` 保存并人工审核。

首期评测器验证有价值后，再以独立改动逐项扩展目标形态；不得为了复用未来能力提前实现未进入首期的抽象或配置。
