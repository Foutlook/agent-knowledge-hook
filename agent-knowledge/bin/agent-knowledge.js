#!/usr/bin/env node

import { readdir, mkdir, readFile, rm, rmdir, stat, lstat, chmod, rename, link, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  loadCommandContract,
  renderAkCommandTable,
  renderCliCommandList,
  renderCliCommandTable,
  renderCliUsage,
  readUtf8Strict,
  replaceGeneratedBlock,
} from '../lib/command-contract.js';
import {
  appendRefreshRecord,
  applyTemplateFields,
  assertConfirmedKnowledgeFile,
  collectMarkdownFiles,
  createTemporaryPath,
  hasFrontmatterField,
  inspectMarkdownCollectionPath,
  isExistingDirectory,
  isExistingFileWithinRealRoot,
  isPathWithinRoot,
  parseFrontmatter,
  parseMarkdownFile,
  prepareKnowledgeDirectory,
  readDoctorMarkdownFile,
  readFrontmatterField,
  readGitHead,
  readTemplate,
  resolveKnowledgeContext,
  resolveKnowledgeMarkdownFile,
  resolveRealPathIfExists,
  resolveRootDir,
  slugify,
  timestamp,
  toPosixPath,
  updateFrontmatterFields,
  writeFileAtomic,
  writeUniqueFile,
} from '../lib/knowledge-files.js';
import {
  acquireAdjacentFileLock,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
  isProcessAlive,
  parseLockContent,
  RFC4122_UUID_PATTERN,
} from '../lib/locks.js';
import {
  extractKeywords,
  extractQueryKeywords,
  searchKnowledge,
} from '../lib/retrieval.js';

export { extractKeywords, extractQueryKeywords, searchKnowledge, writeFileAtomic, writeUniqueFile };

const FIX_TYPE_DIRS = {
  bug: ['inbox', 'fixes'],
  prd: ['inbox', 'prd-corrections'],
  tech: ['inbox', 'tech-solution-corrections'],
};
const RESOLVABLE_FIX_CATEGORIES = new Set([
  'fixes',
  'prd-corrections',
  'tech-solution-corrections',
]);
const ADJACENT_LOCK_FILE_PATTERN = /\.md\.lock(?:\.reclaim)?$/;
const RESOLVE_LOCK_FILE_PATTERN = /^[0-9a-f]{64}\.lock(?:\.reclaim)?$/;

const execFileAsync = promisify(execFile);
const ADAPTER_SPECS = Object.freeze([
  Object.freeze({ fileName: 'knowledge.before-task.md' }),
  Object.freeze({ fileName: 'knowledge.record-fix.md' }),
]);
const COMMAND_DOC_TARGETS = Object.freeze([
  Object.freeze({
    relativePath: 'README.md',
    blocks: Object.freeze([
      Object.freeze({ name: 'AK_COMMAND_TABLE', render: renderAkCommandTable }),
      Object.freeze({ name: 'CLI_COMMAND_TABLE', render: renderCliCommandTable }),
    ]),
  }),
  Object.freeze({
    relativePath: 'agent-knowledge/README.md',
    blocks: Object.freeze([
      Object.freeze({ name: 'AK_COMMAND_TABLE', render: renderAkCommandTable }),
      Object.freeze({ name: 'CLI_COMMAND_LIST', render: renderCliCommandList }),
    ]),
  }),
  Object.freeze({
    relativePath: 'agent-knowledge/help/ak.zh-CN.txt',
    blocks: Object.freeze([
      Object.freeze({ name: 'AK_COMMAND_TABLE', render: renderAkCommandTable }),
    ]),
  }),
]);
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

