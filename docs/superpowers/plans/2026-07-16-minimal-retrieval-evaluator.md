# Minimal Retrieval Evaluator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-dependency, standalone evaluator that runs labeled Markdown knowledge queries, calculates four retrieval metrics, and compares a candidate report with a compatible baseline without changing the production retrieval algorithm or formal CLI contract.

**Architecture:** Add a focused `retrieval-evaluation.js` library beside the existing retriever, plus a standalone `scripts/evaluate-retrieval.js` entry invoked through npm. The library owns suite validation, corpus fingerprinting, evaluation, four metrics, baseline comparison, and atomic report writes; the script only parses arguments and formats a concise summary.

**Tech Stack:** Node.js ES modules, built-in `node:test`, `node:assert`, `node:crypto`, `node:fs/promises`, existing `searchKnowledge`, `collectMarkdownFiles`, and `writeFileAtomic` helpers; no new npm dependencies.

## Global Constraints

- Team knowledge contains Markdown only; do not add PDF, Excel, OCR, vector, database, or Obsidian integration.
- Do not modify `retrieval.js` scoring, tokenization, sorting, or must-read classification in this plan.
- Do not add a formal `agent-knowledge` command, `ak.ps1` command, or `command-contract.json` entry.
- Public fixtures and templates must be synthetic; real queries and labels stay under `C:\idea_workspace_tob\team-agent-knowledge\evaluation\`.
- Read and write every text file as UTF-8 without BOM.
- Keep the implementation zero-dependency and deterministic for the same suite and knowledge bytes.
- Required Recall@5 means the proportion of labeled `required` paths that are present in the at-most-five results classified as `mustRead`, not merely anywhere in the first five ordinary results.
- Each task uses TDD and ends with a focused Chinese Git commit.

---

## File Structure

- Create `agent-knowledge/lib/retrieval-evaluation.js`: suite validation, hashing, evaluation, metrics, report comparison, report persistence.
- Create `agent-knowledge/tests/retrieval-evaluation.test.js`: unit and integration coverage for the evaluation library and standalone script.
- Create `agent-knowledge/scripts/evaluate-retrieval.js`: strict standalone argument parsing, orchestration, exit codes, concise text output.
- Create `agent-knowledge/templates/retrieval-suite.json`: public synthetic suite shape that can be copied into the private knowledge repository.
- Modify `agent-knowledge/package.json`: add only the `eval:retrieval` npm script.
- Modify `agent-knowledge/README.md`: document the minimal evaluator, metric definitions, baseline workflow, and private-data boundary.
- Modify `docs/superpowers/specs/2026-07-16-retrieval-evaluation-design.md`: already updated before this plan to record the approved minimal first phase.

### Public library interfaces

```js
validateEvaluationSuite(value) -> {
  version: 1,
  name: string,
  queries: Array<{
    id: string,
    category: string,
    query: string,
    required: string[],
    related: string[],
  }>,
}

loadEvaluationSuite(filePath) -> Promise<{
  suite: ValidatedSuite,
  suiteHash: string,
}>

runRetrievalEvaluation({ suite, suiteHash, knowledgeRoot, search })
  -> Promise<EvaluationReport>

compareEvaluationReports(baseline, candidate) -> {
  passed: boolean,
  metricDeltas: object,
  regressions: Array<{ metric: string, baseline: number | null, candidate: number | null }>,
  queryChanges: Array<object>,
}

writeEvaluationReport(filePath, report) -> Promise<void>
```

---

### Task 1: Suite validation and four core metrics

**Files:**
- Create: `agent-knowledge/lib/retrieval-evaluation.js`
- Create: `agent-knowledge/tests/retrieval-evaluation.test.js`

**Interfaces:**
- Consumes: no new project interfaces.
- Produces: `validateEvaluationSuite(value)` and `calculateEvaluationMetrics(queryEvaluations)` for later tasks.

- [ ] **Step 1: Write failing suite-validation tests**

Add tests that accept one positive and one negative query, normalize missing `related` to `[]`, and reject duplicate IDs, empty queries, overlapping labels, absolute paths, `..`, backslashes, and non-Markdown labels:

```js
test('validateEvaluationSuite accepts minimal positive and negative queries', () => {
  const suite = validateEvaluationSuite({
    version: 1,
    name: 'synthetic retrieval',
    queries: [
      {
        id: 'graph',
        category: 'exact-symbol',
        query: 'queryGraph ownerId',
        required: ['knowledge/domain/graph.md'],
        related: ['knowledge/service-map/projects.md'],
      },
      {
        id: 'negative',
        category: 'negative',
        query: 'weather tomorrow',
        required: [],
      },
    ],
  });

  assert.deepEqual(suite.queries[1].related, []);
});

