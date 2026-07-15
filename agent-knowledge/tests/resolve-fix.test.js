import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, readdir, readFile, rename, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { listPending, recordFix, searchKnowledge } from '../bin/agent-knowledge.js';
import * as agentKnowledgeModule from '../bin/agent-knowledge.js';
import {
  createDirectoryLink,
  createTempRoot,
  execFileAsync,
  repoRoot,
  runCli,
  runCliFailure,
  writeExternalKnowledgeFile,
  writePendingFix,
} from './test-helpers.js';

async function createResolvableFix(knowledgeRoot, { type = 'bug', title = 'resolve lifecycle' } = {}) {
  const originalTargetContent = [
    '---',
    'title: resolve target',
    'status: confirmed',
    '---',
    '',
    '# resolve target',
    '',
    'original target body',
    '',
  ].join('\n');
  const targetPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/resolve-target.md',
    originalTargetContent,
  );
  const fix = await recordFix({
    knowledgeRoot,
    type,
    title,
    target: 'knowledge/rules/resolve-target.md',
  });

  return {
    sourcePath: fix.path,
    sourceRelative: path.relative(knowledgeRoot, fix.path).replaceAll('\\', '/'),
    targetPath,
    originalTargetContent,
  };
}

function resolveFix(options) {
  return agentKnowledgeModule.resolveFix(options);
}

function resolutionArtifactPaths(knowledgeRoot, sourcePath) {
  const category = path.basename(path.dirname(sourcePath));
  const fileName = path.basename(sourcePath);
  const claimContainer = path.join(knowledgeRoot, 'work', 'resolving', category, `${fileName}.claim`);
  return {
    claimContainer,
    claim: path.join(claimContainer, 'source.md'),
    survivor: path.join(knowledgeRoot, 'archive', 'source-survivors', category, fileName),
    snapshot: path.join(knowledgeRoot, 'archive', 'resolved-sources', category, fileName),
    resolved: path.join(knowledgeRoot, 'archive', 'resolved', category, fileName),
  };
}

function windowsSourceCaseVariant(relativeSource) {
  const parts = relativeSource.split('/');
  const fileName = parts.at(-1);
  parts[parts.length - 1] = fileName.toUpperCase();
  return parts.join('/');
}

function assertNoResolutionArtifacts(knowledgeRoot, sourcePath) {
  for (const artifactPath of Object.values(resolutionArtifactPaths(knowledgeRoot, sourcePath))) {
    assert.ok(!existsSync(artifactPath), `unexpected resolve artifact: ${artifactPath}`);
  }
}

async function assertResolveLockReleased(knowledgeRoot) {
  const lockDir = path.join(knowledgeRoot, 'work', 'locks', 'resolve');
  if (existsSync(lockDir)) {
    assert.deepEqual(await readdir(lockDir), []);
  }
}

async function swapDirectoryForExternalLink(t, directory, outsideRoot) {
  const backupDirectory = `${directory}.safe-backup`;
  await rename(directory, backupDirectory);
  const linked = await createDirectoryLink(t, outsideRoot, directory);
  return { backupDirectory, linked };
}

async function changeResolvableTarget(fix, body = 'human reviewed target body') {
  const content = [
    '---',
    'title: resolve target',
    'status: confirmed',
    '---',
    '',
    '# resolve target',
    '',
    body,
    '',
  ].join('\n');
  await writeFile(fix.targetPath, content, 'utf8');
  return Buffer.from(content, 'utf8');
}

async function interruptResolveAt(knowledgeRoot, fix, stage) {
  const interruption = new Error(`interrupt at ${stage}`);
  const hooks = stage === 'after-claim'
    ? { afterClaimRename: async () => { throw interruption; } }
    : {
        beforeArchiveWrite: async ({ stage: currentStage }) => {
          if (currentStage === stage) {
            throw interruption;
          }
        },
      };
  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative, hooks }),
    (error) => error === interruption,
  );
}

async function writeLegacyTargetedFix(knowledgeRoot, relativePath, { fixId = '' } = {}) {
  const targetContent = [
    '---',
    'title: legacy target',
    'status: confirmed',
    '---',
    '',
    '# legacy target',
    '',
    'legacy target already reviewed',
    '',
  ].join('\n');
  await writeExternalKnowledgeFile(knowledgeRoot, 'knowledge/rules/legacy-target.md', targetContent);
  const content = [
    '---',
    'title: legacy correction',
    'type: bug',
    'status: pending',
    'updated: 2026-07-13',
    ...(fixId ? [`fix_id: ${fixId}`] : []),
    'target: knowledge/rules/legacy-target.md',
    '---',
    '',
    '# legacy correction',
    '',
    'legacy source body',
    '',
  ].join('\n');
  const sourcePath = await writeExternalKnowledgeFile(knowledgeRoot, relativePath, content);
  return {
    sourcePath,
    sourceRelative: relativePath,
    sourceBytes: Buffer.from(content, 'utf8'),
  };
}

test('ak.ps1 resolve forwards exactly one file and optional legacy confirmation', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const fakeBin = await createTempRoot();
  const arbitraryCwd = await createTempRoot();
  const knowledgeRoot = path.join(arbitraryCwd, 'knowledge root');
  const source = 'inbox/tech-solution-corrections/fix with spaces.md';
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    AGENT_KNOWLEDGE_ROOT: knowledgeRoot,
    [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
  };
  await writeFile(path.join(fakeBin, 'node.cmd'), '@echo off\r\necho %*\r\n', 'utf8');

  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'resolve',
    source,
    '--confirm-legacy',
  ], {
    cwd: arbitraryCwd,
    encoding: 'utf8',
    env,
  });

  assert.match(stdout, /resolve-fix/);
  assert.match(stdout, /--file/);
  assert.ok(stdout.includes(source), stdout);
  assert.equal((stdout.match(/--confirm-legacy/g) ?? []).length, 1);
  assert.ok(stdout.includes(knowledgeRoot), stdout);

  const withoutLegacy = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    'resolve',
    source,
  ], {
    cwd: arbitraryCwd,
    encoding: 'utf8',
    env,
  });
  assert.equal((withoutLegacy.stdout.match(/--confirm-legacy/g) ?? []).length, 0);
});

test('ak.ps1 resolve rejects missing, empty, duplicate, and unknown arguments before invoking node', {
  skip: process.platform !== 'win32',
}, async () => {
  const scriptPath = path.join(repoRoot, 'agent-knowledge', 'bin', 'ak.ps1');
  const fakeBin = await createTempRoot();
  const arbitraryCwd = await createTempRoot();
  const knowledgeRoot = path.join(arbitraryCwd, 'knowledge-root');
  const markerPath = path.join(fakeBin, 'node-called.txt');
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    AK_NODE_MARKER: markerPath,
    AGENT_KNOWLEDGE_ROOT: knowledgeRoot,
    [pathKey]: `${fakeBin}${path.delimiter}${process.env[pathKey] ?? ''}`,
  };
  await writeFile(
    path.join(fakeBin, 'node.cmd'),
    '@echo off\r\ntype nul > "%AK_NODE_MARKER%"\r\nexit /b 0\r\n',
    'utf8',
  );
  const invalidArguments = [
    [],
    [''],
    ['--confirm-legacy'],
    ['inbox/fixes/one.md', 'inbox/fixes/two.md'],
    ['inbox/fixes/one.md', '--confirm-legacy', '--confirm-legacy'],
    ['inbox/fixes/one.md', '--unknown'],
    ['--confirm-legacy', 'inbox/fixes/one.md'],
  ];

  for (const rest of invalidArguments) {
    let result;
    try {
      result = { code: 0, ...await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
        'resolve',
        ...rest,
      ], {
        cwd: arbitraryCwd,
        encoding: 'utf8',
        env,
      }) };
    } catch (error) {
      result = error;
    }

    assert.notEqual(result.code, 0, `expected rejection for: ${rest.join(' ')}`);
    const output = `${result.stderr}${result.stdout}`;
    assert.match(output, /ak resolve/i);
    assert.doesNotMatch(output, /Unknown ak command/i);
    assert.equal(existsSync(markerPath), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'archive')), false);
  }
});