export async function syncAdapters({ repositoryRoot, check = false } = {}) {
  const resolvedRepositoryRoot = resolveRootDir(repositoryRoot);
  const templateDir = path.join(resolvedRepositoryRoot, 'agent-knowledge', 'templates', 'opencode');
  const targetDir = path.join(resolvedRepositoryRoot, '.opencode', 'command');
  const issues = [];
  const synced = [];

  // 适配器模板和安装目标都由工具仓库固定布局决定，不能随私有知识库位置漂移。
  if (!check) {
    await mkdir(targetDir, { recursive: true });
  }

  for (const spec of ADAPTER_SPECS) {
    const sourcePath = path.join(templateDir, spec.fileName);
    const targetPath = path.join(targetDir, spec.fileName);
    let source;
    try {
      source = await readFile(sourcePath, 'utf8');
    } catch (error) {
      if (!check) {
        throw error;
      }

      issues.push({
        code: 'adapter_drift',
        source: toPosixPath(path.relative(resolvedRepositoryRoot, sourcePath)),
        target: toPosixPath(path.relative(resolvedRepositoryRoot, targetPath)),
        reason: 'template_read_failed',
        detail: error.message,
      });
      continue;
    }

    if (!check) {
      await writeFileAtomic(targetPath, source);
      synced.push(toPosixPath(path.relative(resolvedRepositoryRoot, targetPath)));
      continue;
    }

    let target;
    try {
      target = await readFile(targetPath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }

    if (target !== source) {
      issues.push({
        code: 'adapter_drift',
        source: toPosixPath(path.relative(resolvedRepositoryRoot, sourcePath)),
        target: toPosixPath(path.relative(resolvedRepositoryRoot, targetPath)),
        reason: target === undefined ? 'missing_target' : 'content_mismatch',
      });
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    synced,
  };
}

export async function syncCommandDocs({ repositoryRoot, contract, check = false } = {}) {
  const resolvedRepositoryRoot = path.resolve(repositoryRoot);
  const preflightTargets = [];

  for (const target of COMMAND_DOC_TARGETS) {
    const targetPath = path.join(resolvedRepositoryRoot, ...target.relativePath.split('/'));
    let content;
    try {
      content = await readUtf8Strict(targetPath);
    } catch (error) {
      throw new Error(`${target.relativePath} 读取失败：${error.message}`);
    }

    const changedBlocks = [];
    for (const block of target.blocks) {
      let replacement;
      try {
        replacement = replaceGeneratedBlock(content, block.name, block.render(contract));
      } catch (error) {
        throw new Error(`${target.relativePath} [${block.name}] ${error.message}`);
      }
      if (replacement.changed) {
        changedBlocks.push(block.name);
      }
      content = replacement.content;
    }
    preflightTargets.push({
      relativePath: target.relativePath,
      targetPath,
      content,
      changedBlocks,
    });
  }

  const drift = preflightTargets.flatMap((target) => (
    target.changedBlocks.map((blockName) => ({
      relativePath: target.relativePath,
      blockName,
    }))
  ));
  if (check) {
    return { ok: drift.length === 0, drift, synced: [] };
  }

  // 所有文件和五个区块完成预检后才落盘，避免后续标记错误造成部分同步。
  for (const target of preflightTargets) {
    if (target.changedBlocks.length === 0) {
      continue;
    }
    await writeFileAtomic(target.targetPath, target.content);
  }
  return { ok: true, drift, synced: drift };
}

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
      || !RESOLVABLE_FIX_CATEGORIES.has(parts[1])
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

export async function addRule({ rootDir, knowledgeRoot, title, confirmed = false } = {}) {
  if (!title) {
    throw new Error('addRule requires a title');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const status = confirmed ? 'confirmed' : 'draft';
  const targetParts = confirmed ? ['knowledge', 'rules'] : ['inbox', 'rules'];
  const targetDir = path.join(knowledgeContext.baseDir, ...targetParts);
  const stamp = timestamp();
  const slug = slugify(title);
  const fileName = slug ? `${stamp.date}-${slug}.md` : `rule-${stamp.compact}.md`;
  const template = await readTemplate(knowledgeContext.baseDir, 'rule.md');
  const content = applyTemplateFields(template, {
    title,
    status,
    updated: stamp.isoDate,
  });
  const requestedPath = path.join(targetDir, fileName);

  await mkdir(targetDir, { recursive: true });
  const filePath = await writeUniqueFile(requestedPath, content);

  return { path: filePath };
}

export async function recordFix({ rootDir, knowledgeRoot, type, title, target } = {}) {
  if (!FIX_TYPE_DIRS[type]) {
    throw new Error('recordFix requires --type <bug|prd|tech>');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const targetInfo = target
    ? await validateFixTarget(knowledgeContext.baseDir, target)
    : null;
  const targetDir = path.join(knowledgeContext.baseDir, ...FIX_TYPE_DIRS[type]);
  const stamp = timestamp();
  const fixId = randomUUID();
  const identityPrefix = fixId.replaceAll('-', '').slice(0, 12);
  const effectiveTitle = title || `fix-${stamp.compact}`;
  const slug = title ? slugify(title) : '';
  const fileName = slug
    ? `${stamp.date}-${identityPrefix}-${slug}.md`
    : `${stamp.date}-${identityPrefix}.md`;
  const template = await readTemplate(knowledgeContext.baseDir, 'fix-record.md');
  const contentWithTemplateFields = applyTemplateFields(template, {
    title: effectiveTitle,
    type,
    status: 'pending',
    updated: stamp.isoDate,
  });
  const parsed = parseFrontmatter(contentWithTemplateFields);
  // 独立 fix 不绑定任何知识基线，即使自定义模板残留关联字段也必须移除。
  const baseFrontmatter = targetInfo
    ? parsed.frontmatter
    : parsed.frontmatter.replace(/^target(?:_hash)?:.*$\n?/gm, '').trimEnd();
  const identityFields = { fix_id: fixId };
  if (targetInfo) {
    identityFields.target = targetInfo.target;
    identityFields.target_hash = targetInfo.targetHash;
  }
  const nextFrontmatter = updateFrontmatterFields(baseFrontmatter, identityFields);
  const content = `---\n${nextFrontmatter}\n---\n${parsed.body}`;
  const requestedPath = path.join(targetDir, fileName);

  await mkdir(targetDir, { recursive: true });
  const filePath = await writeUniqueFile(requestedPath, content);

  return { path: filePath };
}

async function validateFixTarget(baseDir, target) {
  const targetPath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
  const relativeTarget = path.relative(baseDir, targetPath);
  if (!relativeTarget
      || relativeTarget === '..'
      || relativeTarget.startsWith(`..${path.sep}`)
      || path.isAbsolute(relativeTarget)) {
    throw new Error('record-fix --target 必须指向当前知识库内的 Markdown 文件');
  }

  const normalizedTarget = toPosixPath(relativeTarget);
  if (!normalizedTarget.endsWith('.md')) {
    throw new Error(`record-fix --target 不存在或不是 Markdown 文件: ${normalizedTarget}`);
  }

  let resolvedBaseDir;
  let resolvedTargetPath;
  let targetStats;
  try {
    [resolvedBaseDir, resolvedTargetPath, targetStats] = await Promise.all([
      realpath(baseDir),
      realpath(targetPath),
      stat(targetPath),
    ]);
  } catch {
    throw new Error(`record-fix --target 不存在或不是 Markdown 文件: ${normalizedTarget}`);
  }
  if (!targetStats.isFile()) {
    throw new Error(`record-fix --target 不存在或不是 Markdown 文件: ${normalizedTarget}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedBaseDir, resolvedTargetPath))) {
    throw new Error('record-fix --target 必须指向当前知识库内的 Markdown 文件');
  }

  // 状态校验与哈希必须基于同一次原始字节读取，避免元数据和内容基线不一致。
  const rawBytes = await readFile(resolvedTargetPath);
  const status = readFrontmatterField(parseFrontmatter(rawBytes.toString('utf8')).frontmatter, 'status');
  // inbox 条目尚处于评审期，人工纠正应直接收敛到原草稿，避免同一结论再生成一份待确认 fix。
  if (normalizedTarget.startsWith('inbox/') && (status === 'draft' || status === 'pending')) {
    throw new Error(`目标是未确认草稿，请直接修改原草稿，不要创建独立纠偏记录: ${normalizedTarget}`);
  }
  if (!normalizedTarget.startsWith('knowledge/')) {
    throw new Error(`record-fix --target 只能指向 knowledge/ 下已确认的知识文件: ${normalizedTarget}`);
  }
  if (status !== 'confirmed') {
    throw new Error(`knowledge/ 下的纠偏目标必须是 confirmed 状态: ${normalizedTarget}`);
  }

  return {
    target: normalizedTarget,
    targetHash: createHash('sha256').update(rawBytes).digest('hex'),
  };
}

export async function checkStale({ rootDir, knowledgeRoot, projectRoot, knowledgeFile, deep = false } = {}) {
  if (!projectRoot) {
    throw new Error('check-stale requires --project-root <path>');
  }

  if (!knowledgeFile) {
    throw new Error('check-stale requires --knowledge-file <path>');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const knowledgeFileInfo = await resolveKnowledgeMarkdownFile(
    knowledgeContext.baseDir,
    knowledgeFile,
    { command: 'check-stale', tree: 'knowledge' },
  );
  const raw = await readFile(knowledgeFileInfo.realFilePath, 'utf8');
  assertConfirmedKnowledgeFile('check-stale', knowledgeFileInfo.relativePath, raw);
  const parsed = parseFrontmatter(raw);
  const scannedCommit = readFrontmatterField(parsed.frontmatter, 'last_scanned_commit');
  const currentCommit = await readGitHead(projectRoot);
  const evidenceField = readFrontmatterField(parsed.frontmatter, 'evidence_files');
  const deepResult = deep && evidenceField ? await computeDeepStale(projectRoot, scannedCommit, evidenceField) : null;
  return {
    relativePath: knowledgeFileInfo.relativePath,
    scannedCommit,
    currentCommit,
    stale: !scannedCommit || scannedCommit !== currentCommit,
    reason: scannedCommit ? 'commit_changed' : 'missing_last_scanned_commit',
    deep: deepResult,
  };
}

// 深度过期：用 git diff 对比 last_scanned_commit..HEAD 的变更文件，与 frontmatter 的 evidence_files 求交集。
// evidence_files 为逗号分隔的相对路径列表（与简单 frontmatter 风格保持一致）。
async function computeDeepStale(projectRoot, scannedCommit, evidenceField) {
  const evidenceFiles = evidenceField.split(',').map((entry) => entry.trim()).filter(Boolean);
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', path.resolve(projectRoot), 'diff', '--name-only', `${scannedCommit}..HEAD`],
      { encoding: 'utf8' },
    );
    const changed = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean);
    const hitFiles = evidenceFiles.filter((file) => changed.some((changedFile) => changedFile.endsWith(file) || changedFile.includes(file)));
    return {
      changedCount: changed.length,
      evidenceCount: evidenceFiles.length,
      hitFiles,
      stale: hitFiles.length > 0,
    };
  } catch {
    return null;
  }
}

export async function refreshProject({
  rootDir,
  knowledgeRoot,
  projectRoot,
  knowledgeFile,
  summary,
  lockTimeoutMs = FILE_LOCK_TIMEOUT_MS,
  lockRetryDelayMs = FILE_LOCK_RETRY_DELAY_MS,
} = {}) {
  if (!projectRoot) {
    throw new Error('refresh-project requires --project-root <path>');
  }

  if (!knowledgeFile) {
    throw new Error('refresh-project requires --knowledge-file <path>');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const initialKnowledgeFileInfo = await resolveKnowledgeMarkdownFile(
    knowledgeContext.baseDir,
    knowledgeFile,
    { command: 'refresh-project', tree: 'knowledge' },
  );
  const releaseLock = await acquireAdjacentFileLock(initialKnowledgeFileInfo.filePath, {
    timeoutMs: lockTimeoutMs,
    retryDelayMs: lockRetryDelayMs,
  });

  try {
    // 必须在持锁后重新校验并读取，避免上一位写入者或路径替换改变本次更新的真实目标。
    const knowledgeFileInfo = await resolveKnowledgeMarkdownFile(
      knowledgeContext.baseDir,
      knowledgeFile,
      { command: 'refresh-project', tree: 'knowledge' },
    );
    if (knowledgeFileInfo.realFilePath !== initialKnowledgeFileInfo.realFilePath) {
      throw new Error(`refresh-project 持锁期间知识文件真实路径发生变化: ${knowledgeFileInfo.relativePath}`);
    }
    const raw = await readFile(knowledgeFileInfo.realFilePath, 'utf8');
    assertConfirmedKnowledgeFile('refresh-project', knowledgeFileInfo.relativePath, raw);
    const parsed = parseFrontmatter(raw);
    const currentCommit = await readGitHead(projectRoot);
    const stamp = timestamp();
    const nextFrontmatter = updateFrontmatterFields(parsed.frontmatter, {
      updated: stamp.isoDate,
      project_root: path.resolve(projectRoot),
      last_scanned_commit: currentCommit,
    });
    const nextBody = appendRefreshRecord(parsed.body, {
      date: stamp.isoDate,
      commit: currentCommit,
      summary,
    });

    await writeFileAtomic(knowledgeFileInfo.realFilePath, `---\n${nextFrontmatter}\n---\n${nextBody}`);

    return {
      relativePath: knowledgeFileInfo.relativePath,
      currentCommit,
      filePath: knowledgeFileInfo.realFilePath,
    };
  } finally {
    await releaseLock();
  }
}

export async function resolveFix({
  rootDir,
  knowledgeRoot,
  file,
  confirmLegacy = false,
  renameFile = rename,
  chmodFile = chmod,
  removeFile = rm,
  linkFile = link,
  hooks = {},
} = {}) {
  if (!file) {
    throw new Error('resolveFix requires --file <path>');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const sourceLocation = normalizeResolveSourceLocation(knowledgeContext.baseDir, file);
  const {
    category,
    fileName,
    relativeSource,
    filesystemIdentity,
    sourcePath,
  } = sourceLocation;
  const internalPaths = createResolveInternalPaths(knowledgeContext.baseDir, category, fileName);

  // 所有固定内部路径必须一起通过真实路径检查；否则先创建某一安全目录也会留下误导性的半状态。
  await prepareSafeResolveDirectories(knowledgeContext.baseDir, internalPaths.directories);
  const sourceIdentity = createHash('sha256').update(filesystemIdentity).digest('hex');
  const releaseLock = await acquireAdjacentFileLock(
    path.join(internalPaths.lockDir, sourceIdentity),
    { timeoutMs: FILE_LOCK_TIMEOUT_MS, retryDelayMs: FILE_LOCK_RETRY_DELAY_MS },
  );

  try {
    let state = await inspectResolveState(internalPaths, sourcePath);
    if (state.resolved) {
      return await validateCompletedResolve({
        baseDir: knowledgeContext.baseDir,
        internalPaths,
        relativeSource,
        filesystemIdentity,
        chmodFile,
        removeFile,
      });
    }
    if (state.snapshot && !state.survivor) {
      throw new Error(`resolveFix snapshot 存在但 source survivor 缺失，恢复状态不完整: ${internalPaths.snapshot}`);
    }

    if (state.claimContainer && !state.claim) {
      const entries = await inspectClaimContainerEntries(
        knowledgeContext.baseDir,
        internalPaths.claimContainer,
      );
      if (entries.length === 0 && state.source && !state.survivor && !state.snapshot) {
        // 空容器且原 source 仍在说明上次进程只完成了 mkdir；非递归删除后可安全重新认领。
        await rmdir(internalPaths.claimContainer);
        state = await inspectResolveState(internalPaths, sourcePath);
      } else {
        throw new Error(
          `resolveFix claim 恢复状态不完整，已保留恢复现场: ${internalPaths.claimContainer}`,
        );
      }
    }

    if (state.survivor && state.claimContainer) {
      await reconcileClaimWithSurvivor({
        baseDir: knowledgeContext.baseDir,
        internalPaths,
        chmodFile,
        removeFile,
      });
      state = await inspectResolveState(internalPaths, sourcePath);
    }

    if (!state.claim && !state.survivor && !state.snapshot) {
      if (!state.source) {
        throw new Error(`resolveFix source 与全部恢复工件均不存在: ${relativeSource}`);
      }
      await claimResolveSource({
        baseDir: knowledgeContext.baseDir,
        sourceLocation,
        internalPaths,
        confirmLegacy,
        renameFile,
        hooks,
      });
      state = await inspectResolveState(internalPaths, sourcePath);
    }

    if (state.claim && !state.survivor) {
      let claimedBytes;
      try {
        await inspectClaimContainer(
          knowledgeContext.baseDir,
          internalPaths.claimContainer,
          { expectedEntries: ['source.md'] },
        );
        claimedBytes = (await inspectResolveArtifact(
          knowledgeContext.baseDir,
          internalPaths.claim,
          'claim source',
        )).bytes;
        validateNewResolveFixFrontmatter(claimedBytes, relativeSource, { confirmLegacy });
      } catch (error) {
        throw new Error(`resolveFix claim 已存在但恢复校验失败: ${error.message}`, { cause: error });
      }
      const fixFields = validateNewResolveFixFrontmatter(claimedBytes, relativeSource, { confirmLegacy });
      await inspectResolveTarget(
        knowledgeContext.baseDir,
        fixFields.target,
        fixFields.targetHash,
      );
      await hooks.beforeArchiveWrite?.({
        stage: 'survivor-publish',
        parentPath: internalPaths.survivorDir,
        targetPath: internalPaths.survivor,
      });
      await assertSafeResolveParent(knowledgeContext.baseDir, internalPaths.survivorDir);
      await publishExclusiveLink(
        internalPaths.claim,
        internalPaths.survivor,
        'source survivor',
        linkFile,
      );
      await removePublishedClaimContainer(
        knowledgeContext.baseDir,
        internalPaths,
        removeFile,
      );
      state = await inspectResolveState(internalPaths, sourcePath);
    }

    if (!state.survivor) {
      throw new Error(`resolveFix source survivor 缺失，恢复状态不完整: ${relativeSource}`);
    }
    await assertSafeResolveParent(knowledgeContext.baseDir, internalPaths.survivorDir);
    await makeReadOnlyAndVerify(
      knowledgeContext.baseDir,
      internalPaths.survivor,
      'source survivor',
      chmodFile,
    );

    if (!state.snapshot) {
      const survivorBytes = (await inspectResolveArtifact(
        knowledgeContext.baseDir,
        internalPaths.survivor,
        'source survivor',
      )).bytes;
      // legacy 的人工确认只在当前未完成调用中有效，不能因上次已到 survivor 就隐式推进 snapshot。
      validateNewResolveFixFrontmatter(survivorBytes, relativeSource, { confirmLegacy });
      await publishResolveIndependentFile({
        baseDir: knowledgeContext.baseDir,
        targetPath: internalPaths.snapshot,
        content: survivorBytes,
        contentProvider: async () => (await inspectResolveArtifact(
          knowledgeContext.baseDir,
          internalPaths.survivor,
          'source survivor',
        )).bytes,
        artifactName: 'source snapshot',
        tempStage: 'snapshot-temp-write',
        linkStage: 'snapshot-link',
        hooks,
        linkFile,
      });
      state = await inspectResolveState(internalPaths, sourcePath);
    }
    await assertSafeResolveParent(knowledgeContext.baseDir, internalPaths.snapshotDir);
    await makeReadOnlyAndVerify(
      knowledgeContext.baseDir,
      internalPaths.survivor,
      'source survivor',
      chmodFile,
    );
    await makeReadOnlyAndVerify(
      knowledgeContext.baseDir,
      internalPaths.snapshot,
      'source snapshot',
      chmodFile,
    );
    const snapshotBytes = await assertResolveSourcesEqual(
      knowledgeContext.baseDir,
      internalPaths.survivor,
      internalPaths.snapshot,
    );
    const fixFields = validateNewResolveFixFrontmatter(snapshotBytes, relativeSource, { confirmLegacy });
    const targetInfo = await inspectResolveTarget(
      knowledgeContext.baseDir,
      fixFields.target,
      fixFields.targetHash,
    );
    const sourceHash = createHash('sha256').update(snapshotBytes).digest('hex');
    const fixId = fixFields.fixId || createLegacyFixId(filesystemIdentity, snapshotBytes);
    const stamp = timestamp();
    const resolvedContent = buildResolvedFixContent(snapshotBytes, {
      updated: stamp.isoDate,
      resolvedAt: new Date().toISOString(),
      resolvedTargetHash: targetInfo.currentHash,
      source: relativeSource,
      sourceSurvivor: internalPaths.relativeSurvivor,
      sourceSnapshot: internalPaths.relativeSnapshot,
      sourceHash,
      fixId,
      legacyConfirmed: fixFields.legacy,
    });
    await publishResolveIndependentFile({
      baseDir: knowledgeContext.baseDir,
      targetPath: internalPaths.resolved,
      content: resolvedContent,
      artifactName: 'resolved',
      tempStage: 'resolved-temp-write',
      linkStage: 'resolved-link',
      hooks,
      linkFile,
      preWriteCheck: () => assertResolveSourcesEqual(
        knowledgeContext.baseDir,
        internalPaths.survivor,
        internalPaths.snapshot,
      ),
    });
    // resolved 发布后再次复核，晚到写入保留在 survivor 并使当前调用显式失败。
    await assertResolveSourcesEqual(
      knowledgeContext.baseDir,
      internalPaths.survivor,
      internalPaths.snapshot,
    );

    return createResolveResult(internalPaths, relativeSource, targetInfo.currentHash, sourceHash);
  } finally {
    await releaseLock();
  }
}

async function inspectResolveState(internalPaths, sourcePath) {
  const [resolved, snapshot, survivor, claimContainer, claim, source] = await Promise.all([
    pathEntryExists(internalPaths.resolved),
    pathEntryExists(internalPaths.snapshot),
    pathEntryExists(internalPaths.survivor),
    pathEntryExists(internalPaths.claimContainer),
    pathEntryExists(internalPaths.claim),
    pathEntryExists(sourcePath),
  ]);
  return { resolved, snapshot, survivor, claimContainer, claim, source };
}

async function claimResolveSource({
  baseDir,
  sourceLocation,
  internalPaths,
  confirmLegacy,
  renameFile,
  hooks,
}) {
  const { sourcePath, relativeSource } = sourceLocation;
  // 首次态才读取 inbox source；恢复态必须由已持久化工件驱动，不能被同名新 source 干扰。
  const sourceInfo = await inspectResolveSource(baseDir, sourceLocation, { confirmLegacy });
  const fixFields = validateNewResolveFixFrontmatter(
    sourceInfo.rawBytes,
    relativeSource,
    { confirmLegacy },
  );
  await inspectResolveTarget(baseDir, fixFields.target, fixFields.targetHash);

  await assertSafeResolveParent(baseDir, internalPaths.claimDir);
  try {
    await mkdir(internalPaths.claimContainer);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`resolveFix claim 已存在，需从确定性恢复路径重试: ${internalPaths.claimContainer}`, { cause: error });
    }
    throw error;
  }
  await hooks.afterClaimContainerCreated?.({
    claimContainer: internalPaths.claimContainer,
    claimPath: internalPaths.claim,
    sourcePath,
  });
  await inspectClaimContainer(baseDir, internalPaths.claimContainer, { expectedEntries: [] });
  try {
    await renameFile(sourcePath, internalPaths.claim);
  } catch (renameError) {
    await handleClaimRenameFailure(baseDir, internalPaths.claimContainer, renameError);
  }
  const claimedBytes = await inspectClaimAfterRename(
    baseDir,
    internalPaths.claim,
    sourceInfo.rawBytes,
    relativeSource,
  );
  await hooks.afterClaimRename?.({
    claimContainer: internalPaths.claimContainer,
    claimPath: internalPaths.claim,
    sourcePath,
  });
  const claimedFields = validateNewResolveFixFrontmatter(claimedBytes, relativeSource, { confirmLegacy });
  // 认领后二次校验失败时 claim 不能反向恢复到 inbox，以免覆盖编辑器重建的新生命周期。
  await inspectResolveTarget(baseDir, claimedFields.target, claimedFields.targetHash);
}

async function reconcileClaimWithSurvivor({
  baseDir,
  internalPaths,
  chmodFile,
  removeFile,
}) {
  const entries = await inspectClaimContainerEntries(baseDir, internalPaths.claimContainer);
  if (entries.length !== 1 || entries[0] !== 'source.md') {
    throw new Error(`resolveFix claim 与 survivor 并存但 claim 容器状态不完整: ${internalPaths.claimContainer}`);
  }
  const [claimInfo, survivorInfo] = await Promise.all([
    inspectResolveArtifact(baseDir, internalPaths.claim, 'claim source'),
    inspectResolveArtifact(baseDir, internalPaths.survivor, 'source survivor'),
  ]);
  if (!sameFileIdentity(claimInfo.stats, survivorInfo.stats)) {
    throw new Error('resolveFix claim 与 source survivor 不是同一 inode，已保留两者作为冲突现场');
  }

  try {
    await removeFile(internalPaths.claim);
  } catch (error) {
    if (!['EACCES', 'EPERM'].includes(error?.code)) {
      throw error;
    }
    // Windows 可能因共享 inode 已只读而拒绝 unlink；临时放开后必须在 finally 中恢复 survivor 只读。
    try {
      await inspectResolveArtifact(baseDir, internalPaths.survivor, 'source survivor');
      await chmodFile(internalPaths.survivor, 0o666);
      await inspectResolveArtifact(baseDir, internalPaths.survivor, 'source survivor');
      await removeFile(internalPaths.claim);
    } finally {
      await makeReadOnlyAndVerify(
        baseDir,
        internalPaths.survivor,
        'source survivor',
        chmodFile,
      );
    }
  }
  await inspectClaimContainer(baseDir, internalPaths.claimContainer, { expectedEntries: [] });
  await rmdir(internalPaths.claimContainer);
  await makeReadOnlyAndVerify(
    baseDir,
    internalPaths.survivor,
    'source survivor',
    chmodFile,
  );
}

async function validateCompletedResolve({
  baseDir,
  internalPaths,
  relativeSource,
  filesystemIdentity,
  chmodFile,
  removeFile,
}) {
  // 完成态只审计三个持久化工件；目标后续删除、改回 pending 或再次变更都不能改写既有结论。
  const state = await inspectResolveState(
    internalPaths,
    path.join(baseDir, ...relativeSource.split('/')),
  );
  if (!state.survivor || !state.snapshot) {
    throw new Error('resolveFix resolved 归档存在但 survivor 或 snapshot 缺失，恢复状态不完整');
  }
  if (state.claimContainer) {
    if (!state.claim) {
      throw new Error(`resolveFix 完成态残留 claim 容器不完整: ${internalPaths.claimContainer}`);
    }
    await reconcileClaimWithSurvivor({ baseDir, internalPaths, chmodFile, removeFile });
  }

  await makeReadOnlyAndVerify(
    baseDir,
    internalPaths.survivor,
    'source survivor',
    chmodFile,
  );
  await makeReadOnlyAndVerify(
    baseDir,
    internalPaths.snapshot,
    'source snapshot',
    chmodFile,
  );
  const snapshotBytes = await assertResolveSourcesEqual(
    baseDir,
    internalPaths.survivor,
    internalPaths.snapshot,
  );
  const snapshotFields = validatePersistedSnapshotFrontmatter(snapshotBytes, relativeSource);
  const resolvedInfo = await inspectResolveArtifact(baseDir, internalPaths.resolved, 'resolved archive');
  const resolvedText = resolvedInfo.bytes.toString('utf8');
  const resolvedParsed = parseFrontmatterPreservingBody(resolvedText);
  const resolvedFields = readResolvedFrontmatter(resolvedParsed.frontmatter);
  const sourceHash = createHash('sha256').update(snapshotBytes).digest('hex');
  const expectedFixId = snapshotFields.fixId || createLegacyFixId(filesystemIdentity, snapshotBytes);

  if (resolvedFields.status !== 'resolved'
      || createFilesystemSourceIdentity(resolvedFields.source) !== filesystemIdentity
      || !sameFilesystemRelativePath(resolvedFields.sourceSurvivor, internalPaths.relativeSurvivor)
      || !sameFilesystemRelativePath(resolvedFields.sourceSnapshot, internalPaths.relativeSnapshot)
      || resolvedFields.sourceHash !== sourceHash
      || resolvedFields.fixId !== expectedFixId
      || resolvedFields.target !== snapshotFields.target
      || resolvedFields.targetHash !== snapshotFields.targetHash
      || !/^[0-9a-f]{64}$/i.test(resolvedFields.resolvedTargetHash)
      || resolvedFields.resolvedTargetHash !== resolvedFields.resolvedTargetHash.toLowerCase()
      || !/^\d{4}-\d{2}-\d{2}$/.test(resolvedFields.updated)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(resolvedFields.resolvedAt)
      || (snapshotFields.targetHash
        && resolvedFields.resolvedTargetHash.toLowerCase() === snapshotFields.targetHash)) {
    throw new Error('resolveFix resolved 归档身份字段或持久化哈希冲突');
  }
  if (snapshotFields.legacy !== (resolvedFields.legacyConfirmed === 'true')) {
    throw new Error('resolveFix resolved 归档 legacy_confirmed 与 snapshot 身份冲突');
  }

  const expectedResolved = buildResolvedFixContent(snapshotBytes, {
    updated: resolvedFields.updated,
    resolvedAt: resolvedFields.resolvedAt,
    resolvedTargetHash: resolvedFields.resolvedTargetHash,
    // 路径身份已按平台规则验证等价；逐字节重建必须使用归档持久化的展示文本。
    source: resolvedFields.source,
    sourceSurvivor: resolvedFields.sourceSurvivor,
    sourceSnapshot: resolvedFields.sourceSnapshot,
    sourceHash,
    fixId: expectedFixId,
    legacyConfirmed: snapshotFields.legacy,
  });
  if (!resolvedInfo.bytes.equals(Buffer.from(expectedResolved, 'utf8'))) {
    throw new Error('resolveFix resolved 归档完整规范化载荷与 snapshot 不一致');
  }
  const sourcePath = path.join(baseDir, ...relativeSource.split('/'));
  if (await pathEntryExists(sourcePath)) {
    throw new Error(`resolveFix 已完成 source 路径被新生命周期复用，请先重命名新 source: ${relativeSource}`);
  }

  return {
    source: resolvedFields.source,
    sourceSurvivor: resolvedFields.sourceSurvivor,
    sourceSnapshot: resolvedFields.sourceSnapshot,
    resolved: resolvedRelativePathFromPersistedSource(resolvedFields.source),
    resolvedTargetHash: resolvedFields.resolvedTargetHash.toLowerCase(),
    sourceHash,
  };
}

function validatePersistedSnapshotFrontmatter(snapshotBytes, relativeSource) {
  const parsed = parseFrontmatter(snapshotBytes.toString('utf8'));
  const status = readFrontmatterField(parsed.frontmatter, 'status');
  const target = readFrontmatterField(parsed.frontmatter, 'target');
  const fixId = readFrontmatterField(parsed.frontmatter, 'fix_id');
  const targetHash = readFrontmatterField(parsed.frontmatter, 'target_hash').toLowerCase();
  if (status !== 'pending' || !target) {
    throw new Error(`resolveFix snapshot 缺少 pending 状态或 target: ${relativeSource}`);
  }
  if (fixId && !RFC4122_UUID_PATTERN.test(fixId)) {
    throw new Error(`resolveFix snapshot 的 fix_id 非法: ${relativeSource}`);
  }
  if (targetHash && !/^[0-9a-f]{64}$/.test(targetHash)) {
    throw new Error(`resolveFix snapshot 的 target_hash 非法: ${relativeSource}`);
  }
  if (targetHash && !fixId) {
    throw new Error(`resolveFix snapshot 缺少新格式 fix_id: ${relativeSource}`);
  }
  return { target, targetHash, fixId, legacy: !targetHash };
}

function readResolvedFrontmatter(frontmatter) {
  return {
    status: readFrontmatterField(frontmatter, 'status'),
    updated: readFrontmatterField(frontmatter, 'updated'),
    resolvedAt: readFrontmatterField(frontmatter, 'resolved_at'),
    resolvedTargetHash: readFrontmatterField(frontmatter, 'resolved_target_hash'),
    source: readFrontmatterField(frontmatter, 'source'),
    sourceSurvivor: readFrontmatterField(frontmatter, 'source_survivor'),
    sourceSnapshot: readFrontmatterField(frontmatter, 'source_snapshot'),
    sourceHash: readFrontmatterField(frontmatter, 'source_hash'),
    fixId: readFrontmatterField(frontmatter, 'fix_id'),
    target: readFrontmatterField(frontmatter, 'target'),
    targetHash: readFrontmatterField(frontmatter, 'target_hash').toLowerCase(),
    legacyConfirmed: readFrontmatterField(frontmatter, 'legacy_confirmed'),
  };
}

function createLegacyFixId(filesystemIdentity, snapshotBytes) {
  // legacy 身份只由规范化 source 路径和已经独占发布的 snapshot 字节决定，跨中断重试保持稳定。
  return `legacy-${createHash('sha256')
    .update(filesystemIdentity)
    .update(Buffer.from([0]))
    .update(snapshotBytes)
    .digest('hex')}`;
}

function createResolveResult(internalPaths, relativeSource, resolvedTargetHash, sourceHash) {
  return {
    source: relativeSource,
    sourceSurvivor: internalPaths.relativeSurvivor,
    sourceSnapshot: internalPaths.relativeSnapshot,
    resolved: internalPaths.relativeResolved,
    resolvedTargetHash,
    sourceHash,
  };
}

function sameFileIdentity(leftStats, rightStats) {
  return leftStats.dev === rightStats.dev && leftStats.ino === rightStats.ino;
}

function createFilesystemSourceIdentity(relativeSource) {
  // 展示路径保留调用方大小写；只有文件系统身份在 Windows 上折叠大小写。
  return process.platform === 'win32' ? relativeSource.toLowerCase() : relativeSource;
}

function sameFilesystemRelativePath(leftPath, rightPath) {
  return createFilesystemSourceIdentity(leftPath) === createFilesystemSourceIdentity(rightPath);
}

function resolvedRelativePathFromPersistedSource(relativeSource) {
  const [, category, fileName] = relativeSource.split('/');
  return `archive/resolved/${category}/${fileName}`;
}

function isMarkdownPathForPlatform(filePath) {
  return process.platform === 'win32'
    ? filePath.toLowerCase().endsWith('.md')
    : filePath.endsWith('.md');
}

function normalizeResolveSourceLocation(baseDir, file) {
  const sourcePath = path.isAbsolute(file) ? path.resolve(file) : path.resolve(baseDir, file);
  const relativePath = path.relative(baseDir, sourcePath);
  if (!isPathWithinRoot(relativePath)) {
    throw new Error('resolveFix source 必须位于当前知识库的固定 inbox 分类内');
  }

  const relativeSource = toPosixPath(relativePath);
  const parts = relativeSource.split('/');
  if (parts.length !== 3
      || parts[0] !== 'inbox'
      || !RESOLVABLE_FIX_CATEGORIES.has(parts[1])
      || !isMarkdownPathForPlatform(parts[2])) {
    throw new Error(`resolveFix source 只允许固定分类下的直接 Markdown 文件: ${relativeSource}`);
  }

  return {
    sourcePath,
    relativeSource,
    filesystemIdentity: createFilesystemSourceIdentity(relativeSource),
    category: parts[1],
    fileName: parts[2],
  };
}

async function inspectResolveSource(baseDir, sourceLocation, { confirmLegacy }) {
  const { sourcePath, relativeSource } = sourceLocation;

  let sourceStats;
  let resolvedRoot;
  let resolvedSource;
  try {
    [sourceStats, resolvedRoot, resolvedSource] = await Promise.all([
      lstat(sourcePath),
      realpath(baseDir),
      realpath(sourcePath),
    ]);
  } catch {
    throw new Error(`resolveFix source 不存在或不是普通 Markdown 文件: ${relativeSource}`);
  }
  if (!sourceStats.isFile() || sourceStats.isSymbolicLink()) {
    throw new Error(`resolveFix source 必须是普通文件（不允许 symlink）: ${relativeSource}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedRoot, resolvedSource))) {
    throw new Error(`resolveFix source 真实路径越出当前知识库: ${relativeSource}`);
  }

  const rawBytes = await readFile(sourcePath);
  validateNewResolveFixFrontmatter(rawBytes, relativeSource, { confirmLegacy });
  return {
    rawBytes,
  };
}

function validateNewResolveFixFrontmatter(rawBytes, relativeSource, { confirmLegacy }) {
  const parsed = parseFrontmatter(rawBytes.toString('utf8'));
  const status = readFrontmatterField(parsed.frontmatter, 'status');
  if (status !== 'pending') {
    throw new Error(`resolveFix source 必须是 pending 状态: ${relativeSource}`);
  }

  const target = readFrontmatterField(parsed.frontmatter, 'target');
  if (!target) {
    throw new Error(`resolveFix source 缺少 target: ${relativeSource}`);
  }
  const fixId = readFrontmatterField(parsed.frontmatter, 'fix_id');
  const targetHash = readFrontmatterField(parsed.frontmatter, 'target_hash');
  if (fixId && !RFC4122_UUID_PATTERN.test(fixId)) {
    throw new Error(`resolveFix source 的 fix_id 必须是合法 RFC4122 UUID: ${relativeSource}`);
  }
  if (targetHash && !/^[0-9a-f]{64}$/i.test(targetHash)) {
    throw new Error(`resolveFix source 的 target_hash 必须是 64 位十六进制: ${relativeSource}`);
  }
  if (targetHash && !fixId) {
    throw new Error(`resolveFix source 缺少新格式 fix_id: ${relativeSource}`);
  }
  if (!targetHash && !confirmLegacy) {
    throw new Error(`resolveFix 旧版 source 缺少 target_hash，必须显式传入 --confirm-legacy: ${relativeSource}`);
  }

  return {
    target,
    targetHash: targetHash.toLowerCase(),
    fixId,
    legacy: !targetHash,
  };
}

function createResolveInternalPaths(baseDir, category, fileName) {
  const claimDir = path.join(baseDir, 'work', 'resolving', category);
  const claimContainer = path.join(claimDir, `${fileName}.claim`);
  const survivorDir = path.join(baseDir, 'archive', 'source-survivors', category);
  const snapshotDir = path.join(baseDir, 'archive', 'resolved-sources', category);
  const resolvedDir = path.join(baseDir, 'archive', 'resolved', category);
  const lockDir = path.join(baseDir, 'work', 'locks', 'resolve');
  const survivor = path.join(survivorDir, fileName);
  const snapshot = path.join(snapshotDir, fileName);
  const resolved = path.join(resolvedDir, fileName);

  return {
    claimDir,
    claimContainer,
    claim: path.join(claimContainer, 'source.md'),
    survivorDir,
    snapshotDir,
    resolvedDir,
    survivor,
    snapshot,
    resolved,
    lockDir,
    directories: [claimDir, survivorDir, snapshotDir, resolvedDir, lockDir],
    relativeSurvivor: toPosixPath(path.relative(baseDir, survivor)),
    relativeSnapshot: toPosixPath(path.relative(baseDir, snapshot)),
    relativeResolved: toPosixPath(path.relative(baseDir, resolved)),
  };
}

async function pathEntryExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function prepareSafeResolveDirectories(baseDir, directories) {
  const resolvedRoot = await realpath(baseDir);
  const ancestors = collectInternalDirectoryAncestors(baseDir, directories);
  await assertExistingInternalDirectoriesSafe(resolvedRoot, ancestors);

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }

  await assertExistingInternalDirectoriesSafe(resolvedRoot, ancestors, { requireAll: true });
}

function collectInternalDirectoryAncestors(baseDir, directories) {
  const ancestors = new Set();
  for (const directory of directories) {
    const relativeDirectory = path.relative(baseDir, directory);
    if (!isPathWithinRoot(relativeDirectory)) {
      throw new Error(`resolveFix 内部目录越出知识库: ${directory}`);
    }
    const parts = relativeDirectory.split(path.sep);
    for (let index = 1; index <= parts.length; index += 1) {
      ancestors.add(path.join(baseDir, ...parts.slice(0, index)));
    }
  }
  return [...ancestors].sort((left, right) => left.length - right.length);
}

async function assertExistingInternalDirectoriesSafe(resolvedRoot, ancestors, { requireAll = false } = {}) {
  for (const ancestor of ancestors) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if (error?.code === 'ENOENT' && !requireAll) {
        continue;
      }
      throw new Error(`resolveFix 内部目录不存在或不可访问: ${ancestor}`, { cause: error });
    }

    let resolvedAncestor;
    let ancestorStats;
    try {
      [resolvedAncestor, ancestorStats] = await Promise.all([realpath(ancestor), stat(ancestor)]);
    } catch (error) {
      throw new Error(`resolveFix 内部目录真实路径不可访问: ${ancestor}`, { cause: error });
    }
    if (!ancestorStats.isDirectory()
        || !isPathWithinRoot(path.relative(resolvedRoot, resolvedAncestor))) {
      throw new Error(`resolveFix 内部目录真实路径必须位于知识库内: ${ancestor}`);
    }
  }
}

