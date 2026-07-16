import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  calculateEvaluationMetrics,
  compareEvaluationReports,
  loadEvaluationSuite,
  runRetrievalEvaluation,
  validateEvaluationSuite,
  writeEvaluationReport,
} from '../lib/retrieval-evaluation.js';
import {
  createTempRoot,
  writeExternalKnowledgeFile,
} from './test-helpers.js';

const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
const evaluationScriptPath = path.resolve(
  testDir,
  '..',
  'scripts',
  'evaluate-retrieval.js',
);

function createSuite(query = {}) {
  return {
    version: 1,
    name: 'synthetic retrieval',
    queries: [
      {
        id: 'graph',
        category: 'exact-symbol',
        query: 'queryGraph ownerId',
        required: ['knowledge/domain/graph.md'],
        related: ['knowledge/service-map/projects.md'],
        ...query,
      },
    ],
  };
}

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

test('validateEvaluationSuite rejects unsupported suite and query fields', () => {
  assert.throws(
    () => validateEvaluationSuite({ ...createSuite(), extra: true }),
    /未知字段.*extra/,
  );
  assert.throws(
    () => validateEvaluationSuite(createSuite({ extra: true })),
    /未知字段.*extra/,
  );
});

test('validateEvaluationSuite rejects duplicate ids and overlapping labels', () => {
  const duplicateIdSuite = createSuite();
  duplicateIdSuite.queries.push({ ...duplicateIdSuite.queries[0] });
  assert.throws(() => validateEvaluationSuite(duplicateIdSuite), /id 重复.*graph/);

  assert.throws(
    () => validateEvaluationSuite(createSuite({
      related: ['knowledge/domain/graph.md'],
    })),
    /同时标为 required 和 related.*knowledge\/domain\/graph\.md/,
  );
});

test('validateEvaluationSuite rejects unsafe and non-Markdown labels', () => {
  for (const invalidPath of [
    'C:/private.md',
    '../knowledge/private.md',
    'knowledge\\private.md',
    'knowledge/private.txt',
    'knowledge/../private.md',
  ]) {
    assert.throws(
      () => validateEvaluationSuite(createSuite({ required: [invalidPath] })),
      /(knowledge|inbox)\/.*\.md/,
      invalidPath,
    );
  }
});

test('validateEvaluationSuite rejects duplicate label paths', () => {
  assert.throws(
    () => validateEvaluationSuite(createSuite({
      required: ['knowledge/domain/graph.md', 'knowledge/domain/graph.md'],
    })),
    /路径重复.*knowledge\/domain\/graph\.md/,
  );
});

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

test('calculateEvaluationMetrics returns null rates for empty denominators', () => {
  assert.deepEqual(calculateEvaluationMetrics([{
    id: 'negative',
    required: [],
    results: [],
  }]), {
    mustReadPrecision: null,
    requiredRecallAt5: null,
    falseMustReadCount: 0,
    top1HitRate: null,
    mustReadReturned: 0,
    correctMustReadCount: 0,
    requiredCount: 0,
    positiveQueryCount: 0,
  });
});

test('calculateEvaluationMetrics evaluates at most five must-read results', () => {
  const results = Array.from({ length: 6 }, (_, index) => ({
    path: `knowledge/${index + 1}.md`,
    mustRead: true,
  }));

  const metrics = calculateEvaluationMetrics([{
    id: 'cap',
    required: ['knowledge/6.md'],
    results,
  }]);

  assert.equal(metrics.mustReadReturned, 5);
  assert.equal(metrics.correctMustReadCount, 0);
  assert.equal(metrics.requiredRecallAt5, 0);
});

async function createEvaluationFixture() {
  const knowledgeRoot = await createTempRoot();
  const aPath = await writeExternalKnowledgeFile(
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
  return { knowledgeRoot, suitePath, aPath };
}

test('runRetrievalEvaluation records labels, results, metrics, and fingerprints', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  const loaded = await loadEvaluationSuite(suitePath);
  const report = await runRetrievalEvaluation({
    ...loaded,
    knowledgeRoot,
    search: async ({ query }) => {
      assert.equal(query, 'alpha');
      return [{
        path: 'knowledge/a.md',
        mustRead: true,
        mustReadReason: 'high_coverage_title',
        score: 10,
        coverage: 1,
        matchedTerms: ['alpha'],
        reasonCodes: ['title'],
        hits: ['标题'],
      }];
    },
  });

  assert.match(report.suiteHash, /^[a-f0-9]{64}$/);
  assert.match(report.knowledgeFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.suiteName, 'fixture');
  assert.equal(report.metrics.mustReadPrecision, 1);
  assert.deepEqual(report.queries[0].requiredMustRead, ['knowledge/a.md']);
  assert.deepEqual(report.queries[0].falseMustRead, []);
  assert.deepEqual(report.queries[0].requiredMissingFromMustRead, []);
  assert.equal(report.queries[0].top1Hit, true);
});