test('CLI resolve-fix publishes a fix and clearly reports source, snapshot, and resolved paths', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'CLI resolve lifecycle' });
  await changeResolvableTarget(fix, 'CLI merged target body');

  const { stdout, stderr } = await runCli([
    'resolve-fix',
    '--file',
    fix.sourceRelative,
    '--knowledge-root',
    knowledgeRoot,
  ]);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  assert.equal(stderr, '');
  assert.match(stdout, /source/i);
  assert.ok(stdout.includes(fix.sourceRelative), stdout);
  assert.match(stdout, /snapshot/i);
  assert.match(stdout, /resolved/i);
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
});

test('CLI resolve-fix forwards explicit legacy confirmation', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/cli-legacy.md',
  );

  const { stdout, stderr } = await runCli([
    'resolve-fix',
    '--file',
    legacy.sourceRelative,
    '--confirm-legacy',
    '--knowledge-root',
    knowledgeRoot,
  ]);

  assert.equal(stderr, '');
  assert.match(stdout, /archive\/resolved\/fixes\/cli-legacy\.md/);
  assert.ok(existsSync(path.join(knowledgeRoot, 'archive', 'resolved', 'fixes', 'cli-legacy.md')));
});

test('CLI resolve-fix rejects missing, empty, duplicate, and unknown arguments without writing', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'strict CLI resolve arguments' });
  await changeResolvableTarget(fix, 'strict parser should reject before resolution');
  const sourceBefore = await readFile(fix.sourcePath, 'utf8');
  const invalidArguments = [
    [],
    ['--file'],
    ['--file', ''],
    ['--file='],
    ['--file', '--confirm-legacy'],
    ['--file', fix.sourceRelative, '--file', fix.sourceRelative],
    [`--file=${fix.sourceRelative}`, `--file=${fix.sourceRelative}`],
    ['--file', fix.sourceRelative, '--confirm-legacy', '--confirm-legacy'],
    ['--file', fix.sourceRelative, '--unknown'],
    [fix.sourceRelative],
    ['--file', fix.sourceRelative, '--json'],
  ];

  for (const commandArgs of invalidArguments) {
    const error = await runCliFailure([
      'resolve-fix',
      ...commandArgs,
      '--knowledge-root',
      knowledgeRoot,
    ]);

    assert.equal(error.code, 1, `expected rejection for: ${commandArgs.join(' ')}`);
    const output = `${error.stderr}${error.stdout}`;
    assert.match(output, /resolve-fix/i);
    assert.doesNotMatch(output, /未知命令|unknown command/i);
    assert.equal(await readFile(fix.sourcePath, 'utf8'), sourceBefore);
    assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
    assert.equal(existsSync(path.join(knowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'archive')), false);
  }
});

test('CLI resolve-fix rejects repository-root and duplicate knowledge-root before resolution', async () => {
  const argumentVariants = [
    ({ knowledgeRoot, bogusRepositoryRoot }) => [
      '--repository-root',
      bogusRepositoryRoot,
      '--knowledge-root',
      knowledgeRoot,
    ],
    ({ knowledgeRoot }) => [
      '--knowledge-root',
      knowledgeRoot,
      `--knowledge-root=${knowledgeRoot}`,
    ],
    ({ knowledgeRoot, otherKnowledgeRoot }) => [
      `--knowledge-root=${knowledgeRoot}`,
      '--knowledge-root',
      otherKnowledgeRoot,
    ],
  ];

  for (const buildGlobalArguments of argumentVariants) {
    const knowledgeRoot = await createTempRoot();
    const otherKnowledgeRoot = await createTempRoot();
    const bogusRepositoryRoot = path.join(await createTempRoot(), 'missing-repository');
    const fix = await createResolvableFix(knowledgeRoot, { title: 'strict global resolve arguments' });
    await changeResolvableTarget(fix, 'global options must be rejected before resolveFix');
    const sourceBefore = await readFile(fix.sourcePath, 'utf8');
    const globalArguments = buildGlobalArguments({
      knowledgeRoot,
      otherKnowledgeRoot,
      bogusRepositoryRoot,
    });

    const error = await runCliFailure([
      'resolve-fix',
      '--file',
      fix.sourceRelative,
      ...globalArguments,
    ]);
    const output = `${error.stderr}${error.stdout}`;

    assert.equal(error.code, 1);
    assert.match(output, /resolve-fix/i);
    assert.match(output, /--repository-root|--knowledge-root/i);
    assert.equal(await readFile(fix.sourcePath, 'utf8'), sourceBefore);
    assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
    assert.equal(existsSync(path.join(knowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(knowledgeRoot, 'archive')), false);
    assert.equal(existsSync(path.join(otherKnowledgeRoot, 'work')), false);
    assert.equal(existsSync(path.join(otherKnowledgeRoot, 'archive')), false);
  }
});

test('resolveFix happy publishes immutable source artifacts without rewriting the confirmed target', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot);
  const sourceBytes = await readFile(fix.sourcePath);
  const sourceText = sourceBytes.toString('utf8');
  const changedTargetContent = [
    '---',
    'title: resolve target',
    'status: confirmed',
    '---',
    '',
    '# resolve target',
    '',
    'human reviewed target body',
    '',
  ].join('\n');
  await writeFile(fix.targetPath, changedTargetContent, 'utf8');
  const targetBytesBeforeResolve = await readFile(fix.targetPath);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  const result = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

  assert.deepEqual(await readFile(fix.targetPath), targetBytesBeforeResolve, 'resolveFix must not rewrite target');
  assert.ok(!existsSync(fix.sourcePath));
  assert.ok(!existsSync(artifacts.claim));
  assert.ok(!existsSync(artifacts.claimContainer));
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
  const survivorBytes = await readFile(artifacts.survivor);
  const snapshotBytes = await readFile(artifacts.snapshot);
  assert.deepEqual(survivorBytes, sourceBytes);
  assert.deepEqual(snapshotBytes, sourceBytes);
  assert.notEqual((await stat(artifacts.survivor)).ino, (await stat(artifacts.snapshot)).ino);
  assert.equal((await stat(artifacts.survivor)).mode & 0o222, 0);
  assert.equal((await stat(artifacts.snapshot)).mode & 0o222, 0);

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  const fixId = sourceText.match(/^fix_id: (.+)$/m)[1];
  const target = sourceText.match(/^target: (.+)$/m)[1];
  const targetHash = sourceText.match(/^target_hash: (.+)$/m)[1];
  const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const resolvedTargetHash = createHash('sha256').update(targetBytesBeforeResolve).digest('hex');
  assert.match(resolvedContent, /^status: resolved$/m);
  assert.match(resolvedContent, /^updated: \d{4}-\d{2}-\d{2}$/m);
  assert.match(resolvedContent, /^resolved_at: \d{4}-\d{2}-\d{2}T.+Z$/m);
  assert.match(resolvedContent, new RegExp(`^fix_id: ${fixId}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^target: ${target}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^target_hash: ${targetHash}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^resolved_target_hash: ${resolvedTargetHash}$`, 'm'));
  assert.match(resolvedContent, new RegExp(`^source: ${fix.sourceRelative.replaceAll('/', '\\/')}$`, 'm'));
  assert.match(resolvedContent, /^source_survivor: archive\/source-survivors\/fixes\/.+\.md$/m);
  assert.match(resolvedContent, /^source_snapshot: archive\/resolved-sources\/fixes\/.+\.md$/m);
  assert.match(resolvedContent, new RegExp(`^source_hash: ${sourceHash}$`, 'm'));
  assert.match(resolvedContent, /fix body must survive resolution|证据链/);
  assert.equal(result.source, fix.sourceRelative);
  assert.equal(result.sourceSurvivor, path.relative(knowledgeRoot, artifacts.survivor).replaceAll('\\', '/'));
  assert.equal(result.sourceSnapshot, path.relative(knowledgeRoot, artifacts.snapshot).replaceAll('\\', '/'));
  assert.equal(result.resolved, path.relative(knowledgeRoot, artifacts.resolved).replaceAll('\\', '/'));
  assert.deepEqual(await searchKnowledge({ knowledgeRoot, query: '证据链' }), []);
  assert.deepEqual(await listPending({ knowledgeRoot }), []);
});

test('resolveFix happy atomically renames source into the deterministic claim container', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'claim container rename' });
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const renameCalls = [];

  await resolveFix({
    knowledgeRoot,
    file: fix.sourceRelative,
    renameFile: async (sourcePath, claimPath) => {
      renameCalls.push([sourcePath, claimPath]);
      await rename(sourcePath, claimPath);
    },
  });

  assert.deepEqual(renameCalls, [[fix.sourcePath, artifacts.claim]]);
  assert.ok(!existsSync(artifacts.claimContainer));
});