async function assertSafeResolveParent(baseDir, parentPath) {
  let resolvedRoot;
  let resolvedParent;
  let parentStats;
  try {
    [resolvedRoot, resolvedParent, parentStats] = await Promise.all([
      realpath(baseDir),
      realpath(parentPath),
      stat(parentPath),
    ]);
  } catch (error) {
    throw new Error(`resolveFix 写入父目录真实路径不可访问或不在知识库内: ${parentPath}`, { cause: error });
  }
  if (!parentStats.isDirectory()
      || !isPathWithinRoot(path.relative(resolvedRoot, resolvedParent))) {
    throw new Error(`resolveFix 写入父目录真实路径必须位于知识库内: ${parentPath}`);
  }
}

async function inspectClaimContainer(baseDir, claimContainer, { expectedEntries }) {
  let containerStats;
  let resolvedRoot;
  let resolvedContainer;
  try {
    [containerStats, resolvedRoot, resolvedContainer] = await Promise.all([
      lstat(claimContainer),
      realpath(baseDir),
      realpath(claimContainer),
    ]);
  } catch (error) {
    throw new Error(`resolveFix claim 容器不可访问: ${claimContainer}`, { cause: error });
  }
  if (!containerStats.isDirectory() || containerStats.isSymbolicLink()) {
    throw new Error(`resolveFix claim 容器必须是普通目录: ${claimContainer}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedRoot, resolvedContainer))) {
    throw new Error(`resolveFix claim 容器真实路径必须位于知识库内: ${claimContainer}`);
  }

  const entries = (await readdir(claimContainer)).sort();
  const expected = expectedEntries.slice().sort();
  if (entries.length !== expected.length
      || entries.some((entry, index) => entry !== expected[index])) {
    throw new Error(`resolveFix claim 容器必须是预期的普通空目录或单一 source.md 状态: ${claimContainer}`);
  }
  return entries;
}

async function inspectClaimContainerEntries(baseDir, claimContainer) {
  let containerStats;
  let resolvedRoot;
  let resolvedContainer;
  try {
    [containerStats, resolvedRoot, resolvedContainer] = await Promise.all([
      lstat(claimContainer),
      realpath(baseDir),
      realpath(claimContainer),
    ]);
  } catch (error) {
    throw new Error(`resolveFix claim 容器不可访问: ${claimContainer}`, { cause: error });
  }
  if (!containerStats.isDirectory() || containerStats.isSymbolicLink()) {
    throw new Error(`resolveFix claim 容器必须是普通目录: ${claimContainer}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedRoot, resolvedContainer))) {
    throw new Error(`resolveFix claim 容器真实路径必须位于知识库内: ${claimContainer}`);
  }
  return (await readdir(claimContainer)).sort();
}

