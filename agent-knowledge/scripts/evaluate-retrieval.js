#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  compareEvaluationReports,
  loadEvaluationSuite,
  runRetrievalEvaluation,
  writeEvaluationReport,
} from '../lib/retrieval-evaluation.js';

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

async function main() {
  // 参数必须在任何文件读取或写入前完整校验，防止错误命令覆盖既有报告。
  const options = parseOptions(process.argv.slice(2));
  const loadedSuite = await loadEvaluationSuite(options.suite);
  let report = await runRetrievalEvaluation({
    ...loadedSuite,
    knowledgeRoot: options.knowledge_root,
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
  console.log(formatEvaluationSummary(report, options.output));
  process.exitCode = report.comparison && !report.comparison.passed ? 2 : 0;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