test('runRetrievalEvaluation changes the fingerprint when Markdown content changes', async () => {
  const { knowledgeRoot, suitePath, aPath } = await createEvaluationFixture();
  const loaded = await loadEvaluationSuite(suitePath);
  const search = async () => [{ path: 'knowledge/a.md', mustRead: true }];
  const before = await runRetrievalEvaluation({
    ...loaded,
    knowledgeRoot,
    search,
  });

  await writeFile(aPath, '# A\n\nchanged\n', 'utf8');
  const after = await runRetrievalEvaluation({
    ...loaded,
    knowledgeRoot,
    search,
  });

  assert.notEqual(before.knowledgeFingerprint, after.knowledgeFingerprint);
});

test('runRetrievalEvaluation rejects missing labeled paths before searching', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  const loaded = await loadEvaluationSuite(suitePath);
  loaded.suite.queries[0].required = ['knowledge/missing.md'];
  let searchCount = 0;

  await assert.rejects(
    runRetrievalEvaluation({
      ...loaded,
      knowledgeRoot,
      search: async () => {
        searchCount += 1;
        return [];
      },
    }),
    /标注路径不存在.*knowledge\/missing\.md/,
  );
  assert.equal(searchCount, 0);
});

function createReportFixture(overrides = {}) {
  return {
    schemaVersion: 1,
    suiteName: 'fixture',
    suiteHash: 'a'.repeat(64),
    knowledgeFingerprint: 'b'.repeat(64),
    metrics: {
      mustReadPrecision: 1,
      requiredRecallAt5: 1,
      falseMustReadCount: 0,
      top1HitRate: 1,
    },
    queries: [{
      id: 'q1',
      required: ['knowledge/a.md'],
      requiredMustRead: ['knowledge/a.md'],
      falseMustRead: [],
      results: [{ path: 'knowledge/a.md', mustRead: true }],
    }],
    ...overrides,
  };
}

test('compareEvaluationReports rejects all four metric regressions', () => {
  const baseline = createReportFixture();
  const candidate = createReportFixture({
    metrics: {
      mustReadPrecision: 0.5,
      requiredRecallAt5: 0,
      falseMustReadCount: 1,
      top1HitRate: 0,
    },
    queries: [{
      id: 'q1',
      required: ['knowledge/a.md'],
      requiredMustRead: [],
      falseMustRead: ['knowledge/b.md'],
      results: [{ path: 'knowledge/b.md', mustRead: true }],
    }],
  });

  const comparison = compareEvaluationReports(baseline, candidate);
  assert.equal(comparison.passed, false);
  assert.deepEqual(
    comparison.regressions.map((item) => item.metric),
    ['mustReadPrecision', 'requiredRecallAt5', 'falseMustReadCount', 'top1HitRate'],
  );
  assert.deepEqual(comparison.queryChanges, [{
    id: 'q1',
    newFalseMustRead: ['knowledge/b.md'],
    lostRequiredMustRead: ['knowledge/a.md'],
    baselineTop1: 'knowledge/a.md',
    candidateTop1: 'knowledge/b.md',
  }]);
});

test('compareEvaluationReports treats null rates as zero for comparison', () => {
  const baseline = createReportFixture({
    metrics: {
      mustReadPrecision: null,
      requiredRecallAt5: null,
      falseMustReadCount: 0,
      top1HitRate: null,
    },
  });
  const candidate = createReportFixture({
    metrics: {
      mustReadPrecision: 1,
      requiredRecallAt5: 1,
      falseMustReadCount: 0,
      top1HitRate: 1,
    },
  });

  const comparison = compareEvaluationReports(baseline, candidate);
  assert.equal(comparison.passed, true);
  assert.equal(comparison.metricDeltas.mustReadPrecision, 1);
});

test('compareEvaluationReports rejects incompatible reports', () => {
  const baseline = createReportFixture();
  for (const candidate of [
    createReportFixture({ schemaVersion: 2 }),
    createReportFixture({ suiteHash: 'c'.repeat(64) }),
    createReportFixture({ knowledgeFingerprint: 'd'.repeat(64) }),
    createReportFixture({ queries: [{ id: 'different' }] }),
  ]) {
    assert.throws(
      () => compareEvaluationReports(baseline, candidate),
      /无法比较评测报告/,
    );
  }
});