async function inspectResolveArtifact(baseDir, filePath, artifactName) {
  let fileStats;
  let resolvedRoot;
  let resolvedFile;
  try {
    [fileStats, resolvedRoot, resolvedFile] = await Promise.all([
      lstat(filePath),
      realpath(baseDir),
      realpath(filePath),
    ]);
  } catch (error) {
    throw new Error(`resolveFix ${artifactName} 不存在或不可访问: ${filePath}`, { cause: error });
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink() || !isMarkdownPathForPlatform(filePath)) {
    throw new Error(`resolveFix ${artifactName} 必须是普通 Markdown 文件: ${filePath}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedRoot, resolvedFile))) {
    throw new Error(`resolveFix ${artifactName} 真实路径必须位于知识库内: ${filePath}`);
  }
  return {
    bytes: await readFile(filePath),
    stats: fileStats,
  };
}

async function inspectClaimAfterRename(baseDir, claimPath, expectedBytes, relativeSource) {
  let claimStats;
  let resolvedRoot;
  let resolvedClaim;
  try {
    [claimStats, resolvedRoot, resolvedClaim] = await Promise.all([
      lstat(claimPath),
      realpath(baseDir),
      realpath(claimPath),
    ]);
  } catch (error) {
    throw new Error(`resolveFix claim 在 rename 后不可访问: ${relativeSource}`, { cause: error });
  }
  if (!claimStats.isFile() || claimStats.isSymbolicLink()) {
    throw new Error(`resolveFix claim 在 rename 后必须是普通文件（不允许 symlink）: ${relativeSource}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedRoot, resolvedClaim))) {
    throw new Error(`resolveFix claim 在 rename 后真实路径越出知识库: ${relativeSource}`);
  }

  const claimedBytes = await readFile(claimPath);
  // 前置校验与原子 rename 之间仍可能有人编辑 source，必须拒绝不同于门禁时看到的字节。
  if (!claimedBytes.equals(expectedBytes)) {
    throw new Error(`resolveFix source 在认领前发生变化: ${relativeSource}`);
  }
  return claimedBytes;
}