test('validateEvaluationSuite rejects unsafe and ambiguous labels', () => {
  for (const invalidPath of [
    'C:/private.md',
    '../knowledge/private.md',
    'knowledge\\private.md',
    'knowledge/private.txt',
  ]) {
    assert.throws(() => validateEvaluationSuite({
      version: 1,
      name: 'invalid',
      queries: [{
        id: 'invalid',
        category: 'negative',
        query: 'invalid path',
        required: [invalidPath],
      }],
    }), /(knowledge|inbox)\/.*\.md/);
  }
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```powershell
node --test tests/retrieval-evaluation.test.js
```

Working directory: `C:\tmp\ak-eval\agent-knowledge`

Expected: FAIL because `../lib/retrieval-evaluation.js` does not exist.

- [ ] **Step 3: Implement strict suite validation**

Implement these exact validation rules:

```js
const LABEL_PATH_PATTERN = /^(knowledge|inbox)\/[A-Za-z0-9._\-/\p{Script=Han}]+\.md$/u;

export function validateEvaluationSuite(value) {
  assertPlainObject(value, 'suite');
  assertExactKeys(value, ['version', 'name', 'queries'], 'suite');
  if (value.version !== 1) {
    throw new Error('评测套件 version 必须为 1');
  }
  assertNonEmptyString(value.name, '评测套件 name');
  if (!Array.isArray(value.queries) || value.queries.length === 0) {
    throw new Error('评测套件 queries 必须是非空数组');
  }

  const ids = new Set();
  const queries = value.queries.map((query, index) => {
    assertPlainObject(query, `queries[${index}]`);
    assertAllowedKeys(
      query,
      ['id', 'category', 'query', 'required', 'related'],
      `queries[${index}]`,
    );
    for (const field of ['id', 'category', 'query']) {
      assertNonEmptyString(query[field], `queries[${index}].${field}`);
    }
    if (ids.has(query.id)) {
      throw new Error(`评测查询 id 重复: ${query.id}`);
    }
    ids.add(query.id);

    const required = validateLabelPaths(query.required, `queries[${index}].required`);
    const related = validateLabelPaths(query.related ?? [], `queries[${index}].related`);
    const overlap = required.find((file) => related.includes(file));
    if (overlap) {
      throw new Error(`同一路径不能同时标为 required 和 related: ${overlap}`);
    }
    return {
      id: query.id.trim(),
      category: query.category.trim(),
      query: query.query.trim(),
      required,
      related,
    };
  });

  return { version: 1, name: value.name.trim(), queries };
}
```

Helper functions must reject arrays as objects, reject unknown fields, reject duplicate label paths, and require label paths to use POSIX separators under `knowledge/` or `inbox/` with a lowercase `.md` suffix.

- [ ] **Step 4: Write failing metric tests with hand-calculated expectations**

Use three query evaluations:

```js
test('calculateEvaluationMetrics computes the four agreed metrics', () => {
  const metrics = calculateEvaluationMetrics([
    {
      id: 'q1',
      required: ['knowledge/a.md'],
      results: [
        { path: 'knowledge/a.md', mustRead: true },
        { path: 'knowledge/b.md', mustRead: false },
      ],
    },
    {
      id: 'q2',
      required: ['knowledge/b.md'],
      results: [
        { path: 'knowledge/a.md', mustRead: true },
        { path: 'knowledge/b.md', mustRead: false },
      ],
    },
    {
      id: 'q3',
      required: [],
      results: [{ path: 'knowledge/c.md', mustRead: true }],
    },
  ]);

  assert.deepEqual(metrics, {
    mustReadPrecision: 1 / 3,
    requiredRecallAt5: 1 / 2,
    falseMustReadCount: 2,
    top1HitRate: 1 / 2,
    mustReadReturned: 3,
    correctMustReadCount: 1,
    requiredCount: 2,
    positiveQueryCount: 2,
  });
});
```

- [ ] **Step 5: Run the metric test and confirm RED**

Run the same focused test command.

Expected: suite-validation tests PASS and metric test FAIL because `calculateEvaluationMetrics` is not exported.

- [ ] **Step 6: Implement the four metrics without changing retrieval behavior**

Implement:

```js
export function calculateEvaluationMetrics(queryEvaluations) {
  let mustReadReturned = 0;
  let correctMustReadCount = 0;
  let requiredCount = 0;
  let top1HitCount = 0;
  let positiveQueryCount = 0;

  for (const evaluation of queryEvaluations) {
    const required = new Set(evaluation.required);
    const mustReadPaths = evaluation.results
      .filter((result) => result.mustRead)
      .slice(0, 5)
      .map((result) => result.path);
    mustReadReturned += mustReadPaths.length;
    correctMustReadCount += mustReadPaths.filter((file) => required.has(file)).length;
    requiredCount += required.size;
    if (required.size > 0) {
      positiveQueryCount += 1;
      if (evaluation.results[0] && required.has(evaluation.results[0].path)) {
        top1HitCount += 1;
      }
    }
  }

  return {
    mustReadPrecision: mustReadReturned === 0 ? null : correctMustReadCount / mustReadReturned,
    requiredRecallAt5: requiredCount === 0 ? null : correctMustReadCount / requiredCount,
    falseMustReadCount: mustReadReturned - correctMustReadCount,
    top1HitRate: positiveQueryCount === 0 ? null : top1HitCount / positiveQueryCount,
    mustReadReturned,
    correctMustReadCount,
    requiredCount,
    positiveQueryCount,
  };
}
```

- [ ] **Step 7: Run focused tests and commit**

Run:

```powershell
node --test tests/retrieval-evaluation.test.js
```

Expected: all Task 1 tests PASS.

Commit:

```powershell
git add -- agent-knowledge/lib/retrieval-evaluation.js agent-knowledge/tests/retrieval-evaluation.test.js
git commit -m "实现知识检索评测核心指标"
```

---

### Task 2: Evaluation runner, fingerprints, and baseline comparison

**Files:**
- Modify: `agent-knowledge/lib/retrieval-evaluation.js`
- Modify: `agent-knowledge/tests/retrieval-evaluation.test.js`

**Interfaces:**
- Consumes: `validateEvaluationSuite`, `calculateEvaluationMetrics`, existing `searchKnowledge`, `collectMarkdownFiles`, and `writeFileAtomic`.
- Produces: `loadEvaluationSuite`, `runRetrievalEvaluation`, `compareEvaluationReports`, and `writeEvaluationReport`.

- [ ] **Step 1: Write failing load, run, and fingerprint tests**

Create a temporary knowledge root with two confirmed Markdown files and a suite file. Inject a deterministic search function so the test isolates evaluation behavior:

```js
test('runRetrievalEvaluation records labels, results, metrics, and fingerprints', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/a.md',
    '---\ntitle: A\nstatus: confirmed\n---\n\n# A\n\nalpha\n',
  );
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/b.md',
    '---\ntitle: B\nstatus: confirmed\n---\n\n# B\n\nbeta\n',
  );
  const suitePath = path.join(knowledgeRoot, 'evaluation-suite.json');
  await writeFile(suitePath, JSON.stringify({
    version: 1,
    name: 'fixture',
    queries: [{
      id: 'alpha',
      category: 'exact-symbol',
      query: 'alpha',
      required: ['knowledge/a.md'],
      related: ['knowledge/b.md'],
    }],
  }), 'utf8');

  const loaded = await loadEvaluationSuite(suitePath);
  const report = await runRetrievalEvaluation({
    ...loaded,
    knowledgeRoot,
    search: async () => [
      {
        path: 'knowledge/a.md',
        mustRead: true,
        mustReadReason: 'high_coverage_title',
        score: 10,
        matchedTerms: ['alpha'],
      },
    ],
  });

  assert.match(report.suiteHash, /^[a-f0-9]{64}$/);
  assert.match(report.knowledgeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.metrics.mustReadPrecision, 1);
  assert.deepEqual(report.queries[0].requiredMustRead, ['knowledge/a.md']);
});
```

Also assert that changing one Markdown byte changes `knowledgeFingerprint`, and that a labeled path absent from the scanned corpus is rejected before any query runs.

- [ ] **Step 2: Run focused tests and confirm RED**

Expected: FAIL because load and run functions are absent.

- [ ] **Step 3: Implement suite loading, corpus fingerprinting, and evaluation**

Use SHA-256 and sorted relative POSIX paths:

```js
export async function loadEvaluationSuite(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const suite = validateEvaluationSuite(JSON.parse(raw));
  return {
    suite,
    suiteHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
  };
}

async function inspectKnowledgeCorpus(knowledgeRoot) {
  const files = await collectMarkdownFiles(path.resolve(knowledgeRoot));
  const entries = [];
  for (const filePath of files) {
    entries.push({
      path: path.relative(knowledgeRoot, filePath).split(path.sep).join('/'),
      content: await readFile(filePath),
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path, 'utf8');
    hash.update('\0');
    hash.update(entry.content);
    hash.update('\0');
  }
  return {
    fingerprint: hash.digest('hex'),
    paths: entries.map((entry) => entry.path),
  };
}
```

`runRetrievalEvaluation` must:

1. Resolve and inspect the knowledge root.
2. Verify every `required` and `related` path exists in the inspected corpus.
3. Call the injected `search` or production `searchKnowledge` once per query.
4. Preserve only explainable result fields: `path`, `mustRead`, `mustReadReason`, `score`, `coverage`, `matchedTerms`, `reasonCodes`, and `hits`.
5. Store per-query `requiredMustRead`, `falseMustRead`, `requiredMissingFromMustRead`, and `top1Hit`.
6. Calculate metrics with Task 1's function.

- [ ] **Step 4: Write failing comparison tests**

Construct baseline and candidate reports with the same hashes. Assert comparison fails when precision, recall, false must-read count, or Top 1 regresses, and reports query-level changes:

```js
test('compareEvaluationReports rejects all four metric regressions', () => {
  function createReportFixture({ metrics }) {
    return {
      schemaVersion: 1,
      suiteName: 'fixture',
      suiteHash: 'a'.repeat(64),
      knowledgeFingerprint: 'b'.repeat(64),
      metrics,
      queries: [{
        id: 'q1',
        required: ['knowledge/a.md'],
        requiredMustRead: [],
        falseMustRead: [],
        results: [],
      }],
    };
  }

  const baseline = createReportFixture({
    metrics: {
      mustReadPrecision: 1,
      requiredRecallAt5: 1,
      falseMustReadCount: 0,
      top1HitRate: 1,
    },
  });
  const candidate = createReportFixture({
    metrics: {
      mustReadPrecision: 0.5,
      requiredRecallAt5: 0,
      falseMustReadCount: 1,
      top1HitRate: 0,
    },
  });

  const comparison = compareEvaluationReports(baseline, candidate);
  assert.equal(comparison.passed, false);
  assert.deepEqual(
    comparison.regressions.map((item) => item.metric),
    ['mustReadPrecision', 'requiredRecallAt5', 'falseMustReadCount', 'top1HitRate'],
  );
});
```

Add separate tests rejecting different `suiteHash`, `knowledgeFingerprint`, query IDs, and report schema versions.

- [ ] **Step 5: Implement comparison and atomic report output**

Comparison rules:

```js
const METRIC_RULES = [
  { name: 'mustReadPrecision', direction: 'higher' },
  { name: 'requiredRecallAt5', direction: 'higher' },
  { name: 'falseMustReadCount', direction: 'lower' },
  { name: 'top1HitRate', direction: 'higher' },
];
```

Treat `null` rate values as zero only for regression comparison, preserve `null` in reports, and compute numeric deltas as `candidate - baseline`. Reject comparison unless `schemaVersion`, `suiteHash`, `knowledgeFingerprint`, and ordered query IDs match exactly.

For each query, report:

```js
{
  id,
  newFalseMustRead,
  lostRequiredMustRead,
  baselineTop1,
  candidateTop1,
}
```

Only include query changes with at least one non-empty difference.

Write reports with existing atomic helper:

```js
export async function writeEvaluationReport(filePath, report) {
  await writeFileAtomic(
    path.resolve(filePath),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
```

- [ ] **Step 6: Run focused tests and commit**

Run:

```powershell
node --test tests/retrieval-evaluation.test.js
```

Expected: all Task 1 and Task 2 tests PASS.

Commit:

```powershell
git add -- agent-knowledge/lib/retrieval-evaluation.js agent-knowledge/tests/retrieval-evaluation.test.js
git commit -m "增加检索评测基线比较"
```

---

### Task 3: Standalone script, public template, and usage documentation

**Files:**
- Create: `agent-knowledge/scripts/evaluate-retrieval.js`
- Create: `agent-knowledge/templates/retrieval-suite.json`
- Modify: `agent-knowledge/package.json`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/tests/retrieval-evaluation.test.js`

**Interfaces:**
- Consumes: all Task 2 public functions.
- Produces: `npm run eval:retrieval -- --suite C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json --knowledge-root C:\idea_workspace_tob\team-agent-knowledge --baseline C:\idea_workspace_tob\team-agent-knowledge\evaluation\baselines\current.json --output C:\idea_workspace_tob\team-agent-knowledge\evaluation\results\candidate.json`.

- [ ] **Step 1: Write failing process-level script tests**

Use `execFileAsync` with `process.execPath` and the script path. Cover:

- Missing required `--suite` or `--knowledge-root` returns exit code 1 and a readable usage error.
- Unknown, duplicate, or missing-value options return exit code 1 before writing output.
- A valid run writes a parseable UTF-8 no-BOM report when `--output` is present.
- A compatible non-regressing baseline returns exit code 0.
- A compatible regressing baseline returns exit code 2 and still writes the candidate report with its `comparison` object.
- An incompatible baseline returns exit code 1 and does not replace an existing output file.

Define the script path once at the top of the test file:

```js
const testDir = path.dirname(fileURLToPath(import.meta.url));
const evaluationScriptPath = path.resolve(
  testDir,
  '..',
  'scripts',
  'evaluate-retrieval.js',
);
```

Expected script invocation:

```js
await execFileAsync(process.execPath, [
  evaluationScriptPath,
  '--suite', suitePath,
  '--knowledge-root', knowledgeRoot,
  '--output', outputPath,
]);
```

- [ ] **Step 2: Run the process-level tests and confirm RED**

Expected: FAIL because the script file does not exist.

- [ ] **Step 3: Implement strict standalone argument parsing and exit codes**

The script accepts only four single-value options:

```text
--suite
--knowledge-root
--baseline
--output
```

Do not accept positional arguments, duplicate options, `--name=value`, or unknown flags. Require `--suite` and `--knowledge-root`. Parse arguments before reading or writing any file.

Implement argument parsing with an explicit map:

```js
function parseOptions(args) {
  const allowed = new Set(['--suite', '--knowledge-root', '--baseline', '--output']);
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (!allowed.has(option)) {
      throw new Error(`未知评测参数: ${option}`);
    }
    const key = option.slice(2).replaceAll('-', '_');
    if (Object.hasOwn(options, key)) {
      throw new Error(`评测参数不能重复: ${option}`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`评测参数缺少值: ${option}`);
    }
    options[key] = value;
    index += 1;
  }
  if (!options.suite || !options.knowledge_root) {
    throw new Error('用法: --suite <套件JSON> --knowledge-root <知识库目录> [--baseline <基线JSON>] [--output <报告JSON>]');
  }
  return options;
}

function formatRate(value) {
  return value === null ? 'N/A' : `${(value * 100).toFixed(2)}%`;
}

function formatEvaluationSummary(report, outputPath = '') {
  const lines = [
    `评测套件：${report.suiteName}`,
    `查询数量：${report.queries.length}`,
    `必读精确率：${formatRate(report.metrics.mustReadPrecision)}`,
    `Required Recall@5：${formatRate(report.metrics.requiredRecallAt5)}`,
    `错误必读：${report.metrics.falseMustReadCount}`,
    `Top 1 命中率：${formatRate(report.metrics.top1HitRate)}`,
  ];
  if (outputPath) {
    lines.push(`报告：${path.resolve(outputPath)}`);
  }
  if (report.comparison) {
    lines.push(`基线比较：${report.comparison.passed ? '通过' : '退化'}`);
  }
  return lines.join('\n');
}
```

Execution flow:

```js
const loadedSuite = await loadEvaluationSuite(options.suite);
let report = await runRetrievalEvaluation({
  ...loadedSuite,
  knowledgeRoot: options.knowledgeRoot,
});
if (options.baseline) {
  const baseline = JSON.parse(await readFile(options.baseline, 'utf8'));
  report = {
    ...report,
    comparison: compareEvaluationReports(baseline, report),
  };
}
if (options.output) {
  await writeEvaluationReport(options.output, report);
}
console.log(formatEvaluationSummary(report));
process.exitCode = report.comparison && !report.comparison.passed ? 2 : 0;
```

Errors print only `error.message` to stderr and set exit code 1. The summary prints suite name, query count, the four metrics, report path when present, and baseline status when compared.

- [ ] **Step 4: Add the npm script and synthetic template**

Modify `package.json` scripts exactly to retain the existing test command and add:

```json
{
  "scripts": {
    "test": "node --test tests/*.test.js",
    "eval:retrieval": "node scripts/evaluate-retrieval.js"
  }
}
```

Create a valid public template using only synthetic names:

```json
{
  "version": 1,
  "name": "example-retrieval-suite",
  "queries": [
    {
      "id": "graph-owner-empty",
      "category": "mixed-language",
      "query": "queryGraph ownerId 为空",
      "required": [
        "knowledge/domain/example-graph.md"
      ],
      "related": [
        "knowledge/service-map/example-projects.md"
      ]
    },
    {
      "id": "negative-weather",
      "category": "negative",
      "query": "明天的天气",
      "required": [],
      "related": []
    }
  ]
}
```

- [ ] **Step 5: Document the minimal baseline workflow**

Add a README section after the existing `search` documentation containing:

```powershell
npm run eval:retrieval -- `
  --suite C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json `
  --knowledge-root C:\idea_workspace_tob\team-agent-knowledge `
  --output C:\idea_workspace_tob\team-agent-knowledge\evaluation\baselines\current.json
```

Document:

- The suite and knowledge bytes must stay unchanged between baseline and candidate.
- Any `mustRead` not labeled `required` counts as a false must-read, including `related`.
- Required Recall@5 uses the at-most-five `mustRead` results.
- Exit codes are 0 for success/pass, 1 for invalid input or incompatible reports, and 2 for a compatible regression.
- Real queries and reports belong only in the private knowledge repository.
- This script evaluates the current retriever; it does not modify knowledge or retrieval behavior.

- [ ] **Step 6: Run focused and full tests**

Run:

```powershell
node --test tests/retrieval-evaluation.test.js
npm.cmd test
```

Expected: focused tests PASS; full suite reports 0 failures, with only platform capability skips allowed.

- [ ] **Step 7: Verify docs, encoding, and commit**

Run:

```powershell
git diff --check
```

Verify the first three bytes of every new or modified text file are not `EF BB BF`.

Commit:

```powershell
git add -- agent-knowledge/scripts/evaluate-retrieval.js agent-knowledge/tests/retrieval-evaluation.test.js agent-knowledge/templates/retrieval-suite.json agent-knowledge/package.json agent-knowledge/README.md
git commit -m "提供最小知识检索评测器"
```

---

### Task 4: Private draft suite and current-version report

**Files:**
- Create: `C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json`
- Create: `C:\idea_workspace_tob\team-agent-knowledge\evaluation\results\current.json`

**Interfaces:**
- Consumes: Task 3's `npm run eval:retrieval` script and the current private Markdown knowledge.
- Produces: a draft real-query suite and current-version report for human label review; it is not promoted as a formal baseline in this task.

- [ ] **Step 1: Build the exact 15-query draft suite from current knowledge topics**

Before writing, read each path referenced under `required` or `related` and confirm the current Markdown still supports the label. Then create this exact draft; if the current file contradicts a label, stop and report the conflicting query instead of silently changing it:

```json
{
  "version": 1,
  "name": "team-agent-knowledge-draft",
  "queries": [
    {
      "id": "preview-training-queue-empty",
      "category": "natural-chinese",
      "query": "poseidon 预习题型训练队列为空",
      "required": ["knowledge/domain/project-poseidon.md"],
      "related": []
    },
    {
      "id": "chapter-graph-owner-null",
      "category": "mixed-language",
      "query": "queryChapterPtGraph chapterId 为空 章节图谱",
      "required": ["knowledge/domain/project-reasearch-hub.md"],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "new-learning-event-downstream",
      "category": "cross-project",
      "query": "新增 ToB 学习事件需要检查哪些下游数据",
      "required": ["knowledge/rules/20260713-tob.md"],
      "related": [
        "knowledge/domain/project-poseidon.md",
        "knowledge/domain/project-2b.md"
      ]
    },
    {
      "id": "pt-z-field-change",
      "category": "cross-project",
      "query": "PT-Z 值表字段类型变更要评估哪些仓库",
      "required": ["knowledge/rules/20260709-pt-z.md"],
      "related": [
        "knowledge/domain/project-poseidon.md",
        "knowledge/domain/project-jzx-server.md"
      ]
    },
    {
      "id": "legacy-jzx-default-exclusion",
      "category": "natural-chinese",
      "query": "jzx 老项目默认是否需要分析",
      "required": ["knowledge/rules/jzx-legacy-project-exclusion.md"],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "track-does-not-prove-quadrant",
      "category": "symptom-only",
      "query": "学习轨迹已经上报能否推断学生四分类有数据",
      "required": ["knowledge/rules/20260713-tob.md"],
      "related": ["knowledge/domain/project-poseidon.md"]
    },
    {
      "id": "poseidon-entry",
      "category": "exact-project",
      "query": "poseidon 项目有哪些核心模块和入口",
      "required": ["knowledge/domain/project-poseidon.md"],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "research-hub-entry",
      "category": "synonym",
      "query": "reasearch-hub 图谱服务从哪里开始分析",
      "required": ["knowledge/domain/project-reasearch-hub.md"],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "jzx-server-wrong-question-entry",
      "category": "exact-project",
      "query": "jzx-server 错题本模块入口",
      "required": ["knowledge/domain/project-jzx-server.md"],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "2b-room-entry",
      "category": "exact-project",
      "query": "2b 学习室后端和前端入口",
      "required": ["knowledge/domain/project-2b.md"],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "workspace-projects",
      "category": "natural-chinese",
      "query": "工作区有哪些核心业务项目",
      "required": ["knowledge/service-map/workspace-projects.md"],
      "related": []
    },
    {
      "id": "negative-hook-vector-index",
      "category": "negative",
      "query": "优化知识库钩子向量索引性能",
      "required": [],
      "related": ["knowledge/service-map/workspace-projects.md"]
    },
    {
      "id": "negative-weather",
      "category": "negative",
      "query": "查询明天天气和空气质量",
      "required": [],
      "related": []
    },
    {
      "id": "negative-pdf-excel",
      "category": "negative",
      "query": "如何处理 PDF 和 Excel",
      "required": [],
      "related": []
    },
    {
      "id": "negative-format-comments",
      "category": "negative",
      "query": "统一代码格式并删除旧注释",
      "required": [],
      "related": []
    }
  ]
}
```

- [ ] **Step 2: Validate the draft suite with the evaluator**

Run without `--output` first:

```powershell
npm.cmd run eval:retrieval -- `
  --suite C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json `
  --knowledge-root C:\idea_workspace_tob\team-agent-knowledge
```

Expected: exit 0 and a summary for all draft queries.

- [ ] **Step 3: Generate the current-version draft report**

Create the `evaluation\results` directory if absent, then run with `--output`:

```powershell
npm.cmd run eval:retrieval -- `
  --suite C:\idea_workspace_tob\team-agent-knowledge\evaluation\retrieval-suite.json `
  --knowledge-root C:\idea_workspace_tob\team-agent-knowledge `
  --output C:\idea_workspace_tob\team-agent-knowledge\evaluation\results\current.json
```

Expected: exit 0, parseable JSON, and UTF-8 without BOM.

- [ ] **Step 4: Stop at the human-review boundary**

Present the draft suite, metric summary, false must-read queries, missed required labels, and Top 1 misses to the user. Do not rename or copy the draft report into `evaluation\baselines\` until the user confirms the labels are correct.

No Git commit is performed for `team-agent-knowledge` because it currently belongs to a larger dirty workspace checkout; preserve all unrelated workspace changes and leave private evaluation files for explicit user review.

---

## Final Verification

- [ ] `npm.cmd test` reports zero failures in `C:\tmp\ak-eval\agent-knowledge`.
- [ ] `git diff --check` reports no whitespace errors.
- [ ] All new and modified text files are UTF-8 without BOM.
- [ ] `git status --short` in the isolated worktree contains only intentional changes or is clean after commits.
- [ ] The main checkout still contains the user's pre-existing uncommitted `AGENT.md` change and no implementation edits.
- [ ] The private draft suite and report exist only under `team-agent-knowledge\evaluation\` and have not been promoted to a formal baseline.
