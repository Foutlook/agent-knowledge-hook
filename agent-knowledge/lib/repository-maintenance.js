import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  renderAkCommandTable,
  renderCliCommandList,
  renderCliCommandTable,
  readUtf8Strict,
  replaceGeneratedBlock,
} from './command-contract.js';
import {
  resolveRootDir,
  toPosixPath,
  writeFileAtomic,
} from './knowledge-files.js';

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