async function handleClaimRenameFailure(baseDir, claimContainer, renameError) {
  try {
    // rename 未发生时仅回收仍可证明为库内普通空目录的容器；任何不确定状态都保留给恢复流程。
    await inspectClaimContainer(baseDir, claimContainer, { expectedEntries: [] });
    await rmdir(claimContainer);
  } catch (cleanupError) {
    const recoveryError = new Error(
      `resolveFix claim rename 失败并已保留恢复现场；恢复路径: ${claimContainer}；`
      + `原始错误: ${renameError.message}；清理检查: ${cleanupError.message}`,
      { cause: renameError },
    );
    recoveryError.code = renameError.code;
    recoveryError.recoveryPath = claimContainer;
    recoveryError.cleanupError = cleanupError;
    throw recoveryError;
  }

  // 安全空容器已非递归删除，保留原始错误对象，调用方可按原错误码决定是否重试。
  throw renameError;
}

async function removePublishedClaimContainer(baseDir, internalPaths, removeFile = rm) {
  await inspectClaimContainer(
    baseDir,
    internalPaths.claimContainer,
    { expectedEntries: ['source.md'] },
  );
  await removeFile(internalPaths.claim);
  const entries = await inspectClaimContainer(
    baseDir,
    internalPaths.claimContainer,
    { expectedEntries: [] },
  );
  if (entries.length === 0) {
    // rmdir 只删除空目录，不会递归触碰竞态中新增的恢复证据。
    await rmdir(internalPaths.claimContainer);
  }
}

