#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  loadCommandContract,
  renderCliUsage,
} from '../lib/command-contract.js';
import {
  collectMarkdownFiles,
  hasFrontmatterField,
  inspectMarkdownCollectionPath,
  isExistingDirectory,
  isExistingFileWithinRealRoot,
  isPathWithinRoot,
  parseFrontmatter,
  parseMarkdownFile,
  readDoctorMarkdownFile,
  readFrontmatterField,
  resolveKnowledgeContext,
  resolveRealPathIfExists,
  resolveRootDir,
  toPosixPath,
  writeFileAtomic,
  writeUniqueFile,
} from '../lib/knowledge-files.js';
import {
  isProcessAlive,
  parseLockContent,
  RFC4122_UUID_PATTERN,
} from '../lib/locks.js';
import {
  addRule,
  checkStale,
  listPending,
  promote,
  recordFix,
  refreshProject,
} from '../lib/lifecycle.js';
import {
  extractKeywords,
  extractQueryKeywords,
  searchKnowledge,
} from '../lib/retrieval.js';
import {
  syncAdapters,
  syncCommandDocs,
} from '../lib/repository-maintenance.js';
import { resolveFix } from '../lib/resolve-fix.js';
import { TARGETED_FIX_CATEGORIES } from '../lib/targeted-fix-contract.js';

export {
  addRule,
  checkStale,
  extractKeywords,
  extractQueryKeywords,
  listPending,
  promote,
  recordFix,
  refreshProject,
  resolveFix,
  searchKnowledge,
  syncAdapters,
  syncCommandDocs,
  writeFileAtomic,
  writeUniqueFile,
};

const ADJACENT_LOCK_FILE_PATTERN = /\.md\.lock(?:\.reclaim)?$/;
const RESOLVE_LOCK_FILE_PATTERN = /^[0-9a-f]{64}\.lock(?:\.reclaim)?$/;

const GLOBAL_OPTION_SUPPORT = Object.freeze({
  json: new Set(['before-task', 'search', 'check-stale', 'doctor']),
  knowledgeRoot: new Set([
    'before-task',
    'search',
    'add-rule',
    'record-fix',
    'check-stale',
    'refresh-project',
    'resolve-fix',
    'promote',
    'list-pending',
    // ak.ps1 会统一注入知识库根；适配器仍只从 repositoryRoot 读取模板，保留该参数仅为兼容既有入口。
    'sync-adapters',
    'doctor',
  ]),
  repositoryRoot: new Set(['sync-adapters', 'doctor', 'sync-command-docs']),
});
const KNOWN_CLI_COMMANDS = new Set([
  ...GLOBAL_OPTION_SUPPORT.json,
  ...GLOBAL_OPTION_SUPPORT.knowledgeRoot,
  ...GLOBAL_OPTION_SUPPORT.repositoryRoot,
]);

export async function doctor({ repositoryRoot, knowledgeRoot } = {}) {
  const knowledgeContext = resolveKnowledgeContext({ knowledgeRoot });
  const resolvedRepositoryRoot = resolveRootDir(repositoryRoot);
  const files = (await collectMarkdownFiles(knowledgeContext.baseDir))
    .filter((filePath) => toPosixPath(path.relative(knowledgeContext.baseDir, filePath)) !== 'inbox/README.md')
    .sort();
  const resolvedKnowledgeRoot = await resolveRealPathIfExists(knowledgeContext.baseDir);
  const issues = [];
  const titles = new Map();
  let checkedFiles = 0;

  for (const filePath of files) {
    const relativePath = toPosixPath(path.relative(knowledgeContext.baseDir, filePath));
    let raw = await readDoctorMarkdownFile(
      knowledgeContext.baseDir,
      resolvedKnowledgeRoot,
      filePath,
    );
    if (raw === null) {
      continue;
    }
    checkedFiles += 1;
    if (raw.startsWith('\ufeff')) {
      addDoctorIssue(issues, 'error', 'utf8_bom', relativePath, '文件包含 UTF-8 BOM');
      // BOM 是编码问题，不应阻断同一文件后续的 frontmatter 与引用检查。
      raw = raw.slice(1);
    }

    const parsed = parseFrontmatter(raw);
    const hasFrontmatter = hasCompleteFrontmatter(raw);
    const title = readFrontmatterField(parsed.frontmatter, 'title')
      || parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim()
      || '';
    const normalizedTitle = normalizeDoctorTitle(title);
    if (normalizedTitle) {
      const entries = titles.get(normalizedTitle) ?? [];
      entries.push(relativePath);
      titles.set(normalizedTitle, entries);
    }

    if (!hasFrontmatter) {
      addDoctorIssue(issues, 'error', 'missing_frontmatter', relativePath, '缺少完整的 frontmatter');
      continue;
    }

    validateDoctorStatus(parsed.frontmatter, relativePath, issues);
    await validateDoctorTarget(knowledgeContext.baseDir, parsed.frontmatter, relativePath, issues);
    validateDoctorFixMetadata(parsed.frontmatter, relativePath, issues);
    await validateDoctorEvidence(parsed.frontmatter, relativePath, issues);
  }

  appendDuplicateTitleIssues(titles, issues);
  await appendLockIssues(knowledgeContext.baseDir, resolvedKnowledgeRoot, issues);
  await appendAdapterIssues(resolvedRepositoryRoot, issues);
  sortDoctorIssues(issues);

  return {
    ok: !issues.some((issue) => issue.severity === 'error'),
    checkedFiles,
    issues,
  };
}

function hasCompleteFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  return normalized.startsWith('---\n') && normalized.indexOf('\n---\n', 4) !== -1;
}

function normalizeDoctorTitle(title) {
  return String(title).normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

function validateDoctorStatus(frontmatter, relativePath, issues) {
  const status = readFrontmatterField(frontmatter, 'status');
  const allowedStatuses = relativePath.startsWith('knowledge/')
    ? ['confirmed']
    : ['draft', 'pending'];
  if (!allowedStatuses.includes(status)) {
    addDoctorIssue(
      issues,
      'error',
      'invalid_status',
      relativePath,
      `${relativePath.startsWith('knowledge/') ? 'knowledge/' : 'inbox/'} 仅允许 status: ${allowedStatuses.join(' 或 ')}，当前为 ${status || '(empty)'}`,
    );
  }
}

async function validateDoctorTarget(baseDir, frontmatter, relativePath, issues) {
  const target = readFrontmatterField(frontmatter, 'target');
  if (!target) {
    return;
  }

  const targetPath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
  const targetRelativePath = path.relative(baseDir, targetPath);
  const valid = isPathWithinRoot(targetRelativePath)
    && targetPath.endsWith('.md')
    && await isExistingFileWithinRealRoot(baseDir, targetPath);
  if (!valid) {
    addDoctorIssue(
      issues,
      'error',
      'broken_target',
      relativePath,
      `target 不在当前知识库内、不是 .md 文件或文件不存在：${target}`,
    );
  }
}

function validateDoctorFixMetadata(frontmatter, relativePath, issues) {
  const parts = relativePath.split('/');
  const target = readFrontmatterField(frontmatter, 'target');
  // 空白 target 与独立 fix 等价；只有固定纠偏分类中的 pending targeted fix 才受闭环元数据约束。
  if (parts.length !== 3
      || parts[0] !== 'inbox'
      || !TARGETED_FIX_CATEGORIES.has(parts[1])
      || readFrontmatterField(frontmatter, 'status') !== 'pending'
      || !target) {
    return;
  }

  const targetHash = readFrontmatterField(frontmatter, 'target_hash');
  if (!hasFrontmatterField(frontmatter, 'target_hash')) {
    addDoctorIssue(
      issues,
      'warning',
      'missing_target_hash',
      relativePath,
      'targeted fix 缺少 target_hash，关闭时需要显式传入 --confirm-legacy',
    );
  } else if (!/^[0-9a-f]{64}$/i.test(targetHash)) {
    addDoctorIssue(
      issues,
      'error',
      'invalid_target_hash',
      relativePath,
      'target_hash 必须是 64 位十六进制 SHA-256',
    );
  }

  if (hasFrontmatterField(frontmatter, 'fix_id')
      && !RFC4122_UUID_PATTERN.test(readFrontmatterField(frontmatter, 'fix_id'))) {
    addDoctorIssue(
      issues,
      'error',
      'invalid_fix_id',
      relativePath,
      'fix_id 必须是合法 UUID',
    );
  }
}

async function validateDoctorEvidence(frontmatter, relativePath, issues) {
  const evidenceFiles = readFrontmatterField(frontmatter, 'evidence_files')
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
  if (evidenceFiles.length === 0) {
    return;
  }

  const projectRoot = readFrontmatterField(frontmatter, 'project_root');
  if (!projectRoot) {
    addDoctorIssue(
      issues,
      'warning',
      'missing_project_root',
      relativePath,
      'evidence_files 非空时必须配置 project_root',
    );
    return;
  }

  const resolvedProjectRoot = path.resolve(projectRoot);
  if (!await isExistingDirectory(resolvedProjectRoot)) {
    addDoctorIssue(
      issues,
      'warning',
      'missing_evidence_file',
      relativePath,
      `project_root 在本机不存在或不是目录：${projectRoot}`,
    );
    return;
  }

  for (const evidenceFile of evidenceFiles) {
    // 证据必须由 project_root 闭环解析；绝对路径和越界路径都会破坏知识的可迁移性。
    if (path.isAbsolute(evidenceFile)) {
      addDoctorIssue(
        issues,
        'warning',
        'missing_evidence_file',
        relativePath,
        `evidence_files 只允许 project_root 内的相对路径：${evidenceFile}`,
      );
      continue;
    }

    const evidencePath = path.resolve(resolvedProjectRoot, evidenceFile);
    const relativeEvidencePath = path.relative(resolvedProjectRoot, evidencePath);
    if (!isPathWithinRoot(relativeEvidencePath)) {
      addDoctorIssue(
        issues,
        'warning',
        'missing_evidence_file',
        relativePath,
        `evidence_files 路径越出 project_root：${evidenceFile}`,
      );
    } else if (!await isExistingFileWithinRealRoot(resolvedProjectRoot, evidencePath)) {
      addDoctorIssue(
        issues,
        'warning',
        'missing_evidence_file',
        relativePath,
        `证据文件不存在：${evidenceFile}`,
      );
    }
  }
}

function appendDuplicateTitleIssues(titles, issues) {
  for (const paths of titles.values()) {
    if (paths.length < 2) {
      continue;
    }

    const sortedPaths = paths.slice().sort();
    const message = `规范化标题重复：${sortedPaths.join(', ')}`;
    for (const relativePath of sortedPaths) {
      addDoctorIssue(issues, 'warning', 'duplicate_title', relativePath, message);
    }
  }
}

async function appendLockIssues(baseDir, resolvedBaseDir, issues) {
  const lockPaths = [];
  for (const scanRoot of ['knowledge', 'inbox']) {
    await collectAdjacentLockFilesUnder(
      path.join(baseDir, scanRoot),
      lockPaths,
      baseDir,
      resolvedBaseDir,
    );
  }
  await collectResolveLockFiles(baseDir, resolvedBaseDir, lockPaths);

  for (const lockPath of lockPaths) {
    const raw = await readDoctorLockFile(baseDir, resolvedBaseDir, lockPath);
    if (raw === null) {
      continue;
    }

    const relativePath = toPosixPath(path.relative(baseDir, lockPath));
    const lock = parseLockContent(raw);
    if (!lock) {
      addDoctorIssue(
        issues,
        'warning',
        'invalid_lock',
        relativePath,
        '锁 token 无法解析；doctor 不会修改此文件，请确认无活跃任务后人工排查',
      );
    } else if (!isProcessAlive(lock.ownerPid)) {
      addDoctorIssue(
        issues,
        'warning',
        'orphan_lock',
        relativePath,
        `锁 owner PID ${lock.ownerPid} 已退出；doctor 不会自动删除，请确认无活跃任务后人工处理`,
      );
    }
  }
}

async function collectAdjacentLockFilesUnder(dir, lockPaths, baseDir, resolvedBaseDir) {
  const directoryInfo = await inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, dir);
  if (!directoryInfo?.stats.isDirectory()) {
    return;
  }

  const entries = await readdir(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    if (ADJACENT_LOCK_FILE_PATTERN.test(entry)) {
      // 具体文件类型和真实路径统一在读取前复核，目录或链接外观的锁名不会被读取。
      lockPaths.push(entryPath);
      continue;
    }
    const entryInfo = await inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, entryPath);
    if (entryInfo?.stats.isDirectory()) {
      await collectAdjacentLockFilesUnder(entryPath, lockPaths, baseDir, resolvedBaseDir);
    }
  }
}

