import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  appendRefreshRecord,
  applyTemplateFields,
  assertConfirmedKnowledgeFile,
  createTemporaryPath,
  isPathWithinRoot,
  parseFrontmatter,
  prepareKnowledgeDirectory,
  readFrontmatterField,
  readGitHead,
  readTemplate,
  resolveKnowledgeContext,
  resolveKnowledgeMarkdownFile,
  slugify,
  timestamp,
  toPosixPath,
  updateFrontmatterFields,
  writeFileAtomic,
  writeUniqueFile,
} from './knowledge-files.js';
import {
  acquireAdjacentFileLock,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
} from './locks.js';

const FIX_TYPE_DIRS = {
  bug: ['inbox', 'fixes'],
  prd: ['inbox', 'prd-corrections'],
  tech: ['inbox', 'tech-solution-corrections'],
};

const execFileAsync = promisify(execFile);

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