test('resolveFix source removes a safe empty claim container after rename EBUSY or EACCES and allows retry', async () => {
  for (const errorCode of ['EBUSY', 'EACCES']) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `rename-retry-${errorCode}` });
    const sourceBytes = await readFile(fix.sourcePath);
    await writeFile(
      fix.targetPath,
      ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
      'utf8',
    );
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const renameError = new Error(`simulated rename ${errorCode}`);
    renameError.code = errorCode;

    await assert.rejects(
      resolveFix({
        knowledgeRoot,
        file: fix.sourceRelative,
        renameFile: async () => {
          throw renameError;
        },
      }),
      (error) => error === renameError,
      errorCode,
    );

    assert.deepEqual(await readFile(fix.sourcePath), sourceBytes, errorCode);
    assert.ok(!existsSync(artifacts.claimContainer), errorCode);
    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    assert.ok(existsSync(artifacts.resolved), errorCode);
  }
});

test('resolveFix source preserves a non-empty claim container when rename fails and reports recovery path', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'rename-non-empty-recovery' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const recoveryEvidence = path.join(artifacts.claimContainer, 'manual-evidence.txt');
  const renameError = new Error('simulated rename blocked by recovery evidence');
  renameError.code = 'EBUSY';
  let caughtError;

  try {
    await resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      renameFile: async () => {
        await writeFile(recoveryEvidence, 'retain me\n', { flag: 'wx' });
        throw renameError;
      },
    });
  } catch (error) {
    caughtError = error;
  }

  assert.ok(caughtError);
  assert.equal(caughtError.cause, renameError);
  assert.match(caughtError.message, /恢复路径|恢复现场/);
  assert.match(caughtError.message, new RegExp(path.basename(artifacts.claimContainer).replaceAll('.', '\\.')));
  assert.match(caughtError.message, /simulated rename blocked/);
  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.equal(await readFile(recoveryEvidence, 'utf8'), 'retain me\n');
  assert.ok(existsSync(artifacts.claimContainer));
});

test('resolveFix source preserves an unsafe claim container path when rename fails and reports recovery path', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'rename-unsafe-recovery' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const renameError = new Error('simulated access denied after junction replacement');
  renameError.code = 'EACCES';
  let linkUnavailable = false;
  let caughtError;

  try {
    await resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      renameFile: async () => {
        await rmdir(artifacts.claimContainer);
        if (!await createDirectoryLink(t, outsideRoot, artifacts.claimContainer)) {
          linkUnavailable = true;
        }
        throw renameError;
      },
    });
  } catch (error) {
    caughtError = error;
  }
  if (linkUnavailable) {
    return;
  }

  assert.ok(caughtError);
  assert.equal(caughtError.cause, renameError);
  assert.match(caughtError.message, /恢复路径|恢复现场/);
  assert.match(caughtError.message, /simulated access denied/);
  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.deepEqual(await readdir(outsideRoot), []);
  assert.ok(existsSync(artifacts.claimContainer));
});

test('resolveFix happy preserves a new inbox source recreated after claim rename', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'source recreation' });
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const recreatedSource = Buffer.from('new source created by editor\n', 'utf8');

  await resolveFix({
    knowledgeRoot,
    file: fix.sourceRelative,
    renameFile: async (sourcePath, claimPath) => {
      await rename(sourcePath, claimPath);
      await writeFile(sourcePath, recreatedSource, { flag: 'wx' });
    },
  });

  assert.deepEqual(await readFile(fix.sourcePath), recreatedSource);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
});

test('resolveFix unchanged rejects an untouched target and safely restores the pending source', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot);
  const sourceBytes = await readFile(fix.sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
    /target.*未变化|目标.*未变化|哈希.*相同/,
  );

  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
});

test('resolveFix target second validation failure keeps the claim and never restores inbox source', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'second target validation' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterClaimRename: async () => {
          await writeFile(
            fix.targetPath,
            ['---', 'title: changed again', 'status: pending', '---', '', '# changed again', ''].join('\n'),
            'utf8',
          );
        },
      },
    }),
    /confirmed/,
  );

  assert.ok(!existsSync(fix.sourcePath));
  assert.deepEqual(await readFile(artifacts.claim), sourceBytes);
  assert.ok(existsSync(artifacts.claimContainer));
  assert.ok(!existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix target rejects deleted, non-confirmed, and non-file targets without archiving the source', async () => {
  const cases = [
    {
      name: 'deleted',
      prepare: async ({ targetPath }) => rm(targetPath),
      error: /target.*不存在|目标.*不存在/,
    },
    {
      name: 'non-confirmed',
      prepare: async ({ targetPath }) => writeFile(
        targetPath,
        ['---', 'title: pending target', 'status: pending', '---', '', '# pending target', ''].join('\n'),
        'utf8',
      ),
      error: /confirmed/,
    },
    {
      name: 'non-file',
      prepare: async ({ knowledgeRoot, targetPath, sourcePath }) => {
        await rm(targetPath);
        await mkdir(targetPath);
        await rm(sourcePath);
        await writePendingFix(knowledgeRoot, path.relative(knowledgeRoot, sourcePath), {
          target: 'knowledge/rules/resolve-target.md',
          targetHash: 'a'.repeat(64),
        });
      },
      error: /Markdown.*普通文件|不是.*文件/,
    },
  ];

  for (const scenario of cases) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `target-${scenario.name}` });
    await scenario.prepare({ knowledgeRoot, ...fix });
    const sourceBytes = await readFile(fix.sourcePath);

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
      scenario.error,
      scenario.name,
    );

    assert.deepEqual(await readFile(fix.sourcePath), sourceBytes, scenario.name);
    assertNoResolutionArtifacts(knowledgeRoot, fix.sourcePath);
  }
});

test('resolveFix target rejects a junction escaping the knowledge root and restores the source', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const outsideTargetContent = ['---', 'title: outside', 'status: confirmed', '---', '', '# outside', ''].join('\n');
  await writeExternalKnowledgeFile(outsideRoot, 'target.md', outsideTargetContent);
  const escapedDir = path.join(knowledgeRoot, 'knowledge', 'escaped');
  await mkdir(path.dirname(escapedDir), { recursive: true });
  if (!await createDirectoryLink(t, outsideRoot, escapedDir)) {
    return;
  }
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/escaped-target.md', {
    target: 'knowledge/escaped/target.md',
    targetHash: createHash('sha256').update(Buffer.from(outsideTargetContent)).digest('hex'),
  });
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/escaped-target.md' }),
    /知识库.*内|越界|逃逸/,
  );

  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
});

test('resolveFix target rejects confirmed files outside the formal knowledge tree', async () => {
  const targetCases = [
    'inbox/rules/confirmed-target.md',
    'archive/manual/confirmed-target.md',
  ];

  for (const [index, relativeTarget] of targetCases.entries()) {
    const knowledgeRoot = await createTempRoot();
    await writeExternalKnowledgeFile(
      knowledgeRoot,
      relativeTarget,
      ['---', 'title: misplaced target', 'status: confirmed', '---', '', '# misplaced target', ''].join('\n'),
    );
    const sourcePath = await writePendingFix(knowledgeRoot, `inbox/fixes/misplaced-${index}.md`, {
      target: relativeTarget,
      targetHash: 'a'.repeat(64),
    });
    const sourceBytes = await readFile(sourcePath);

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: path.relative(knowledgeRoot, sourcePath) }),
      /target.*knowledge\//,
      relativeTarget,
    );

    assert.deepEqual(await readFile(sourcePath), sourceBytes, relativeTarget);
    assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
  }
});

test('resolveFix target rejects a knowledge junction resolving into inbox', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const inboxTargetDir = path.join(knowledgeRoot, 'inbox', 'confirmed-targets');
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'inbox/confirmed-targets/target.md',
    ['---', 'title: inbox confirmed', 'status: confirmed', '---', '', '# inbox confirmed', ''].join('\n'),
  );
  const linkedKnowledgeDir = path.join(knowledgeRoot, 'knowledge', 'inbox-alias');
  await mkdir(path.dirname(linkedKnowledgeDir), { recursive: true });
  if (!await createDirectoryLink(t, inboxTargetDir, linkedKnowledgeDir)) {
    return;
  }
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/knowledge-junction.md', {
    target: 'knowledge/inbox-alias/target.md',
    targetHash: 'a'.repeat(64),
  });
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/knowledge-junction.md' }),
    /target.*knowledge.*真实路径|正式 knowledge/,
  );

  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
});