async function inspectResolveTarget(baseDir, target, baselineHash) {
  const targetPath = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseDir, target);
  const relativeTarget = path.relative(baseDir, targetPath);
  const normalizedTarget = toPosixPath(relativeTarget);
  if (!isPathWithinRoot(relativeTarget)
      || !normalizedTarget.startsWith('knowledge/')
      || !targetPath.endsWith('.md')) {
    throw new Error(`resolveFix target 必须位于正式 knowledge/ 下且是 Markdown 普通文件: ${target}`);
  }

  let resolvedKnowledgeRoot;
  let resolvedTarget;
  let targetStats;
  try {
    [resolvedKnowledgeRoot, resolvedTarget, targetStats] = await Promise.all([
      realpath(path.join(baseDir, 'knowledge')),
      realpath(targetPath),
      stat(targetPath),
    ]);
  } catch {
    throw new Error(`resolveFix target 不存在或不是 Markdown 普通文件: ${target}`);
  }
  if (!targetStats.isFile() || !resolvedTarget.endsWith('.md')) {
    throw new Error(`resolveFix target 不是 Markdown 普通文件: ${target}`);
  }
  if (!isPathWithinRoot(path.relative(resolvedKnowledgeRoot, resolvedTarget))) {
    throw new Error(`resolveFix target 真实路径必须位于正式 knowledge/ 知识库内: ${target}`);
  }

  const currentBytes = await readFile(resolvedTarget);
  const status = readFrontmatterField(
    parseFrontmatter(currentBytes.toString('utf8')).frontmatter,
    'status',
  );
  if (status !== 'confirmed') {
    throw new Error(`resolveFix target 必须保持 confirmed 状态: ${target}`);
  }
  const currentHash = createHash('sha256').update(currentBytes).digest('hex');
  if (baselineHash && currentHash === baselineHash) {
    throw new Error(`resolveFix target 哈希相同，目标内容未变化: ${target}`);
  }

  return { currentHash };
}

