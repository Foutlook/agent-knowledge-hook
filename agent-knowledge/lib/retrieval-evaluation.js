const LABEL_PATH_PATTERN = /^(knowledge|inbox)\/[A-Za-z0-9._\-/\p{Script=Han}]+\.md$/u;

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