test('resolveFix source rejects paths outside fixed categories before creating work or archive state', async () => {
  const invalidSources = [
    'inbox/rules/not-a-fix.md',
    'inbox/fixes/nested/not-direct.md',
    'inbox/fixes/not-markdown.txt',
  ];

  for (const relativeSource of invalidSources) {
    const knowledgeRoot = await createTempRoot();
    const sourcePath = await writePendingFix(knowledgeRoot, relativeSource, {
      target: 'knowledge/rules/target.md',
      targetHash: 'a'.repeat(64),
    });
    const sourceBytes = await readFile(sourcePath);

    await assert.rejects(resolveFix({ knowledgeRoot, file: relativeSource }), /固定分类|source.*路径|Markdown/);

    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assert.ok(!existsSync(path.join(knowledgeRoot, 'work')));
    assert.ok(!existsSync(path.join(knowledgeRoot, 'archive')));
  }
});

test('resolveFix source rejects non-pending and incomplete new-format fixes before any side effect', async () => {
  const invalidFields = [
    { status: 'resolved', target: 'knowledge/rules/target.md', targetHash: 'a'.repeat(64) },
    { targetHash: 'a'.repeat(64) },
    { target: 'knowledge/rules/target.md' },
  ];

  for (const [index, fields] of invalidFields.entries()) {
    const knowledgeRoot = await createTempRoot();
    const relativeSource = `inbox/prd-corrections/invalid-${index}.md`;
    const sourcePath = await writePendingFix(knowledgeRoot, relativeSource, fields);
    const sourceBytes = await readFile(sourcePath);

    await assert.rejects(resolveFix({ knowledgeRoot, file: relativeSource }), /pending|target|target_hash/);

    assert.deepEqual(await readFile(sourcePath), sourceBytes);
    assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
    await assertResolveLockReleased(knowledgeRoot);
  }
});

test('resolveFix source rejects a non-empty malformed fix_id before any side effect', async () => {
  const knowledgeRoot = await createTempRoot();
  await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/uuid-target.md',
    ['---', 'title: uuid target', 'status: confirmed', '---', '', '# uuid target', ''].join('\n'),
  );
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/malformed-uuid.md', {
    fixId: 'not-a-valid-uuid',
    target: 'knowledge/rules/uuid-target.md',
    targetHash: 'a'.repeat(64),
  });
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/malformed-uuid.md' }),
    /fix_id.*UUID|fix_id.*uuid/,
  );

  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
  await assertResolveLockReleased(knowledgeRoot);
});

test('resolveFix source rejects missing fix_id when a new-format target_hash is present', async () => {
  const knowledgeRoot = await createTempRoot();
  const originalTarget = ['---', 'title: target', 'status: confirmed', '---', '', '# target', 'old', ''].join('\n');
  const changedTarget = ['---', 'title: target', 'status: confirmed', '---', '', '# target', 'new', ''].join('\n');
  const targetPath = await writeExternalKnowledgeFile(
    knowledgeRoot,
    'knowledge/rules/missing-id-target.md',
    originalTarget,
  );
  const sourcePath = await writePendingFix(knowledgeRoot, 'inbox/fixes/missing-id.md', {
    omitFixId: true,
    target: 'knowledge/rules/missing-id-target.md',
    targetHash: createHash('sha256').update(Buffer.from(originalTarget)).digest('hex'),
  });
  await writeFile(targetPath, changedTarget, 'utf8');
  const sourceBytes = await readFile(sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/missing-id.md' }),
    /fix_id/,
  );
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assertNoResolutionArtifacts(knowledgeRoot, sourcePath);
});