test('writeEvaluationReport writes parseable UTF-8 JSON without BOM', async () => {
  const root = await createTempRoot();
  const reportPath = path.join(root, 'report.json');
  const report = createReportFixture();

  await writeEvaluationReport(reportPath, report);

  const bytes = await readFile(reportPath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(JSON.parse(bytes.toString('utf8')), report);
});

async function runEvaluationScript(args) {
  try {
    const result = await execFileAsync(process.execPath, [evaluationScriptPath, ...args]);
    return { code: 0, ...result };
  } catch (error) {
    return {
      code: error.code,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    };
  }
}

test('evaluation script rejects missing, unknown, duplicate, and valueless options', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  const outputPath = path.join(knowledgeRoot, 'invalid-output.json');
  const invalidCases = [
    { args: ['--knowledge-root', knowledgeRoot], message: /用法/ },
    { args: ['--suite', suitePath], message: /用法/ },
    {
      args: ['--suite', suitePath, '--knowledge-root', knowledgeRoot, '--unknown', 'x'],
      message: /未知评测参数.*--unknown/,
    },
    {
      args: ['--suite', suitePath, '--suite', suitePath, '--knowledge-root', knowledgeRoot],
      message: /评测参数不能重复.*--suite/,
    },
    {
      args: ['--suite', suitePath, '--knowledge-root'],
      message: /评测参数缺少值.*--knowledge-root/,
    },
  ];

  for (const invalidCase of invalidCases) {
    await writeFile(outputPath, 'sentinel', 'utf8');
    const result = await runEvaluationScript([...invalidCase.args, '--output', outputPath]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, invalidCase.message);
    assert.equal(await readFile(outputPath, 'utf8'), 'sentinel');
  }
});

test('evaluation script writes a parseable UTF-8 report', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  const outputPath = path.join(knowledgeRoot, 'report.json');

  const result = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--output', outputPath,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /评测套件：fixture/);
  assert.match(result.stdout, /报告：/);
  const bytes = await readFile(outputPath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(JSON.parse(bytes.toString('utf8')).suiteName, 'fixture');
});

test('evaluation script returns zero for a compatible non-regressing baseline', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  const baselinePath = path.join(knowledgeRoot, 'baseline.json');
  const candidatePath = path.join(knowledgeRoot, 'candidate.json');
  const firstRun = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--output', baselinePath,
  ]);
  assert.equal(firstRun.code, 0, firstRun.stderr);

  const result = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--baseline', baselinePath,
    '--output', candidatePath,
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /基线比较：通过/);
  assert.equal(JSON.parse(await readFile(candidatePath, 'utf8')).comparison.passed, true);
});

test('evaluation script returns two and writes details for a compatible regression', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  await writeFile(suitePath, JSON.stringify({
    version: 1,
    name: 'regression fixture',
    queries: [{
      id: 'alpha',
      category: 'exact-symbol',
      query: 'alpha',
      required: ['knowledge/b.md'],
      related: ['knowledge/a.md'],
    }],
  }), 'utf8');
  const firstPath = path.join(knowledgeRoot, 'first.json');
  const baselinePath = path.join(knowledgeRoot, 'baseline.json');
  const candidatePath = path.join(knowledgeRoot, 'candidate.json');
  const firstRun = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--output', firstPath,
  ]);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const baseline = JSON.parse(await readFile(firstPath, 'utf8'));
  baseline.metrics = {
    ...baseline.metrics,
    mustReadPrecision: 1,
    requiredRecallAt5: 1,
    falseMustReadCount: 0,
    top1HitRate: 1,
  };
  await writeFile(baselinePath, JSON.stringify(baseline), 'utf8');

  const result = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--baseline', baselinePath,
    '--output', candidatePath,
  ]);

  assert.equal(result.code, 2, result.stderr);
  assert.match(result.stdout, /基线比较：退化/);
  const candidate = JSON.parse(await readFile(candidatePath, 'utf8'));
  assert.equal(candidate.comparison.passed, false);
  assert.ok(candidate.comparison.regressions.length > 0);
});

test('evaluation script rejects an incompatible baseline without replacing output', async () => {
  const { knowledgeRoot, suitePath } = await createEvaluationFixture();
  const baselinePath = path.join(knowledgeRoot, 'baseline.json');
  const outputPath = path.join(knowledgeRoot, 'candidate.json');
  const firstRun = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--output', baselinePath,
  ]);
  assert.equal(firstRun.code, 0, firstRun.stderr);
  const baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
  baseline.knowledgeFingerprint = '0'.repeat(64);
  await writeFile(baselinePath, JSON.stringify(baseline), 'utf8');
  await writeFile(outputPath, 'sentinel', 'utf8');

  const result = await runEvaluationScript([
    '--suite', suitePath,
    '--knowledge-root', knowledgeRoot,
    '--baseline', baselinePath,
    '--output', outputPath,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /无法比较评测报告/);
  assert.equal(await readFile(outputPath, 'utf8'), 'sentinel');
});
