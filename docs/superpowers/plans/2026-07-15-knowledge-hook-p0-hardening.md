# Knowledge Hook P0 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 收紧知识库命令输入与文件路径边界，并把 `before-task` 的必读判断升级为去重、可解释、低误报的词组模型。

**Architecture:** 保留当前单文件 CLI 路由，通过三个局部 helper 闭环实现：命令调用 schema 校验、知识 Markdown 真实路径解析、查询词组构建与统一必读分类。所有行为先由真实 CLI/API 测试锁定，再写最小实现。

**Tech Stack:** Node.js ESM、Node 内置 test runner、PowerShell 5.1、Git

## Global Constraints

- 所有文本按 UTF-8 无 BOM 写入。
- 保持零第三方运行时依赖。
- 不修改 `team-agent-knowledge`、纠偏生命周期、PowerShell 短命令架构和持久化索引。
- 不删除或改写本次范围外的注释。
- 不自动提交或推送。

---

### Task 1：严格 CLI 调用校验

**Files:**

- Modify: `agent-knowledge/tests/agent-knowledge.test.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`

**Interfaces:**

- Produces: `validateGlobalOptions(command, globalOptions)`；严格版 `parseOptions(args, schema)`。

- [ ] **Step 1：写入失败测试**

增加 CLI 用例：`record-fix --targte`、重复 `--target`、`record-fix --json`、`promote` 多余位置参数、`refresh-project` 重复 `--knowledge-file`、`list-pending --unknown`。每个用例断言非零退出并且知识库没有新增目录。

- [ ] **Step 2：运行 RED**

Run:

```powershell
node --test --test-name-pattern="strict CLI" tests/agent-knowledge.test.js
```

Expected: 至少一个用例 FAIL，因为当前解析器忽略未知或重复参数。

- [ ] **Step 3：写最小实现**

增加命令级 schema：

```js
const COMMAND_OPTION_SCHEMAS = {
  'record-fix': { value: ['type', 'target'], multiValue: ['title'] },
  'check-stale': { value: ['project-root', 'knowledge-file'], flags: ['deep'] },
  'refresh-project': { value: ['project-root', 'knowledge-file'], multiValue: ['summary'] },
  promote: { value: ['file'] },
};
```

解析时统一记录 seen option；未知、重复、缺值和位置参数立即抛错。全局校验按设计文档允许矩阵拒绝不支持或重复的全局选项。

- [ ] **Step 4：运行 GREEN 与相邻命令测试**

Run:

```powershell
node --test --test-name-pattern="strict CLI|CLI record-fix|CLI promote|CLI list-pending|CLI check-stale|CLI refresh-project" tests/agent-knowledge.test.js
```

Expected: 相关测试全部 PASS。

### Task 2：知识 Markdown 路径闭环

**Files:**

- Modify: `agent-knowledge/tests/agent-knowledge.test.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`

**Interfaces:**

- Produces: `resolveKnowledgeMarkdownFile(baseDir, file, { tree, command })`，返回 `{ filePath, realFilePath, relativePath }`。
- Consumes: `checkStale`、`refreshProject`、`promote`。

- [ ] **Step 1：写入失败测试**

API 用例覆盖：知识库外绝对路径、通过目录链接逃逸、文件符号链接、`inbox/` 文件传给 check/refresh、非 confirmed 知识；另保留合法绝对路径位于知识库内的成功用例。平台不支持文件链接时只跳过对应链接用例。

- [ ] **Step 2：运行 RED**

Run:

```powershell
node --test --test-name-pattern="knowledge path boundary" tests/agent-knowledge.test.js
```

Expected: 越界或状态错误用例 FAIL，因为当前函数会读取或修改目标。

- [ ] **Step 3：写最小实现**

实现词法包含、`.md`、`lstat` 普通文件、文件链接拒绝、真实根包含和顶层目录校验。check/refresh 在读取后校验 `status: confirmed`；promote 在读取前要求 `inbox/`。

- [ ] **Step 4：运行 GREEN 与生命周期相邻测试**

Run:

```powershell
node --test --test-name-pattern="knowledge path boundary|check-stale|refreshProject|promote" tests/agent-knowledge.test.js
```

Expected: 相关测试全部 PASS。

### Task 3：查询词组与 mustRead v2

**Files:**

- Modify: `agent-knowledge/tests/agent-knowledge.test.js`
- Modify: `agent-knowledge/bin/agent-knowledge.js`

**Interfaces:**

- Produces: `buildQueryModel(query)`；`classifyMustRead(result)`。
- Updates: `searchKnowledge` 结果新增 `mustRead`、`mustReadReason`、`matchedTerms`、`reasonCodes`。

- [ ] **Step 1：写入词组与误报失败测试**

覆盖：`queue/Queue` 和 `Graph/graph` 只形成一个同义词组；一个别名命中使该词组覆盖率为 1；正文低覆盖结果不是必读；高覆盖标题/frontmatter 结果是必读；超过 5 个候选只保留前 5 个；真实任务风格查询不会把弱业务文档判为必读。

- [ ] **Step 2：运行 RED**

Run:

```powershell
node --test --test-name-pattern="query groups|mustRead v2" tests/agent-knowledge.test.js
```

Expected: 当前重复关键词或 `score >= 8` 行为导致断言 FAIL。

- [ ] **Step 3：写最小实现**

同义词加载时按半角、NFKC、小写归一；查询候选按等价组去重。评分逐组逐字段最多计一次，记录实际命中词和原因。排序完成后统一分类并应用 5 条上限。

- [ ] **Step 4：更新 JSON 与文本输出**

`resultToJson` 返回 `queryTerms`、`expandedTerms`、`matchedTerms`、`reasonCodes`、`mustReadReason`；原 `keywords` 指向真实扩展词。`formatBeforeTaskOutput` 只读取 `result.mustRead`。

- [ ] **Step 5：运行 GREEN 和全部检索测试**

Run:

```powershell
node --test --test-name-pattern="extractKeywords|extractQueryKeywords|searchKnowledge|before-task|mustRead|query groups" tests/agent-knowledge.test.js
```

Expected: 相关测试全部 PASS。

### Task 4：文档与完整验证

**Files:**

- Modify: `README.md`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/help/ak.zh-CN.txt`

- [ ] **Step 1：更新行为说明**

说明严格参数拒绝策略、词组覆盖率、必读高置信条件、5 条上限和新增 JSON 字段；不改命令契约生成区块。

- [ ] **Step 2：运行全量验证**

Run:

```powershell
npm.cmd test
node bin/agent-knowledge.js sync-command-docs --check --repository-root ..
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
node bin/agent-knowledge.js doctor --json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --repository-root ..
```

Expected: 测试 0 失败；命令文档、适配器和 doctor 全部通过。

- [ ] **Step 3：运行示例任务回归**

Run:

```powershell
node bin/agent-knowledge.js before-task "查询章节图谱聚合接口数据源不一致" --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --json
node bin/agent-knowledge.js before-task "优化知识库钩子检索性能" --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --json
```

Expected: 第一条不再出现 7 个必读；第二条不再把弱业务正文命中判为必读；JSON 包含完整解释字段。

- [ ] **Step 4：编码和变更范围检查**

检查所有新增/修改文本首字节不是 `EF BB BF`，`git diff --check` 无错误，`git status --short` 只包含本计划文件。