async function collectResolveLockFiles(baseDir, resolvedBaseDir, lockPaths) {
  const resolveLockDir = path.join(baseDir, 'work', 'locks', 'resolve');
  const directoryInfo = await inspectMarkdownCollectionPath(
    baseDir,
    resolvedBaseDir,
    resolveLockDir,
  );
  if (!directoryInfo?.stats.isDirectory()) {
    return;
  }

  const entries = await readdir(resolveLockDir);
  // resolve 目录不递归；候选路径仍由 readDoctorLockFile 做真实根与普通文件校验。
  lockPaths.push(...entries
    .filter((entry) => RESOLVE_LOCK_FILE_PATTERN.test(entry))
    .map((entry) => path.join(resolveLockDir, entry)));
}

async function readDoctorLockFile(baseDir, resolvedBaseDir, lockPath) {
  const lockInfo = await inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, lockPath);
  if (!lockInfo?.stats.isFile()) {
    return null;
  }

  // 与知识正文检查一样，读取前复核已发生的链接替换；doctor 始终只读，不清理任何锁。
  return readFile(lockPath, 'utf8')
    .catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
}

async function appendAdapterIssues(repositoryRoot, issues) {
  const targetDir = path.join(repositoryRoot, '.opencode', 'command');
  if (!await isExistingDirectory(targetDir)) {
    return;
  }

  try {
    const result = await syncAdapters({ repositoryRoot, check: true });
    for (const issue of result.issues) {
      addDoctorIssue(
        issues,
        'error',
        'adapter_drift',
        issue.target,
        formatAdapterDriftMessage(issue),
      );
    }
  } catch (error) {
    // doctor 必须保持只读并返回完整结果，适配器读取异常也转换为可审计问题。
    addDoctorIssue(
      issues,
      'error',
      'adapter_drift',
      toPosixPath(path.relative(repositoryRoot, targetDir)),
      `适配器检查失败：${error.message}`,
    );
  }
}