async function publishExclusiveLink(sourcePath, targetPath, artifactName, linkFile = link) {
  try {
    await linkFile(sourcePath, targetPath);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw new Error(`resolveFix ${artifactName} 已存在: ${targetPath}`, { cause: error });
    }
    throw error;
  }
}

async function makeReadOnlyAndVerify(baseDir, filePath, artifactName, chmodFile = chmod) {
  // chmod 会跟随 symlink/junction；必须在产生副作用前拒绝库外或非普通 Markdown 工件。
  await inspectResolveArtifact(baseDir, filePath, artifactName);
  await chmodFile(filePath, 0o444);
  // 写后再次复核类型与真实路径，防止把创建时的安全检查当作持久事实。
  const fileInfo = await inspectResolveArtifact(baseDir, filePath, artifactName);
  if ((fileInfo.stats.mode & 0o222) !== 0) {
    throw new Error(`resolveFix 无法确认只读归档: ${filePath}`);
  }
}

async function publishResolveIndependentFile({
  baseDir,
  targetPath,
  content,
  artifactName,
  tempStage,
  linkStage,
  hooks,
  linkFile = link,
  preWriteCheck,
  contentProvider,
}) {
  const parentPath = path.dirname(targetPath);
  await hooks.beforeArchiveWrite?.({ stage: tempStage, parentPath, targetPath });
  await assertSafeResolveParent(baseDir, parentPath);
  await preWriteCheck?.();
  // snapshot 在真正写临时文件前重新读取 survivor，使此前已发生的晚到写入进入本次固定快照。
  const publishContent = contentProvider ? await contentProvider() : content;
  const temporaryPath = await writeUniqueFile(createTemporaryPath(targetPath, artifactName), publishContent);
  try {
    await hooks.beforeArchiveWrite?.({
      stage: linkStage,
      parentPath,
      targetPath,
      temporaryPath,
    });
    await assertSafeResolveParent(baseDir, parentPath);
    await publishExclusiveLink(temporaryPath, targetPath, artifactName, linkFile);
    await hooks.afterArchivePublished?.({
      stage: linkStage,
      parentPath,
      targetPath,
      temporaryPath,
    });
  } finally {
    await removeResolveTemporaryFileIfParentSafe(baseDir, temporaryPath);
  }
}

