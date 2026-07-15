import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

export const execFileAsync = promisify(execFile);
const testDir = path.dirname(fileURLToPath(import.meta.url));
export const cliPath = path.resolve(testDir, '..', 'bin', 'agent-knowledge.js');
export const repoRoot = path.resolve(testDir, '..', '..');
export const adapterFileNames = [
  'knowledge.before-task.md',
  'knowledge.record-fix.md',
];

export async function createTempRoot() {
  return mkdtemp(path.join(tmpdir(), 'agent-knowledge-test-'));
}

export async function createDirectoryLink(t, targetPath, linkPath) {
  try {
    await symlink(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch (error) {
    if (['EACCES', 'ENOTSUP', 'EPERM'].includes(error?.code)) {
      t.skip(`directory links are unavailable on this platform: ${error.code}`);
      return false;
    }
    throw error;
  }
}

export async function writeExternalKnowledgeFile(knowledgeRoot, relativePath, content) {
  const filePath = path.join(knowledgeRoot, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
  return filePath;
}

export async function assertNoBom(filePath) {
  const bytes = await readFile(filePath);
  assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
}

export async function writeAdapterTemplates(repositoryRoot) {
  const templateDir = path.join(repositoryRoot, 'agent-knowledge', 'templates', 'opencode');
  await mkdir(templateDir, { recursive: true });
  for (const fileName of adapterFileNames) {
    await writeFile(path.join(templateDir, fileName), `template: ${fileName}\n`, 'utf8');
  }
}

export async function runCli(args, options = {}) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    ...options,
  });
}

export async function runCliFailure(args, options = {}) {
  try {
    await runCli(args, options);
  } catch (error) {
    return error;
  }

  assert.fail(`Expected CLI to fail for args: ${args.join(' ')}`);
}

export async function runGit(args, cwd) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
  });
  return stdout.trim();
}

export async function createGitProject() {
  const projectRoot = await createTempRoot();
  await runGit(['init'], projectRoot);
  await writeFile(path.join(projectRoot, 'README.md'), '# demo\n', 'utf8');
  await runGit(['add', 'README.md'], projectRoot);
  await runGit([
    '-c',
    'user.name=Agent Knowledge Test',
    '-c',
    'user.email=agent-knowledge@example.test',
    'commit',
    '-m',
    '初始化',
  ], projectRoot);
  return projectRoot;
}

export async function createExitedProcessPid() {
  const child = execFile(process.execPath, ['-e', '']);
  const childPid = child.pid;
  await new Promise((resolve, reject) => {
    child.once('exit', resolve);
    child.once('error', reject);
  });
  return childPid;
}

export async function writePendingFix(knowledgeRoot, relativePath, fields = {}) {
  const content = [
    '---',
    `title: ${fields.title ?? 'manual fix'}`,
    'type: bug',
    `status: ${fields.status ?? 'pending'}`,
    'updated: 2026-07-13',
    ...(fields.omitFixId ? [] : [`fix_id: ${fields.fixId ?? '11111111-1111-4111-8111-111111111111'}`]),
    ...(fields.target === undefined ? [] : [`target: ${fields.target}`]),
    ...(fields.targetHash === undefined ? [] : [`target_hash: ${fields.targetHash}`]),
    '---',
    '',
    '# manual fix',
    '',
    'fix body must survive resolution',
    '',
  ].join('\n');
  return writeExternalKnowledgeFile(knowledgeRoot, relativePath, content);
}
