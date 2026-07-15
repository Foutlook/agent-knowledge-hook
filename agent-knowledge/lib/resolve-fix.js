import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

import {
  createTemporaryPath,
  isPathWithinRoot,
  parseFrontmatter,
  readFrontmatterField,
  resolveKnowledgeContext,
  timestamp,
  toPosixPath,
  updateFrontmatterFields,
  writeUniqueFile,
} from './knowledge-files.js';
import {
  acquireAdjacentFileLock,
  FILE_LOCK_RETRY_DELAY_MS,
  FILE_LOCK_TIMEOUT_MS,
  RFC4122_UUID_PATTERN,
} from './locks.js';

const RESOLVABLE_FIX_CATEGORIES = new Set([
  'fixes',
  'prd-corrections',
  'tech-solution-corrections',
]);

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