async function removeResolveTemporaryFileIfParentSafe(baseDir, temporaryPath) {
  try {
    // 父目录若已被换成外部 junction，按旧路径清理会误删外部同名文件，此时必须保留恢复证据。
    await assertSafeResolveParent(baseDir, path.dirname(temporaryPath));
  } catch {
    return;
  }
  // 删除临时名称后，归档目标保留独立 inode，不能与 survivor 共享可变底层对象。
  await rm(temporaryPath, { force: true }).catch(() => {});
}

async function assertResolveSourcesEqual(baseDir, survivorPath, snapshotPath) {
  const [survivorInfo, snapshotInfo] = await Promise.all([
    inspectResolveArtifact(baseDir, survivorPath, 'source survivor'),
    inspectResolveArtifact(baseDir, snapshotPath, 'source snapshot'),
  ]);
  if (sameFileIdentity(survivorInfo.stats, snapshotInfo.stats)) {
    throw new Error('resolveFix source survivor 与 source snapshot 必须使用不同 inode');
  }
  if (!survivorInfo.bytes.equals(snapshotInfo.bytes)) {
    throw new Error('resolveFix source survivor 与 source snapshot 字节不一致');
  }
  return snapshotInfo.bytes;
}

function buildResolvedFixContent(snapshotBytes, fields) {
  const snapshotText = snapshotBytes.toString('utf8');
  const parsed = parseFrontmatterPreservingBody(snapshotText);
  let nextFrontmatter = updateFrontmatterFields(parsed.frontmatter, {
    status: 'resolved',
    updated: fields.updated,
    resolved_at: fields.resolvedAt,
    resolved_target_hash: fields.resolvedTargetHash,
    source: fields.source,
    source_survivor: fields.sourceSurvivor,
    source_snapshot: fields.sourceSnapshot,
    source_hash: fields.sourceHash,
  });
  if (!readFrontmatterField(nextFrontmatter, 'fix_id')) {
    nextFrontmatter = updateFrontmatterFields(nextFrontmatter, { fix_id: fields.fixId });
  }
  if (fields.legacyConfirmed) {
    nextFrontmatter = updateFrontmatterFields(nextFrontmatter, { legacy_confirmed: true });
  }
  return `---\n${nextFrontmatter}\n---\n${parsed.body}`;
}

function parseFrontmatterPreservingBody(raw) {
  const newline = raw.startsWith('---\r\n') ? '\r\n' : raw.startsWith('---\n') ? '\n' : '';
  if (!newline) {
    throw new Error('resolveFix source 缺少完整 frontmatter');
  }
  const openingLength = 3 + newline.length;
  const closingMarker = `${newline}---${newline}`;
  const closingIndex = raw.indexOf(closingMarker, openingLength);
  if (closingIndex === -1) {
    throw new Error('resolveFix source 缺少完整 frontmatter');
  }
  return {
    frontmatter: raw.slice(openingLength, closingIndex).replace(/\r\n/g, '\n'),
    body: raw.slice(closingIndex + closingMarker.length),
  };
}

// 晋升：将 inbox 下的待确认文件移动到 knowledge 对应子目录，frontmatter status 改为 confirmed。
// 目录映射规则：inbox/<sub>/file.md -> knowledge/<sub>/file.md（sub 为 inbox 下的即时子目录）。
export async function promote({ rootDir, knowledgeRoot, file, linkFile = link } = {}) {
  if (!file) {
    throw new Error('promote requires --file <path>');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const sourceInfo = await resolveKnowledgeMarkdownFile(
    knowledgeContext.baseDir,
    file,
    { command: 'promote', tree: 'inbox' },
  );
  const sourcePath = sourceInfo.realFilePath;
  const raw = await readFile(sourcePath, 'utf8');
  const parsed = parseFrontmatter(raw);
  const relativeSource = sourceInfo.relativePath;
  if (readFrontmatterField(parsed.frontmatter, 'target')) {
    // targeted fix 必须回写原知识并留下快照审计，通用 promote 会制造第二份正式知识。
    throw new Error(
      'promote 不能晋升带非空 target 的 targeted fix；请先修改目标正式知识，再执行 resolve-fix 完成归档',
    );
  }

  const subPath = relativeSource.slice('inbox/'.length);
  const subDir = path.dirname(subPath);
  const targetDir = path.join(knowledgeContext.baseDir, 'knowledge', subDir);
  await prepareKnowledgeDirectory(knowledgeContext.baseDir, targetDir, 'promote');
  const targetPath = path.join(targetDir, path.basename(sourcePath));
  const nextFrontmatter = updateFrontmatterFields(parsed.frontmatter, { status: 'confirmed' });
  const content = `---\n${nextFrontmatter}\n---\n${parsed.body}`;
  const temporaryPath = await writeUniqueFile(createTemporaryPath(targetPath, 'promote'), content);

  try {
    // 同目录硬链接只在目标不存在时成功，消除“先检查再写入”的并发覆盖窗口。
    try {
      await linkFile(temporaryPath, targetPath);
    } catch (error) {
      if (error?.code === 'EEXIST') {
        throw new Error(
          `promote target already exists: ${toPosixPath(path.relative(knowledgeContext.baseDir, targetPath))}`,
          { cause: error },
        );
      }
      throw error;
    }

    // 目标独占发布成功后才删除源文件；发布失败时源文件保持不变。
    await rm(sourcePath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => {});
  }

  const relativeTarget = toPosixPath(path.relative(knowledgeContext.baseDir, targetPath));
  return {
    source: relativeSource,
    target: relativeTarget,
    filePath: targetPath,
  };
}

// 待确认清单：遍历 inbox/ 下所有 .md，输出相对路径、status、type 与最后修改时间，便于发现堆积项。
export async function listPending({ rootDir, knowledgeRoot } = {}) {
  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const inboxDir = path.join(knowledgeContext.baseDir, 'inbox');
  const items = [];

  if (existsSync(inboxDir)) {
    await collectPendingUnder(inboxDir, knowledgeContext.baseDir, items);
  }

  return items.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function collectPendingUnder(dir, baseDir, items) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectPendingUnder(entryPath, baseDir, items);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const raw = await readFile(entryPath, 'utf8');
      const parsed = parseFrontmatter(raw);
      const fm = parsed.frontmatter;
      const status = readFrontmatterField(fm, 'status');
      if (!status) {
        continue;
      }
      const stats = await stat(entryPath);
      items.push({
        relativePath: toPosixPath(path.relative(baseDir, entryPath)),
        status,
        type: readFrontmatterField(fm, 'type') || '',
        updated: readFrontmatterField(fm, 'updated') || '',
        mtime: stats.mtime.toISOString(),
      });
    }
  }
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