test('resolveFix source rejects a symlink even when it resolves inside the knowledge root', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const actualSource = await writePendingFix(knowledgeRoot, 'inbox/actual-source.md', {
    target: 'knowledge/rules/target.md',
    targetHash: 'a'.repeat(64),
  });
  const linkedSource = path.join(knowledgeRoot, 'inbox', 'fixes', 'linked.md');
  await mkdir(path.dirname(linkedSource), { recursive: true });
  try {
    await symlink(actualSource, linkedSource, 'file');
  } catch (error) {
    if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      t.skip(`file links are unavailable on this platform: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(resolveFix({ knowledgeRoot, file: 'inbox/fixes/linked.md' }), /symlink|符号链接|普通文件/);

  assert.ok(existsSync(linkedSource));
  assert.ok(existsSync(actualSource));
  assertNoResolutionArtifacts(knowledgeRoot, linkedSource);
  await assertResolveLockReleased(knowledgeRoot);
});

test('resolveFix source rejects an inbox category parent junction escaping the knowledge root', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const externalSource = await writePendingFix(outsideRoot, 'junction-source.md', {
    target: 'knowledge/rules/target.md',
    targetHash: 'a'.repeat(64),
  });
  const externalBytes = await readFile(externalSource);
  const categoryPath = path.join(knowledgeRoot, 'inbox', 'fixes');
  await mkdir(path.dirname(categoryPath), { recursive: true });
  if (!await createDirectoryLink(t, outsideRoot, categoryPath)) {
    return;
  }

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/junction-source.md' }),
    /source.*真实路径|source.*知识库|越出当前知识库/,
  );

  assert.deepEqual(await readFile(externalSource), externalBytes);
  assert.deepEqual(await readdir(outsideRoot), ['junction-source.md']);
  assertNoResolutionArtifacts(knowledgeRoot, path.join(knowledgeRoot, 'inbox', 'fixes', 'junction-source.md'));
  await assertResolveLockReleased(knowledgeRoot);
});

test('resolveFix source never overwrites an existing claim', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'existing claim' });
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const sourceBytes = await readFile(fix.sourcePath);
  const claimPath = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath).claim;
  const existingClaimBytes = Buffer.from('existing claim must not be overwritten\n', 'utf8');
  await mkdir(path.dirname(claimPath), { recursive: true });
  await writeFile(claimPath, existingClaimBytes);

  await assert.rejects(resolveFix({ knowledgeRoot, file: fix.sourceRelative }), /claim.*已存在/);

  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.deepEqual(await readFile(claimPath), existingClaimBytes);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  assert.ok(!existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix source reports an existing claim before reading a missing inbox source', async () => {
  const knowledgeRoot = await createTempRoot();
  const missingSource = path.join(knowledgeRoot, 'inbox', 'fixes', 'claimed-only.md');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, missingSource);
  const claimedBytes = Buffer.from('claimed evidence retained for Task3\n', 'utf8');
  await mkdir(artifacts.claimContainer, { recursive: true });
  await writeFile(artifacts.claim, claimedBytes);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: 'inbox/fixes/claimed-only.md' }),
    /claim.*恢复.*Task3|claim.*已存在/,
  );

  assert.deepEqual(await readFile(artifacts.claim), claimedBytes);
  assert.ok(!existsSync(missingSource));
});

test('resolveFix source rejects a claim container replaced by an external junction after mkdir', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'claim container junction race' });
  const sourceBytes = await readFile(fix.sourcePath);
  await writeFile(
    fix.targetPath,
    ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
    'utf8',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  let linkUnavailable = false;
  let caughtError;

  try {
    await resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterClaimContainerCreated: async ({ claimContainer }) => {
          await rmdir(claimContainer);
          if (!await createDirectoryLink(t, outsideRoot, claimContainer)) {
            linkUnavailable = true;
            throw new Error('directory links unavailable');
          }
        },
      },
    });
  } catch (error) {
    caughtError = error;
  }
  if (linkUnavailable) {
    return;
  }

  assert.ok(caughtError);
  assert.match(caughtError.message, /claim.*空目录|claim.*普通目录|claim.*知识库/);
  assert.deepEqual(await readFile(fix.sourcePath), sourceBytes);
  assert.deepEqual(await readdir(outsideRoot), []);
  assert.ok(existsSync(artifacts.claimContainer));
  assert.ok(!existsSync(artifacts.claim));
  assert.ok(!existsSync(artifacts.survivor));
});

test('resolveFix internal path revalidates archive parents at every write and preserves existing evidence', async (t) => {
  const scenarios = [
    { stage: 'survivor-publish', claim: true, survivor: false, snapshot: false, temp: false },
    { stage: 'snapshot-temp-write', claim: false, survivor: true, snapshot: false, temp: false },
    { stage: 'snapshot-link', claim: false, survivor: true, snapshot: false, temp: true },
    { stage: 'resolved-temp-write', claim: false, survivor: true, snapshot: true, temp: false },
    { stage: 'resolved-link', claim: false, survivor: true, snapshot: true, temp: true },
  ];

  for (const scenario of scenarios) {
    const knowledgeRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `archive-race-${scenario.stage}` });
    await writeFile(
      fix.targetPath,
      ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
      'utf8',
    );
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    let swapResult;
    let caughtError;

    try {
      await resolveFix({
        knowledgeRoot,
        file: fix.sourceRelative,
        hooks: {
          beforeArchiveWrite: async ({ stage, parentPath }) => {
            if (stage === scenario.stage) {
              swapResult = await swapDirectoryForExternalLink(t, parentPath, outsideRoot);
            }
          },
        },
      });
    } catch (error) {
      caughtError = error;
    }
    if (swapResult && !swapResult.linked) {
      return;
    }

    assert.ok(caughtError, scenario.stage);
    assert.match(caughtError.message, /父目录.*知识库|真实路径.*知识库/, scenario.stage);
    assert.deepEqual(await readdir(outsideRoot), [], scenario.stage);
    assert.equal(existsSync(artifacts.claim), scenario.claim, scenario.stage);
    assert.equal(existsSync(artifacts.survivor), scenario.survivor, scenario.stage);
    assert.equal(existsSync(artifacts.snapshot), scenario.snapshot, scenario.stage);
    assert.ok(!existsSync(artifacts.resolved), scenario.stage);
    assert.ok(!existsSync(fix.sourcePath), scenario.stage);
    const backupEntries = await readdir(swapResult.backupDirectory);
    assert.equal(backupEntries.some((entry) => entry.endsWith('.tmp')), scenario.temp, scenario.stage);
  }
});

test('resolveFix internal path rejects work and archive parent junction escapes before locking or claiming', async (t) => {
  const unsafeParents = [
    'work',
    'archive/source-survivors',
    'archive/resolved-sources',
    'archive/resolved',
  ];

  for (const unsafeParent of unsafeParents) {
    const knowledgeRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `internal-${unsafeParent}` });
    await writeFile(
      fix.targetPath,
      ['---', 'title: changed', 'status: confirmed', '---', '', '# changed', ''].join('\n'),
      'utf8',
    );
    const sourceBytes = await readFile(fix.sourcePath);
    const linkPath = path.join(knowledgeRoot, ...unsafeParent.split('/'));
    await mkdir(path.dirname(linkPath), { recursive: true });
    if (!await createDirectoryLink(t, outsideRoot, linkPath)) {
      return;
    }

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
      /内部目录|知识库.*内|越界|逃逸/,
      unsafeParent,
    );

    assert.deepEqual(await readFile(fix.sourcePath), sourceBytes, unsafeParent);
    assert.deepEqual(await readdir(outsideRoot), [], unsafeParent);
    const lockDir = path.join(knowledgeRoot, 'work', 'locks', 'resolve');
    if (existsSync(lockDir)) {
      assert.deepEqual(await readdir(lockDir), [], unsafeParent);
    }
  }
});

test('resolveFix recovery resumes an old claim before a recreated or missing inbox source', async () => {
  for (const recreateSource of [false, true]) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `claim-recovery-${recreateSource}` });
    const oldSourceBytes = await readFile(fix.sourcePath);
    await changeResolvableTarget(fix);
    await interruptResolveAt(knowledgeRoot, fix, 'after-claim');
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const recreatedBytes = Buffer.from('invalid new lifecycle source\n', 'utf8');
    if (recreateSource) {
      await writeFile(fix.sourcePath, recreatedBytes, { flag: 'wx' });
    }

    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

    assert.deepEqual(await readFile(artifacts.snapshot), oldSourceBytes);
    assert.ok(existsSync(artifacts.resolved));
    assert.equal(existsSync(fix.sourcePath), recreateSource);
    if (recreateSource) {
      assert.deepEqual(await readFile(fix.sourcePath), recreatedBytes);
    }
  }
});

test('resolveFix recovery serializes Windows source filename case variants with one filesystem identity', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only case-insensitive filesystem identity contract');
    return;
  }
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'windows-case-lock' });
  await changeResolvableTarget(fix);
  const variantSource = windowsSourceCaseVariant(fix.sourceRelative);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  let releaseClaim;
  let reportClaimed;
  const claimGate = new Promise((resolve) => { releaseClaim = resolve; });
  const claimReached = new Promise((resolve) => { reportClaimed = resolve; });
  const firstCall = resolveFix({
    knowledgeRoot,
    file: fix.sourceRelative,
    hooks: {
      afterClaimRename: async () => {
        reportClaimed();
        await claimGate;
      },
    },
  });
  await claimReached;
  let secondSettled = false;
  const secondCall = resolveFix({ knowledgeRoot, file: variantSource });
  const observedSecond = secondCall.then(
    (value) => {
      secondSettled = true;
      return { status: 'fulfilled', value };
    },
    (reason) => {
      secondSettled = true;
      return { status: 'rejected', reason };
    },
  );

  await delay(100);
  const serializedWhileFirstOwnsLock = !secondSettled;
  releaseClaim();
  const [firstResult, secondResult] = await Promise.allSettled([firstCall, observedSecond]);

  assert.ok(serializedWhileFirstOwnsLock, 'case variant must wait for the first source lock');
  assert.equal(firstResult.status, 'fulfilled');
  assert.equal(secondResult.status, 'fulfilled');
  assert.equal(secondResult.value.status, 'fulfilled');
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
  assert.ok(!existsSync(artifacts.claimContainer));
  assert.deepEqual(await readdir(path.dirname(artifacts.survivor)), [path.basename(artifacts.survivor)]);
  assert.deepEqual(await readdir(path.dirname(artifacts.snapshot)), [path.basename(artifacts.snapshot)]);
  assert.deepEqual(await readdir(path.dirname(artifacts.resolved)), [path.basename(artifacts.resolved)]);
});

test('resolveFix recovery cleans only an empty claim container when the original source still exists', async () => {
  const retryRoot = await createTempRoot();
  const retryFix = await createResolvableFix(retryRoot, { title: 'empty-claim-retry' });
  await changeResolvableTarget(retryFix);
  const retryArtifacts = resolutionArtifactPaths(retryRoot, retryFix.sourcePath);
  await mkdir(retryArtifacts.claimContainer, { recursive: true });

  await resolveFix({ knowledgeRoot: retryRoot, file: retryFix.sourceRelative });

  assert.ok(existsSync(retryArtifacts.resolved));
  assert.ok(!existsSync(retryArtifacts.claimContainer));

  const missingRoot = await createTempRoot();
  const missingSource = path.join(missingRoot, 'inbox', 'fixes', 'missing.md');
  const missingArtifacts = resolutionArtifactPaths(missingRoot, missingSource);
  await mkdir(missingArtifacts.claimContainer, { recursive: true });
  await assert.rejects(
    resolveFix({ knowledgeRoot: missingRoot, file: 'inbox/fixes/missing.md' }),
    /claim.*不完整|source.*不存在|恢复现场/,
  );
  assert.ok(existsSync(missingArtifacts.claimContainer));

  const nonEmptyRoot = await createTempRoot();
  const nonEmptyFix = await createResolvableFix(nonEmptyRoot, { title: 'non-empty-claim' });
  await changeResolvableTarget(nonEmptyFix);
  const nonEmptyArtifacts = resolutionArtifactPaths(nonEmptyRoot, nonEmptyFix.sourcePath);
  await mkdir(nonEmptyArtifacts.claimContainer, { recursive: true });
  const evidencePath = path.join(nonEmptyArtifacts.claimContainer, 'manual.txt');
  await writeFile(evidencePath, 'keep\n', 'utf8');
  await assert.rejects(
    resolveFix({ knowledgeRoot: nonEmptyRoot, file: nonEmptyFix.sourceRelative }),
    /claim.*不完整|预期|未知/,
  );
  assert.equal(await readFile(evidencePath, 'utf8'), 'keep\n');
  assert.ok(existsSync(nonEmptyFix.sourcePath));

  const mixedRoot = await createTempRoot();
  const mixedFix = await createResolvableFix(mixedRoot, { title: 'claim-source-plus-unknown' });
  await changeResolvableTarget(mixedFix);
  await interruptResolveAt(mixedRoot, mixedFix, 'after-claim');
  const mixedArtifacts = resolutionArtifactPaths(mixedRoot, mixedFix.sourcePath);
  const unknownPath = path.join(mixedArtifacts.claimContainer, 'unknown.txt');
  await writeFile(unknownPath, 'retain unknown evidence\n', 'utf8');

  await assert.rejects(
    resolveFix({ knowledgeRoot: mixedRoot, file: mixedFix.sourceRelative }),
    /claim.*预期|claim.*不完整|未知/,
  );
  assert.ok(existsSync(mixedArtifacts.claim));
  assert.equal(await readFile(unknownPath, 'utf8'), 'retain unknown evidence\n');
  assert.ok(!existsSync(mixedArtifacts.survivor));
});

test('resolveFix recovery accepts only a same-inode claim and survivor pair', async () => {
  const sameRoot = await createTempRoot();
  const sameFix = await createResolvableFix(sameRoot, { title: 'same-inode-claim-survivor' });
  await changeResolvableTarget(sameFix);
  await interruptResolveAt(sameRoot, sameFix, 'after-claim');
  const sameArtifacts = resolutionArtifactPaths(sameRoot, sameFix.sourcePath);
  await mkdir(path.dirname(sameArtifacts.survivor), { recursive: true });
  await link(sameArtifacts.claim, sameArtifacts.survivor);

  await resolveFix({ knowledgeRoot: sameRoot, file: sameFix.sourceRelative });

  assert.ok(!existsSync(sameArtifacts.claimContainer));
  assert.ok(existsSync(sameArtifacts.resolved));
  assert.equal((await stat(sameArtifacts.survivor)).mode & 0o222, 0);

  const conflictRoot = await createTempRoot();
  const conflictFix = await createResolvableFix(conflictRoot, { title: 'different-inode-claim-survivor' });
  await changeResolvableTarget(conflictFix);
  await interruptResolveAt(conflictRoot, conflictFix, 'after-claim');
  const conflictArtifacts = resolutionArtifactPaths(conflictRoot, conflictFix.sourcePath);
  await mkdir(path.dirname(conflictArtifacts.survivor), { recursive: true });
  await writeFile(conflictArtifacts.survivor, await readFile(conflictArtifacts.claim));

  await assert.rejects(
    resolveFix({ knowledgeRoot: conflictRoot, file: conflictFix.sourceRelative }),
    /claim.*survivor.*冲突|inode|同一.*inode/,
  );
  assert.ok(existsSync(conflictArtifacts.claim));
  assert.ok(existsSync(conflictArtifacts.survivor));
});

test('resolveFix recovery resumes survivor-only and survivor-plus-snapshot states', async () => {
  for (const stage of ['snapshot-temp-write', 'resolved-temp-write']) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `resume-${stage}` });
    await changeResolvableTarget(fix);
    await interruptResolveAt(knowledgeRoot, fix, stage);
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

    assert.ok(existsSync(artifacts.resolved), stage);
    assert.equal((await stat(artifacts.survivor)).mode & 0o222, 0, stage);
    assert.equal((await stat(artifacts.snapshot)).mode & 0o222, 0, stage);
  }
});

test('resolveFix recovery revalidates target before completing survivor and snapshot states', async () => {
  const scenarios = [
    {
      stage: 'snapshot-temp-write',
      name: 'deleted',
      mutate: ({ targetPath }) => rm(targetPath),
      error: /target.*不存在/,
    },
    {
      stage: 'snapshot-temp-write',
      name: 'non-confirmed',
      mutate: ({ targetPath }) => writeFile(
        targetPath,
        ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
        'utf8',
      ),
      error: /confirmed/,
    },
    {
      stage: 'resolved-temp-write',
      name: 'baseline',
      mutate: ({ targetPath, originalTargetContent }) => writeFile(targetPath, originalTargetContent, 'utf8'),
      error: /哈希.*相同|未变化/,
    },
  ];

  for (const scenario of scenarios) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `revalidate-${scenario.name}` });
    await changeResolvableTarget(fix);
    await interruptResolveAt(knowledgeRoot, fix, scenario.stage);
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    await scenario.mutate(fix);

    await assert.rejects(
      resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
      scenario.error,
      scenario.name,
    );
    assert.ok(existsSync(artifacts.survivor), scenario.name);
    // survivor-only 恢复按权威流程先固化独立 snapshot，再重新校验 target；target 失败也保留新快照。
    assert.ok(existsSync(artifacts.snapshot), scenario.name);
    assert.ok(!existsSync(artifacts.resolved), scenario.name);
  }
});

test('resolveFix recovery rejects a target link escape in an incomplete state', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'recovery-target-link' });
  await changeResolvableTarget(fix);
  await interruptResolveAt(knowledgeRoot, fix, 'resolved-temp-write');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const targetDir = path.dirname(fix.targetPath);
  const backupDir = `${targetDir}.backup`;
  await rename(targetDir, backupDir);
  if (!await createDirectoryLink(t, outsideRoot, targetDir)) {
    return;
  }

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
    /target.*不存在|target.*知识库|真实路径/,
  );
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix recovery validates survivor-only artifact before chmod and rejects a directory link', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const outsideEvidence = path.join(outsideRoot, 'outside.txt');
  await writeFile(outsideEvidence, 'outside must remain unchanged\n', 'utf8');
  const fix = await createResolvableFix(knowledgeRoot, { title: 'unsafe-survivor-artifact' });
  await changeResolvableTarget(fix);
  await interruptResolveAt(knowledgeRoot, fix, 'snapshot-temp-write');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  await chmod(artifacts.survivor, 0o666);
  await rm(artifacts.survivor);
  if (!await createDirectoryLink(t, outsideRoot, artifacts.survivor)) {
    return;
  }
  const chmodCalls = [];

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      chmodFile: async (filePath, mode) => {
        chmodCalls.push(filePath);
        if (filePath !== artifacts.survivor) {
          await chmod(filePath, mode);
        }
      },
    }),
    /survivor.*普通 Markdown|survivor.*链接|真实路径|无法确认只读/,
  );

  assert.ok(!chmodCalls.includes(artifacts.survivor));
  assert.equal(await readFile(outsideEvidence, 'utf8'), 'outside must remain unchanged\n');
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));
});

test('resolveFix recovery validates snapshot artifact before chmod and rejects a directory link', async (t) => {
  const knowledgeRoot = await createTempRoot();
  const outsideRoot = await createTempRoot();
  const outsideEvidence = path.join(outsideRoot, 'outside.txt');
  await writeFile(outsideEvidence, 'outside snapshot must remain unchanged\n', 'utf8');
  const fix = await createResolvableFix(knowledgeRoot, { title: 'unsafe-snapshot-artifact' });
  await changeResolvableTarget(fix);
  await interruptResolveAt(knowledgeRoot, fix, 'resolved-temp-write');
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  await chmod(artifacts.snapshot, 0o666);
  await rm(artifacts.snapshot);
  if (!await createDirectoryLink(t, outsideRoot, artifacts.snapshot)) {
    return;
  }
  const chmodCalls = [];

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      chmodFile: async (filePath, mode) => {
        chmodCalls.push(filePath);
        if (filePath !== artifacts.snapshot) {
          await chmod(filePath, mode);
        }
      },
    }),
    /snapshot.*普通 Markdown|snapshot.*链接|真实路径|无法确认只读/,
  );

  assert.ok(!chmodCalls.includes(artifacts.snapshot));
  assert.equal(await readFile(outsideEvidence, 'utf8'), 'outside snapshot must remain unchanged\n');
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix recovery rejects snapshot-only and archive-only incomplete states', async () => {
  const snapshotRoot = await createTempRoot();
  const snapshotFix = await createResolvableFix(snapshotRoot, { title: 'snapshot-only' });
  await changeResolvableTarget(snapshotFix);
  await interruptResolveAt(snapshotRoot, snapshotFix, 'resolved-temp-write');
  const snapshotArtifacts = resolutionArtifactPaths(snapshotRoot, snapshotFix.sourcePath);
  await chmod(snapshotArtifacts.survivor, 0o666);
  await rm(snapshotArtifacts.survivor);

  await assert.rejects(
    resolveFix({ knowledgeRoot: snapshotRoot, file: snapshotFix.sourceRelative }),
    /snapshot.*survivor|不完整/,
  );
  assert.ok(existsSync(snapshotArtifacts.snapshot));

  const archiveRoot = await createTempRoot();
  const archiveFix = await createResolvableFix(archiveRoot, { title: 'archive-only' });
  await changeResolvableTarget(archiveFix);
  await resolveFix({ knowledgeRoot: archiveRoot, file: archiveFix.sourceRelative });
  const archiveArtifacts = resolutionArtifactPaths(archiveRoot, archiveFix.sourcePath);
  await chmod(archiveArtifacts.survivor, 0o666);
  await chmod(archiveArtifacts.snapshot, 0o666);
  await rm(archiveArtifacts.survivor);
  await rm(archiveArtifacts.snapshot);

  await assert.rejects(
    resolveFix({ knowledgeRoot: archiveRoot, file: archiveFix.sourceRelative }),
    /resolved.*survivor|归档.*不完整|不完整/,
  );
  assert.ok(existsSync(archiveArtifacts.resolved));
});

test('resolveFix idempotent completion ignores current target state and validates persistent artifacts', async () => {
  for (const mutation of ['delete', 'pending', 'changed-again']) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `completed-target-${mutation}` });
    await changeResolvableTarget(fix);
    const firstResult = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    if (mutation === 'delete') {
      await rm(fix.targetPath);
    } else if (mutation === 'pending') {
      await writeFile(
        fix.targetPath,
        ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
        'utf8',
      );
    } else {
      await changeResolvableTarget(fix, 'changed after completion');
    }

    const retryResult = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });

    assert.deepEqual(retryResult, firstResult, mutation);
  }
});

test('resolveFix idempotent accepts a Windows source filename case variant', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only case-insensitive filesystem identity contract');
    return;
  }
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'windows-case-idempotent' });
  await changeResolvableTarget(fix);
  const firstResult = await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
  const variantSource = windowsSourceCaseVariant(fix.sourceRelative);

  const retryResult = await resolveFix({ knowledgeRoot, file: variantSource });

  assert.deepEqual(retryResult, firstResult);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  assert.deepEqual(await readdir(path.dirname(artifacts.resolved)), [path.basename(artifacts.resolved)]);
  const replacement = Buffer.from('new Windows source lifecycle\n', 'utf8');
  await writeFile(fix.sourcePath, replacement, { flag: 'wx' });
  await assert.rejects(
    resolveFix({ knowledgeRoot, file: variantSource }),
    /source.*复用|重命名|新.*source/,
  );
  assert.deepEqual(await readFile(fix.sourcePath), replacement);
});

test('resolveFix idempotent completion handles residual claims and rejects conflicting ones', async () => {
  const sameRoot = await createTempRoot();
  const sameFix = await createResolvableFix(sameRoot, { title: 'completed-same-claim' });
  await changeResolvableTarget(sameFix);
  await resolveFix({ knowledgeRoot: sameRoot, file: sameFix.sourceRelative });
  const sameArtifacts = resolutionArtifactPaths(sameRoot, sameFix.sourcePath);
  await mkdir(sameArtifacts.claimContainer, { recursive: true });
  await link(sameArtifacts.survivor, sameArtifacts.claim);

  await resolveFix({ knowledgeRoot: sameRoot, file: sameFix.sourceRelative });

  assert.ok(!existsSync(sameArtifacts.claimContainer));
  assert.equal((await stat(sameArtifacts.survivor)).mode & 0o222, 0);

  const conflictRoot = await createTempRoot();
  const conflictFix = await createResolvableFix(conflictRoot, { title: 'completed-different-claim' });
  await changeResolvableTarget(conflictFix);
  await resolveFix({ knowledgeRoot: conflictRoot, file: conflictFix.sourceRelative });
  const conflictArtifacts = resolutionArtifactPaths(conflictRoot, conflictFix.sourcePath);
  await mkdir(conflictArtifacts.claimContainer, { recursive: true });
  await writeFile(conflictArtifacts.claim, await readFile(conflictArtifacts.survivor));

  await assert.rejects(
    resolveFix({ knowledgeRoot: conflictRoot, file: conflictFix.sourceRelative }),
    /claim.*survivor.*冲突|inode/,
  );
  assert.ok(existsSync(conflictArtifacts.claim));
  assert.ok(existsSync(conflictArtifacts.survivor));
});

test('resolveFix idempotent validates completed artifacts before chmod and rejects directory links', async (t) => {
  for (const artifactName of ['survivor', 'snapshot']) {
    const knowledgeRoot = await createTempRoot();
    const outsideRoot = await createTempRoot();
    const outsideEvidence = path.join(outsideRoot, 'outside.txt');
    await writeFile(outsideEvidence, `outside ${artifactName} must remain unchanged\n`, 'utf8');
    const fix = await createResolvableFix(knowledgeRoot, { title: `completed-unsafe-${artifactName}` });
    await changeResolvableTarget(fix);
    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const unsafeArtifact = artifacts[artifactName];
    await chmod(unsafeArtifact, 0o666);
    await rm(unsafeArtifact);
    if (!await createDirectoryLink(t, outsideRoot, unsafeArtifact)) {
      return;
    }
    const chmodCalls = [];

    await assert.rejects(
      resolveFix({
        knowledgeRoot,
        file: fix.sourceRelative,
        chmodFile: async (filePath, mode) => {
          chmodCalls.push(filePath);
          if (filePath !== unsafeArtifact) {
            await chmod(filePath, mode);
          }
        },
      }),
      /普通 Markdown|链接|真实路径|无法确认只读/,
      artifactName,
    );

    assert.ok(!chmodCalls.includes(unsafeArtifact), artifactName);
    assert.equal(
      await readFile(outsideEvidence, 'utf8'),
      `outside ${artifactName} must remain unchanged\n`,
      artifactName,
    );
    assert.ok(existsSync(unsafeArtifact), artifactName);
    assert.ok(existsSync(artifacts.resolved), artifactName);
  }
});

test('resolveFix idempotent rejects a truncated archive and a reused completed source path', async () => {
  const truncatedRoot = await createTempRoot();
  const truncatedFix = await createResolvableFix(truncatedRoot, { title: 'truncated-resolved' });
  await changeResolvableTarget(truncatedFix);
  await resolveFix({ knowledgeRoot: truncatedRoot, file: truncatedFix.sourceRelative });
  const truncatedArtifacts = resolutionArtifactPaths(truncatedRoot, truncatedFix.sourcePath);
  const originalResolved = await readFile(truncatedArtifacts.resolved, 'utf8');
  await writeFile(truncatedArtifacts.resolved, originalResolved.slice(0, originalResolved.indexOf('#')), 'utf8');

  await assert.rejects(
    resolveFix({ knowledgeRoot: truncatedRoot, file: truncatedFix.sourceRelative }),
    /resolved.*冲突|完整.*载荷|归档.*不一致|frontmatter/,
  );

  const reuseRoot = await createTempRoot();
  const reuseFix = await createResolvableFix(reuseRoot, { title: 'source-path-reuse' });
  await changeResolvableTarget(reuseFix);
  await resolveFix({ knowledgeRoot: reuseRoot, file: reuseFix.sourceRelative });
  const replacement = Buffer.from('new source lifecycle must remain\n', 'utf8');
  await writeFile(reuseFix.sourcePath, replacement, { flag: 'wx' });

  await assert.rejects(
    resolveFix({ knowledgeRoot: reuseRoot, file: reuseFix.sourceRelative }),
    /source.*复用|重命名|新.*source/,
  );
  assert.deepEqual(await readFile(reuseFix.sourcePath), replacement);
});

test('resolveFix idempotent rejects invalid persisted completion timestamps', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'invalid-completion-time' });
  await changeResolvableTarget(fix);
  await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  await writeFile(
    artifacts.resolved,
    resolvedContent.replace(/^resolved_at:.*$/m, 'resolved_at: invalid-time'),
    'utf8',
  );

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: fix.sourceRelative }),
    /resolved_at|时间|归档.*冲突/,
  );
});

test('resolveFix recovery retries chmod, unlink, and resolved publication failures without losing evidence', async () => {
  const scenarios = ['survivor-chmod', 'snapshot-chmod', 'claim-unlink', 'resolved-publish'];
  for (const scenario of scenarios) {
    const knowledgeRoot = await createTempRoot();
    const fix = await createResolvableFix(knowledgeRoot, { title: `failure-${scenario}` });
    await changeResolvableTarget(fix);
    const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
    const injectedError = new Error(`simulated ${scenario}`);
    let chmodCalls = 0;
    let removeFailed = false;
    const options = {
      knowledgeRoot,
      file: fix.sourceRelative,
      chmodFile: async (filePath, mode) => {
        chmodCalls += 1;
        if ((scenario === 'survivor-chmod' && chmodCalls === 1)
            || (scenario === 'snapshot-chmod' && filePath === artifacts.snapshot)) {
          throw injectedError;
        }
        await chmod(filePath, mode);
      },
      removeFile: async (filePath, removeOptions) => {
        if (scenario === 'claim-unlink' && filePath === artifacts.claim && !removeFailed) {
          removeFailed = true;
          throw injectedError;
        }
        await rm(filePath, removeOptions);
      },
      hooks: scenario === 'resolved-publish'
        ? {
            beforeArchiveWrite: async ({ stage }) => {
              if (stage === 'resolved-link') {
                throw injectedError;
              }
            },
          }
        : {},
    };

    await assert.rejects(resolveFix(options), (error) => error === injectedError, scenario);
    assert.ok(
      [artifacts.claim, artifacts.survivor, artifacts.snapshot].some((artifact) => existsSync(artifact)),
      scenario,
    );

    await resolveFix({ knowledgeRoot, file: fix.sourceRelative });
    assert.ok(existsSync(artifacts.resolved), scenario);
  }
});

test('resolveFix late write before resolved publication preserves both sources and does not publish resolved', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'late-before-resolved' });
  await changeResolvableTarget(fix);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const lateBytes = Buffer.from('late writer bytes before resolved\n', 'utf8');

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'resolved-temp-write') {
            await chmod(artifacts.survivor, 0o666);
            await writeFile(artifacts.survivor, lateBytes);
          }
        },
      },
    }),
    /survivor.*snapshot.*不一致|晚到写入|并发写入/,
  );

  assert.deepEqual(await readFile(artifacts.survivor), lateBytes);
  assert.notDeepEqual(await readFile(artifacts.snapshot), lateBytes);
  assert.ok(!existsSync(artifacts.resolved));
});

test('resolveFix late write after resolved publication preserves all artifacts and returns conflict', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'late-after-resolved' });
  await changeResolvableTarget(fix);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);
  const lateBytes = Buffer.from('late writer bytes after resolved\n', 'utf8');

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterArchivePublished: async ({ stage }) => {
          if (stage === 'resolved-link') {
            await chmod(artifacts.survivor, 0o666);
            await writeFile(artifacts.survivor, lateBytes);
          }
        },
      },
    }),
    /survivor.*snapshot.*不一致|晚到写入|并发写入/,
  );

  assert.deepEqual(await readFile(artifacts.survivor), lateBytes);
  assert.ok(existsSync(artifacts.snapshot));
  assert.ok(existsSync(artifacts.resolved));
});

test('resolveFix recovery retains claim when target changes after preflight but before claim validation', async () => {
  const knowledgeRoot = await createTempRoot();
  const fix = await createResolvableFix(knowledgeRoot, { title: 'target-race-before-claim-file' });
  const sourceBytes = await readFile(fix.sourcePath);
  await changeResolvableTarget(fix);
  const artifacts = resolutionArtifactPaths(knowledgeRoot, fix.sourcePath);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: fix.sourceRelative,
      hooks: {
        afterClaimContainerCreated: async () => {
          await writeFile(
            fix.targetPath,
            ['---', 'title: pending', 'status: pending', '---', '', '# pending', ''].join('\n'),
            'utf8',
          );
        },
      },
    }),
    /confirmed/,
  );

  assert.ok(!existsSync(fix.sourcePath));
  assert.deepEqual(await readFile(artifacts.claim), sourceBytes);
  assert.ok(!existsSync(artifacts.survivor));
});

test('resolveFix recovery legacy requires explicit confirmation and derives a stable snapshot identity', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/legacy-stable.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: legacy.sourceRelative }),
    /confirm-legacy|旧版|legacy/,
  );
  assert.deepEqual(await readFile(legacy.sourcePath), legacy.sourceBytes);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'resolved-temp-write') {
            throw new Error('interrupt legacy after snapshot');
          }
        },
      },
    }),
    /interrupt legacy after snapshot/,
  );
  assert.deepEqual(await readFile(artifacts.snapshot), legacy.sourceBytes);
  const expectedId = `legacy-${createHash('sha256')
    .update(legacy.sourceRelative)
    .update(Buffer.from([0]))
    .update(legacy.sourceBytes)
    .digest('hex')}`;

  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative, confirmLegacy: true });

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  assert.match(resolvedContent, new RegExp(`^fix_id: ${expectedId}$`, 'm'));
  assert.match(resolvedContent, /^legacy_confirmed: true$/m);
  assert.ok(!/^target_hash:/m.test(resolvedContent));
  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative });
});

test('resolveFix recovery legacy preserves an existing UUID while marking manual confirmation', async () => {
  const knowledgeRoot = await createTempRoot();
  const fixId = '22222222-2222-4222-8222-222222222222';
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/tech-solution-corrections/legacy-with-id.md',
    { fixId },
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);

  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative, confirmLegacy: true });

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  assert.match(resolvedContent, new RegExp(`^fix_id: ${fixId}$`, 'm'));
  assert.match(resolvedContent, /^legacy_confirmed: true$/m);
});

test('resolveFix recovery legacy finalizes identity from a late write captured before snapshot publication', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/prd-corrections/legacy-late-before-snapshot.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);
  const lateSnapshotBytes = Buffer.concat([
    legacy.sourceBytes,
    Buffer.from('\nlate editor evidence before snapshot\n', 'utf8'),
  ]);

  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'snapshot-temp-write') {
            await chmod(artifacts.survivor, 0o666);
            await writeFile(artifacts.survivor, lateSnapshotBytes);
          }
          if (stage === 'resolved-temp-write') {
            throw new Error('interrupt after late snapshot');
          }
        },
      },
    }),
    /interrupt after late snapshot/,
  );
  assert.deepEqual(await readFile(artifacts.snapshot), lateSnapshotBytes);
  const expectedId = `legacy-${createHash('sha256')
    .update(legacy.sourceRelative)
    .update(Buffer.from([0]))
    .update(lateSnapshotBytes)
    .digest('hex')}`;

  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative, confirmLegacy: true });

  assert.match(await readFile(artifacts.resolved, 'utf8'), new RegExp(`^fix_id: ${expectedId}$`, 'm'));
});

test('resolveFix recovery legacy keeps fix_id stable across a Windows source filename case variant', async (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows-only case-insensitive filesystem identity contract');
    return;
  }
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/legacy-windows-case.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);
  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'resolved-temp-write') {
            throw new Error('interrupt legacy before Windows case retry');
          }
        },
      },
    }),
    /interrupt legacy before Windows case retry/,
  );
  const variantSource = windowsSourceCaseVariant(legacy.sourceRelative);
  const expectedId = `legacy-${createHash('sha256')
    .update(legacy.sourceRelative.toLowerCase())
    .update(Buffer.from([0]))
    .update(await readFile(artifacts.snapshot))
    .digest('hex')}`;

  await resolveFix({ knowledgeRoot, file: variantSource, confirmLegacy: true });

  const resolvedContent = await readFile(artifacts.resolved, 'utf8');
  assert.match(resolvedContent, new RegExp(`^fix_id: ${expectedId}$`, 'm'));
  await resolveFix({ knowledgeRoot, file: legacy.sourceRelative });
});

test('resolveFix recovery legacy does not advance an incomplete survivor without renewed confirmation', async () => {
  const knowledgeRoot = await createTempRoot();
  const legacy = await writeLegacyTargetedFix(
    knowledgeRoot,
    'inbox/fixes/legacy-renew-confirmation.md',
  );
  const artifacts = resolutionArtifactPaths(knowledgeRoot, legacy.sourcePath);
  await assert.rejects(
    resolveFix({
      knowledgeRoot,
      file: legacy.sourceRelative,
      confirmLegacy: true,
      hooks: {
        beforeArchiveWrite: async ({ stage }) => {
          if (stage === 'snapshot-temp-write') {
            throw new Error('interrupt before legacy snapshot');
          }
        },
      },
    }),
    /interrupt before legacy snapshot/,
  );
  assert.ok(existsSync(artifacts.survivor));
  assert.ok(!existsSync(artifacts.snapshot));

  await assert.rejects(
    resolveFix({ knowledgeRoot, file: legacy.sourceRelative }),
    /confirm-legacy/,
  );
  assert.ok(!existsSync(artifacts.snapshot));
});
