import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { collectMarkdownFiles, writeFileAtomic } from './knowledge-files.js';
import { searchKnowledge } from './retrieval.js';

const LABEL_PATH_PATTERN = /^(knowledge|inbox)\/[A-Za-z0-9._\-/\p{Script=Han}]+\.md$/u;
const METRIC_RULES = [
  { name: 'mustReadPrecision', direction: 'higher' },
  { name: 'requiredRecallAt5', direction: 'higher' },
  { name: 'falseMustReadCount', direction: 'lower' },
  { name: 'top1HitRate', direction: 'higher' },
];

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
}

function assertAllowedKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`${label} 包含未知字段: ${unknown}`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} 必须是非空字符串`);
  }
}

function validateLabelPaths(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} 必须是数组`);
  }

  const seen = new Set();
  return value.map((file, index) => {
    assertNonEmptyString(file, `${label}[${index}]`);
    const segments = file.split('/');
    const unsafeSegment = segments.some((segment) => segment === '' || segment === '.' || segment === '..');
    if (!LABEL_PATH_PATTERN.test(file) || unsafeSegment || file.includes('\\')) {
      throw new Error(`${label}[${index}] 必须是 knowledge/ 或 inbox/ 下的相对 .md 路径: ${file}`);
    }
    if (seen.has(file)) {
      throw new Error(`${label} 路径重复: ${file}`);
    }
    seen.add(file);
    return file;
  });
}

export function validateEvaluationSuite(value) {
  assertPlainObject(value, '评测套件');
  // 严格字段集合可以把拼写错误变成显式失败，避免错误标签被静默忽略。
  assertAllowedKeys(value, ['version', 'name', 'queries'], '评测套件');
  if (value.version !== 1) {
    throw new Error('评测套件 version 必须为 1');
  }
  assertNonEmptyString(value.name, '评测套件 name');
  if (!Array.isArray(value.queries) || value.queries.length === 0) {
    throw new Error('评测套件 queries 必须是非空数组');
  }

  const ids = new Set();
  const queries = value.queries.map((query, index) => {
    const label = `queries[${index}]`;
    assertPlainObject(query, label);
    assertAllowedKeys(query, ['id', 'category', 'query', 'required', 'related'], label);
    for (const field of ['id', 'category', 'query']) {
      assertNonEmptyString(query[field], `${label}.${field}`);
    }
    const id = query.id.trim();
    if (ids.has(id)) {
      throw new Error(`评测查询 id 重复: ${id}`);
    }
    ids.add(id);

    const required = validateLabelPaths(query.required, `${label}.required`);
    const related = validateLabelPaths(query.related ?? [], `${label}.related`);
    const overlap = required.find((file) => related.includes(file));
    if (overlap) {
      throw new Error(`同一路径不能同时标为 required 和 related: ${overlap}`);
    }

    return {
      id,
      category: query.category.trim(),
      query: query.query.trim(),
      required,
      related,
    };
  });

  return {
    version: 1,
    name: value.name.trim(),
    queries,
  };
}

