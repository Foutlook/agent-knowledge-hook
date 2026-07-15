import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  collectMarkdownFiles,
  hasFrontmatterField,
  inspectMarkdownCollectionPath,
  isExistingDirectory,
  isExistingFileWithinRealRoot,
  isPathWithinRoot,
  parseFrontmatter,
  readFrontmatterField,
  resolveKnowledgeContext,
  resolveRealPathIfExists,
  resolveRootDir,
  toPosixPath,
} from './knowledge-files.js';
import {
  isProcessAlive,
  parseLockContent,
  RFC4122_UUID_PATTERN,
} from './locks.js';
import { syncAdapters } from './repository-maintenance.js';
import { TARGETED_FIX_CATEGORIES } from './targeted-fix-contract.js';

const ADJACENT_LOCK_FILE_PATTERN = /\.md\.lock(?:\.reclaim)?$/;
const RESOLVE_LOCK_FILE_PATTERN = /^[0-9a-f]{64}\.lock(?:\.reclaim)?$/;

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

async function readDoctorMarkdownFile(baseDir, resolvedBaseDir, filePath) {
  if (!filePath.endsWith('.md')) {
    return null;
  }
  const fileInfo = await inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, filePath);
  if (!fileInfo?.stats.isFile()) {
    return null;
  }

  // 读取前复核能拒绝既存或已完成的链接替换；零依赖 Node 无法封闭复核与 readFile syscall 之间的恶意竞态。
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
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
