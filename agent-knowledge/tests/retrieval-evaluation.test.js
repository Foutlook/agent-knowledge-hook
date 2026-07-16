import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateEvaluationMetrics,
  validateEvaluationSuite,
} from '../lib/retrieval-evaluation.js';

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