function formatAdapterDriftMessage(issue) {
  if (issue.reason === 'missing_target') {
    return `适配器目标缺失：${issue.target}`;
  }
  if (issue.reason === 'template_read_failed') {
    return `适配器模板读取失败：${issue.source}（${issue.detail}）`;
  }
  return `适配器内容与模板不一致：${issue.target}`;
}

function addDoctorIssue(issues, severity, code, file, message) {
  issues.push({ severity, code, file, message });
}

function sortDoctorIssues(issues) {
  issues.sort((left, right) => {
    for (const field of ['file', 'code', 'message']) {
      if (left[field] < right[field]) {
        return -1;
      }
      if (left[field] > right[field]) {
        return 1;
      }
    }
    return 0;
  });
}


function formatSearchOutput(query, results) {
  const keywords = extractQueryKeywords(query);
  const lines = [
    `关键词列表：${keywords.length ? keywords.join(', ') : '无'}`,
    '命中文件：',
  ];

  if (results.length === 0) {
    lines.push('- 无');
  } else {
    for (const result of results) {
      const pending = result.pending ? '（待确认）' : '';
      const matchedTerms = result.matchedTerms.length ? result.matchedTerms.join(', ') : '无';
      lines.push(`- ${result.repositoryPath}${pending} | 分数：${result.score} | 匹配词：${matchedTerms} | 命中位置：${result.hits.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function formatBeforeTaskOutput(query, results) {
  const keywords = extractQueryKeywords(query);
  const required = results.filter((result) => result.mustRead);
  const related = results.filter((result) => !result.mustRead);
  const lines = [
    `关键词列表：${keywords.length ? keywords.join(', ') : '无'}`,
    '必须阅读项：',
  ];

  appendResultLines(lines, required);
  lines.push('可能相关项：');
  appendResultLines(lines, related);
  lines.push(
    '执行要求：',
    '- 先阅读必须阅读项，再开始修改代码。',
    '- 区分守卫条件与真实业务依赖，追踪最终数据源和关键参数。',
    '- 新增或修改经验规则时先进入 inbox，确认后再沉淀到 knowledge。',
  );

  return lines.join('\n');
}

function appendResultLines(lines, results) {
  if (results.length === 0) {
    lines.push('- 无');
    return;
  }

  for (const result of results) {
    const pending = result.pending ? '（待确认）' : '';
    const staleTag = result.stale ? ' ⚠可能过期' : '';
    const snippet = result.snippet ? ` | 摘要：${result.snippet}` : '';
    const matchedTerms = result.matchedTerms.length ? result.matchedTerms.join(', ') : '无';
    lines.push(`- ${result.repositoryPath}${pending}${staleTag} | 分数：${result.score} | 匹配词：${matchedTerms} | 判定：${result.mustReadReason} | 命中位置：${result.hits.join(', ')}${snippet}`);
  }
}

function formatStaleOutput(result) {
  const lines = ['知识库过期检查：'];
  const currentShort = result.currentCommit.slice(0, 12);
  const scannedShort = result.scannedCommit ? result.scannedCommit.slice(0, 12) : '未记录';

  if (!result.stale) {
    lines.push(`- ${result.relativePath} | 已是最新 | commit: ${currentShort}`);
  } else if (result.reason === 'missing_last_scanned_commit') {
    lines.push(`- ${result.relativePath} | 可能过期 | 缺少 last_scanned_commit | current_commit: ${currentShort}`);
  } else {
    lines.push(
      `- ${result.relativePath} | 可能过期 | last_scanned_commit: ${scannedShort} | current_commit: ${currentShort}`,
    );
  }

  if (result.deep) {
    const deep = result.deep;
    if (deep === null) {
      lines.push(`- 深度检查不可用：无法对比 ${scannedShort}..HEAD 或缺少 evidence_files`);
    } else {
      const hitSuffix = deep.hitFiles.length ? `（${deep.hitFiles.join(', ')}）` : '';
      lines.push(
        `- 深度检查：依赖文件 ${deep.evidenceCount} 个，期间变更 ${deep.changedCount} 个，命中 ${deep.hitFiles.length} 个${hitSuffix}`,
      );
    }
  }

  return lines.join('\n');
}

function formatRefreshOutput(result) {
  return [
    '知识库项目刷新：',
    `- ${result.relativePath} | 已刷新 | commit: ${result.currentCommit.slice(0, 12)}`,
  ].join('\n');
}

function formatPromoteOutput(result) {
  return [
    '已晋升知识条目：',
    `- ${result.source} -> ${result.target} | status: confirmed`,
  ].join('\n');
}

function formatResolveFixOutput(result) {
  return [
    '已关闭 targeted fix：',
    `- source: ${result.source}`,
    `- snapshot: ${result.sourceSnapshot}`,
    `- resolved: ${result.resolved}`,
  ].join('\n');
}

function formatPendingOutput(items) {
  const lines = ['待确认知识清单（inbox）：'];
  if (items.length === 0) {
    lines.push('- 无');
    return lines.join('\n');
  }

  for (const item of items) {
    const type = item.type || '-';
    const updated = item.updated || '-';
    lines.push(`- ${item.relativePath} | status: ${item.status} | type: ${type} | updated: ${updated}`);
  }

  return lines.join('\n');
}

function formatDoctorOutput(result) {
  const errorCount = result.issues.filter((issue) => issue.severity === 'error').length;
  const warningCount = result.issues.filter((issue) => issue.severity === 'warning').length;
  const lines = [
    `知识库健康检查：已检查 ${result.checkedFiles} 个文件，发现 ${errorCount} 个错误、${warningCount} 个警告。`,
    '本次为只读检查，未修改任何文件。',
  ];

  for (const issue of result.issues) {
    lines.push(`- [${issue.severity}] ${issue.code} ${issue.file}: ${issue.message}`);
  }

  return lines.join('\n');
}

// 机读输出：将检索结果整理为结构化对象，便于 OpenCode/Codex 自动化管线消费。
function resultToJson(command, query, results) {
  const queryTerms = extractKeywords(query);
  const expandedTerms = extractQueryKeywords(query);
  return {
    command,
    query,
    keywords: expandedTerms,
    queryTerms,
    expandedTerms,
    results: results.map((result) => ({
      repositoryPath: result.repositoryPath,
      relativePath: result.relativePath,
      title: result.title,
      score: result.score,
      mustRead: result.mustRead,
      mustReadReason: result.mustReadReason,
      pending: result.pending,
      hits: result.hits,
      matchedTerms: result.matchedTerms,
      reasonCodes: result.reasonCodes,
      coverage: result.coverage,
      matched: result.matched,
      total: result.total,
      stale: result.stale,
      staleReason: result.staleReason,
      snippet: result.snippet,
    })),
  };
}

function staleToJson(result) {
  return { command: 'check-stale', ...result };
}

function usage(contract) {
  return [
    '用法：agent-knowledge <command> [args]',
    '',
    '命令：',
    renderCliUsage(contract),
    '',
    '选项：',
    '  --knowledge-root <path>                         使用分离的私有知识库根目录',
    '  --repository-root <path>                        指定工具仓库根目录',
    '  AGENT_KNOWLEDGE_ROOT                            未传参数时使用的知识库根目录环境变量',
    '  --json                                          以 JSON 形式输出，便于自动化管线消费',
    '  --help                                          显示帮助',
  ].join('\n');
}

async function main(argv) {
  const [command, ...args] = argv;
  const globalOptions = parseGlobalOptions(args);

  if (!command || command === '--help' || command === '-h') {
    const contract = await loadCommandContract();
    console.log(usage(contract));
    return 0;
  }

  validateGlobalOptions(command, globalOptions);

  if (command === 'search') {
    const query = parseFreeTextArguments(globalOptions.args, command);
    const results = await searchKnowledge({
      query,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    if (globalOptions.json) {
      console.log(JSON.stringify(resultToJson('search', query, results), null, 2));
    } else {
      console.log(formatSearchOutput(query, results));
    }
    return 0;
  }

  if (command === 'before-task') {
    const query = parseFreeTextArguments(globalOptions.args, command);
    const results = await searchKnowledge({
      query,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    if (globalOptions.json) {
      console.log(JSON.stringify(resultToJson('before-task', query, results), null, 2));
    } else {
      console.log(formatBeforeTaskOutput(query, results));
    }
    return 0;
  }

  if (command === 'sync-adapters') {
    if (globalOptions.json
        || globalOptions.args.length > 1
        || (globalOptions.args.length === 1 && globalOptions.args[0] !== '--check')) {
      throw new Error('sync-adapters 只允许零个参数或唯一的 --check');
    }
    const check = globalOptions.args.length === 1;
    const result = await syncAdapters({
      repositoryRoot: resolveRootDir(globalOptions.repositoryRoot || undefined),
      check,
    });
    if (check) {
      if (result.ok) {
        console.log('适配器检查通过：未发现漂移。');
        return 0;
      }

      console.error('适配器检查失败：');
      for (const issue of result.issues) {
        console.error(`- ${issue.code}: ${issue.target} (${issue.reason})`);
      }
      return 1;
    }

    console.log(`已同步适配器：\n${result.synced.map((target) => `- ${target}`).join('\n')}`);
    return 0;
  }

  if (command === 'doctor') {
    if (globalOptions.args.length > 0) {
      throw new Error('doctor 除全局选项外不接受其他参数');
    }
    const result = await doctor({
      knowledgeRoot: globalOptions.knowledgeRoot,
      repositoryRoot: globalOptions.repositoryRoot || undefined,
    });
    if (globalOptions.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatDoctorOutput(result));
    }
    return result.ok ? 0 : 1;
  }

  if (command === 'add-rule') {
    const options = parseCommandOptions(globalOptions.args, {
      command,
      flags: { confirmed: 'confirmed' },
      positional: { property: 'title', join: true },
    });
    const result = await addRule({
      title: options.title,
      confirmed: options.confirmed,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(`已写入：${result.path}`);
    return 0;
  }

  if (command === 'record-fix') {
    const options = parseCommandOptions(globalOptions.args, {
      command,
      values: {
        type: { property: 'type', hint: '<bug|prd|tech>' },
        target: { property: 'target', hint: '知识文件路径' },
      },
      multiValues: {
        title: { property: 'title', hint: '<title>' },
      },
    });
    const result = await recordFix({
      type: options.type,
      title: options.title,
      target: options.target,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(`已写入：${result.path}`);
    return 0;
  }

  if (command === 'check-stale') {
    const options = parseCommandOptions(globalOptions.args, {
      command,
      values: {
        'project-root': { property: 'projectRoot', hint: '<path>' },
        'knowledge-file': { property: 'knowledgeFile', hint: '<path>' },
      },
      flags: { deep: 'deep' },
    });
    const result = await checkStale({
      projectRoot: options.projectRoot,
      knowledgeFile: options.knowledgeFile,
      deep: options.deep,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    if (globalOptions.json) {
      console.log(JSON.stringify(staleToJson(result), null, 2));
    } else {
      console.log(formatStaleOutput(result));
    }
    return 0;
  }

  if (command === 'resolve-fix') {
    const options = parseResolveFixOptions(globalOptions.args, {
      globalOptionOccurrences: globalOptions.globalOptionOccurrences,
    });
    const result = await resolveFix({
      file: options.file,
      confirmLegacy: options.confirmLegacy,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(formatResolveFixOutput(result));
    return 0;
  }

  if (command === 'promote') {
    const options = parseCommandOptions(globalOptions.args, {
      command,
      values: { file: { property: 'file', hint: '<path>' } },
    });
    const result = await promote({
      file: options.file,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(formatPromoteOutput(result));
    return 0;
  }

  if (command === 'list-pending') {
    parseCommandOptions(globalOptions.args, { command });
    const items = await listPending({
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(formatPendingOutput(items));
    return 0;
  }

  if (command === 'refresh-project') {
    const options = parseCommandOptions(globalOptions.args, {
      command,
      values: {
        'project-root': { property: 'projectRoot', hint: '<path>' },
        'knowledge-file': { property: 'knowledgeFile', hint: '<path>' },
      },
      multiValues: {
        summary: { property: 'summary', hint: '<text>' },
      },
    });
    const result = await refreshProject({
      projectRoot: options.projectRoot,
      knowledgeFile: options.knowledgeFile,
      summary: options.summary,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(formatRefreshOutput(result));
    return 0;
  }

  if (command === 'sync-command-docs') {
    const contract = await loadCommandContract();
    const options = parseSyncCommandDocsOptions(globalOptions);
    const result = await syncCommandDocs({
      repositoryRoot: options.repositoryRoot,
      contract,
      check: options.check,
    });
    if (options.check) {
      if (result.ok) {
        console.log('命令文档检查通过：未发现漂移。');
        return 0;
      }
      console.error('命令文档检查失败：');
      for (const item of result.drift) {
        console.error(`- ${item.relativePath} [${item.blockName}]`);
      }
      return 1;
    }

    if (result.synced.length === 0) {
      console.log('命令文档已是最新，无需写入。');
    } else {
      console.log(`已同步命令文档：\n${result.synced.map((item) => `- ${item.relativePath} [${item.blockName}]`).join('\n')}`);
    }
    return 0;
  }

  const contract = await loadCommandContract();
  console.error(`未知命令：${command}\n\n${usage(contract)}`);
  return 1;
}

function parseGlobalOptions(args) {
  const remainingArgs = [];
  const options = {
    args: remainingArgs,
    knowledgeRoot: '',
    repositoryRoot: '',
    json: false,
    globalOptionOccurrences: {
      json: [],
      knowledgeRoot: [],
      repositoryRoot: [],
    },
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      options.json = true;
      options.globalOptionOccurrences.json.push({ index, form: 'flag', value: true });
    } else if (arg.startsWith('--knowledge-root=')) {
      const knowledgeRoot = arg.slice('--knowledge-root='.length);
      if (!knowledgeRoot || knowledgeRoot.startsWith('--')) {
        throw new Error('--knowledge-root 需要提供知识库路径，且路径不能以 -- 开头');
      }
      options.knowledgeRoot = knowledgeRoot;
      options.globalOptionOccurrences.knowledgeRoot.push({
        index,
        form: 'assignment',
        value: knowledgeRoot,
      });
    } else if (arg === '--knowledge-root') {
      const optionIndex = index;
      const knowledgeRoot = args[index + 1];
      if (!knowledgeRoot || knowledgeRoot.startsWith('--')) {
        throw new Error('--knowledge-root 需要提供知识库路径，且路径不能以 -- 开头');
      }
      options.knowledgeRoot = knowledgeRoot;
      options.globalOptionOccurrences.knowledgeRoot.push({
        index: optionIndex,
        form: 'separate',
        value: knowledgeRoot,
      });
      index += 1;
    } else if (arg.startsWith('--repository-root=')) {
      const repositoryRoot = arg.slice('--repository-root='.length);
      if (!repositoryRoot || repositoryRoot.startsWith('--')) {
        throw new Error('--repository-root 需要提供仓库路径，且路径不能以 -- 开头');
      }
      options.repositoryRoot = repositoryRoot;
      options.globalOptionOccurrences.repositoryRoot.push({
        index,
        form: 'assignment',
        value: repositoryRoot,
      });
    } else if (arg === '--repository-root') {
      const optionIndex = index;
      const repositoryRoot = args[index + 1];
      if (!repositoryRoot || repositoryRoot.startsWith('--')) {
        throw new Error('--repository-root 需要提供仓库路径，且路径不能以 -- 开头');
      }
      options.repositoryRoot = repositoryRoot;
      options.globalOptionOccurrences.repositoryRoot.push({
        index: optionIndex,
        form: 'separate',
        value: repositoryRoot,
      });
      index += 1;
    } else {
      remainingArgs.push(arg);
    }
  }

  return options;
}

function validateGlobalOptions(command, globalOptions) {
  if (!KNOWN_CLI_COMMANDS.has(command)) {
    return;
  }

  const optionNames = {
    json: '--json',
    knowledgeRoot: '--knowledge-root',
    repositoryRoot: '--repository-root',
  };
  for (const [property, optionName] of Object.entries(optionNames)) {
    const occurrences = globalOptions.globalOptionOccurrences[property];
    if (occurrences.length > 1) {
      throw new Error(`${command} ${optionName} 最多只能提供一次`);
    }
    if (occurrences.length > 0 && !GLOBAL_OPTION_SUPPORT[property].has(command)) {
      throw new Error(`${command} 不支持 ${optionName}`);
    }
  }
}

function parseFreeTextArguments(args, command) {
  const unknownOption = args.find((arg) => arg.startsWith('--'));
  if (unknownOption) {
    throw new Error(`${command} 不接受未知参数：${unknownOption}`);
  }
  return args.join(' ').trim();
}

function parseSyncCommandDocsOptions(globalOptions) {
  const occurrences = globalOptions.globalOptionOccurrences;
  if (occurrences.repositoryRoot.length === 0) {
    throw new Error('sync-command-docs 需要且只允许一个 --repository-root <path>');
  }
  if (occurrences.repositoryRoot.length > 1) {
    throw new Error('sync-command-docs --repository-root 只能提供一次');
  }
  if (occurrences.knowledgeRoot.length > 0) {
    throw new Error('sync-command-docs 不接受 --knowledge-root');
  }
  if (occurrences.json.length > 0) {
    throw new Error('sync-command-docs 不接受 --json');
  }

  let check = false;
  for (const arg of globalOptions.args) {
    if (arg === '--check') {
      if (check) {
        throw new Error('sync-command-docs --check 最多只能提供一次');
      }
      check = true;
    } else if (arg.startsWith('--')) {
      throw new Error(`sync-command-docs 不接受未知参数：${arg}`);
    } else {
      throw new Error(`sync-command-docs 不接受位置参数：${arg || '(empty)'}`);
    }
  }

  return { check, repositoryRoot: globalOptions.repositoryRoot };
}

function parseCommandOptions(args, {
  command,
  values = {},
  multiValues = {},
  flags = {},
  positional,
} = {}) {
  const options = {};
  const seen = new Set();

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      if (!positional) {
        throw new Error(`${command} 不接受位置参数：${arg || '(empty)'}`);
      }
      const valuesForPosition = [arg];
      if (positional.join) {
        while (args[index + 1] && !args[index + 1].startsWith('--')) {
          valuesForPosition.push(args[++index]);
        }
      }
      if (options[positional.property]) {
        throw new Error(`${command} 的位置参数只能提供一次`);
      }
      options[positional.property] = valuesForPosition.join(' ').trim();
      continue;
    }

    const assignmentIndex = arg.indexOf('=');
    const optionName = arg.slice(2, assignmentIndex === -1 ? undefined : assignmentIndex);
    const assignmentValue = assignmentIndex === -1 ? undefined : arg.slice(assignmentIndex + 1);
    const definition = values[optionName] ?? multiValues[optionName];
    const flagProperty = flags[optionName];
    if (!definition && !flagProperty) {
      throw new Error(`${command} 不接受未知参数：--${optionName}`);
    }
    if (seen.has(optionName)) {
      throw new Error(`${command} --${optionName} 最多只能提供一次`);
    }
    seen.add(optionName);

    if (flagProperty) {
      if (assignmentValue !== undefined) {
        throw new Error(`${command} --${optionName} 是布尔标记，不接受赋值`);
      }
      options[flagProperty] = true;
      continue;
    }

    let value = assignmentValue;
    if (value === undefined && multiValues[optionName]) {
      const parts = [];
      while (args[index + 1] && !args[index + 1].startsWith('--')) {
        parts.push(args[++index]);
      }
      value = parts.join(' ');
    } else if (value === undefined) {
      value = args[++index];
    }
    if (!value || !value.trim() || value.startsWith('--')) {
      throw new Error(`${command} --${optionName} 需要提供 ${definition.hint || '非空值'}`);
    }
    options[definition.property] = value;
  }

  return options;
}

function parseResolveFixOptions(args, { globalOptionOccurrences = {} } = {}) {
  if ((globalOptionOccurrences.json?.length ?? 0) > 0) {
    throw new Error('resolve-fix 只接受 --file <path> 和可选的 --confirm-legacy，不支持 --json');
  }
  if ((globalOptionOccurrences.repositoryRoot?.length ?? 0) > 0) {
    throw new Error('resolve-fix 不接受 --repository-root');
  }
  if ((globalOptionOccurrences.knowledgeRoot?.length ?? 0) > 1) {
    throw new Error('resolve-fix --knowledge-root 最多只能提供一次');
  }

  let file = '';
  let fileSeen = false;
  let confirmLegacy = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--file' || arg.startsWith('--file=')) {
      if (fileSeen) {
        throw new Error('resolve-fix --file 只能提供一次');
      }
      fileSeen = true;
      const value = arg === '--file' ? args[++index] : arg.slice('--file='.length);
      if (!value || !value.trim() || value.startsWith('--')) {
        throw new Error('resolve-fix --file 需要提供非空的 inbox 纠偏文件路径');
      }
      file = value;
    } else if (arg === '--confirm-legacy') {
      if (confirmLegacy) {
        throw new Error('resolve-fix --confirm-legacy 最多只能提供一次');
      }
      confirmLegacy = true;
    } else {
      throw new Error(`resolve-fix 不接受未知参数或位置参数: ${arg || '(empty)'}`);
    }
  }

  if (!fileSeen) {
    throw new Error('resolve-fix requires --file <path>');
  }
  return { file, confirmLegacy };
}

const executedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (executedPath === modulePath) {
  main(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