export function calculateEvaluationMetrics(queryEvaluations) {
  let mustReadReturned = 0;
  let correctMustReadCount = 0;
  let requiredCount = 0;
  let top1HitCount = 0;
  let positiveQueryCount = 0;

  for (const evaluation of queryEvaluations) {
    const required = new Set(evaluation.required);
    // 正式检索最多产生五项必读；评测同样封顶，避免测试夹具绕过生产约束。
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

export async function loadEvaluationSuite(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const suite = validateEvaluationSuite(JSON.parse(raw));
  return {
    suite,
    suiteHash: createHash('sha256').update(raw, 'utf8').digest('hex'),
  };
}

async function inspectKnowledgeCorpus(knowledgeRoot) {
  const resolvedRoot = path.resolve(knowledgeRoot);
  const files = await collectMarkdownFiles(resolvedRoot);
  const entries = [];
  for (const filePath of files) {
    entries.push({
      path: path.relative(resolvedRoot, filePath).split(path.sep).join('/'),
      content: await readFile(filePath),
    });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));

  const hash = createHash('sha256');
  for (const entry of entries) {
    // 路径和内容都进入指纹，防止重命名与正文变化被当成同一份评测语料。
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

function toEvaluationResult(result) {
  const resultPath = result.path ?? result.relativePath;
  if (typeof resultPath !== 'string' || resultPath === '') {
    throw new Error('检索结果缺少 path');
  }
  return {
    path: resultPath,
    mustRead: result.mustRead === true,
    mustReadReason: result.mustReadReason ?? '',
    score: result.score ?? 0,
    coverage: result.coverage ?? 0,
    matchedTerms: result.matchedTerms ?? [],
    reasonCodes: result.reasonCodes ?? [],
    hits: result.hits ?? [],
  };
}

export async function runRetrievalEvaluation({
  suite,
  suiteHash,
  knowledgeRoot,
  search = searchKnowledge,
}) {
  const resolvedKnowledgeRoot = path.resolve(knowledgeRoot);
  const corpus = await inspectKnowledgeCorpus(resolvedKnowledgeRoot);
  const corpusPaths = new Set(corpus.paths);
  for (const query of suite.queries) {
    for (const labelPath of [...query.required, ...query.related]) {
      if (!corpusPaths.has(labelPath)) {
        throw new Error(`评测查询 ${query.id} 的标注路径不存在: ${labelPath}`);
      }
    }
  }

  const queries = [];
  for (const query of suite.queries) {
    const results = (await search({
      knowledgeRoot: resolvedKnowledgeRoot,
      query: query.query,
    })).map(toEvaluationResult);
    const required = new Set(query.required);
    const mustReadPaths = results
      .filter((result) => result.mustRead)
      .slice(0, 5)
      .map((result) => result.path);
    const requiredMustRead = mustReadPaths.filter((file) => required.has(file));
    queries.push({
      id: query.id,
      category: query.category,
      query: query.query,
      required: query.required,
      related: query.related,
      results,
      requiredMustRead,
      falseMustRead: mustReadPaths.filter((file) => !required.has(file)),
      requiredMissingFromMustRead: query.required.filter((file) => !requiredMustRead.includes(file)),
      top1Hit: query.required.length > 0
        && results.length > 0
        && required.has(results[0].path),
    });
  }

  return {
    schemaVersion: 1,
    suiteName: suite.name,
    suiteHash,
    knowledgeFingerprint: corpus.fingerprint,
    corpusFileCount: corpus.paths.length,
    metrics: calculateEvaluationMetrics(queries),
    queries,
  };
}

function getComparableQueryIds(report) {
  if (!Array.isArray(report?.queries)) {
    throw new Error('无法比较评测报告: queries 必须是数组');
  }
  return report.queries.map((query) => query?.id);
}

function assertCompatibleReports(baseline, candidate) {
  const baselineIds = getComparableQueryIds(baseline);
  const candidateIds = getComparableQueryIds(candidate);
  const incompatibility = [
    baseline?.schemaVersion !== candidate?.schemaVersion && 'schemaVersion 不一致',
    baseline?.suiteHash !== candidate?.suiteHash && 'suiteHash 不一致',
    baseline?.knowledgeFingerprint !== candidate?.knowledgeFingerprint && 'knowledgeFingerprint 不一致',
    JSON.stringify(baselineIds) !== JSON.stringify(candidateIds) && '查询集合或顺序不一致',
  ].find(Boolean);
  if (incompatibility) {
    // 套件或知识正文变化时，指标变化无法再单独归因于检索算法，因此禁止直接比较。
    throw new Error(`无法比较评测报告: ${incompatibility}`);
  }
}

function metricValue(value) {
  // 没有分母的比率以 null 落盘；比较时按零处理，使后续真实命中能被识别为提升。
  return value === null ? 0 : value;
}

export function compareEvaluationReports(baseline, candidate) {
  assertCompatibleReports(baseline, candidate);
  const metricDeltas = {};
  const regressions = [];
  for (const rule of METRIC_RULES) {
    const baselineMetric = baseline.metrics?.[rule.name];
    const candidateMetric = candidate.metrics?.[rule.name];
    const baselineValue = metricValue(baselineMetric);
    const candidateValue = metricValue(candidateMetric);
    if (!Number.isFinite(baselineValue) || !Number.isFinite(candidateValue)) {
      throw new Error(`无法比较评测报告: 指标 ${rule.name} 不是有效数值`);
    }
    metricDeltas[rule.name] = candidateValue - baselineValue;
    const regressed = rule.direction === 'higher'
      ? candidateValue < baselineValue
      : candidateValue > baselineValue;
    if (regressed) {
      regressions.push({
        metric: rule.name,
        baseline: baselineMetric,
        candidate: candidateMetric,
      });
    }
  }

  const queryChanges = [];
  for (let index = 0; index < baseline.queries.length; index += 1) {
    const baselineQuery = baseline.queries[index];
    const candidateQuery = candidate.queries[index];
    const baselineFalseMustRead = baselineQuery.falseMustRead ?? [];
    const candidateFalseMustRead = candidateQuery.falseMustRead ?? [];
    const baselineRequiredMustRead = baselineQuery.requiredMustRead ?? [];
    const candidateRequiredMustRead = candidateQuery.requiredMustRead ?? [];
    const newFalseMustRead = candidateFalseMustRead
      .filter((file) => !baselineFalseMustRead.includes(file));
    const lostRequiredMustRead = baselineRequiredMustRead
      .filter((file) => !candidateRequiredMustRead.includes(file));
    const baselineTop1 = baselineQuery.results?.[0]?.path ?? null;
    const candidateTop1 = candidateQuery.results?.[0]?.path ?? null;
    if (newFalseMustRead.length > 0
      || lostRequiredMustRead.length > 0
      || baselineTop1 !== candidateTop1) {
      queryChanges.push({
        id: baselineQuery.id,
        newFalseMustRead,
        lostRequiredMustRead,
        baselineTop1,
        candidateTop1,
      });
    }
  }

  return {
    passed: regressions.length === 0,
    metricDeltas,
    regressions,
    queryChanges,
  };
}

export async function writeEvaluationReport(filePath, report) {
  await writeFileAtomic(path.resolve(filePath), `${JSON.stringify(report, null, 2)}\n`);
}
