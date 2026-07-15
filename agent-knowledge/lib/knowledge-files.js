import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let temporaryFileSequence = 0;
const modulePath = fileURLToPath(import.meta.url);

// 独占创建候选文件，冲突时递增文件名后缀，避免同标题的连续或并发写入互相覆盖。
export async function writeUniqueFile(filePath, content) {
  for (let suffix = 1; ; suffix += 1) {
    const candidatePath = suffix === 1 ? filePath : appendNumericSuffix(filePath, suffix);
    try {
      await writeFile(candidatePath, content, { encoding: 'utf8', flag: 'wx' });
      return candidatePath;
    } catch (error) {
      if (error?.code === 'EEXIST') {
        continue;
      }

      // writeFile 在创建后写入失败时可能留下不完整文件，只清理本次独占创建的候选路径。
      await rm(candidatePath, { force: true }).catch(() => {});
      throw error;
    }
  }
}

// 先在目标同目录完整写入临时文件，再用 rename 原子替换，避免失败时暴露半写内容。
export async function writeFileAtomic(filePath, content, { renameFile = rename } = {}) {
  let temporaryPath;
  try {
    temporaryPath = await writeUniqueFile(createTemporaryPath(filePath, 'atomic'), content);
    await renameFile(temporaryPath, filePath);
  } catch (error) {
    if (temporaryPath) {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
    throw error;
  }
}

export function isPathWithinRoot(relativePath) {
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relativePath);
}

export async function isExistingFileWithinRealRoot(rootPath, filePath) {
  try {
    // lexical containment is not sufficient because stat/readFile follow symlinks and Windows junctions.
    const [resolvedRoot, resolvedFile, stats] = await Promise.all([
      realpath(rootPath),
      realpath(filePath),
      stat(filePath),
    ]);
    return isPathWithinRoot(path.relative(resolvedRoot, resolvedFile)) && stats.isFile();
  } catch {
    return false;
  }
}

export async function resolveKnowledgeMarkdownFile(baseDir, file, { command, tree }) {
  const resolvedBaseDir = path.resolve(baseDir);
  const requestedPath = path.isAbsolute(file)
    ? path.resolve(file)
    : path.resolve(resolvedBaseDir, file);
  const lexicalRelativePath = path.relative(resolvedBaseDir, requestedPath);
  if (!isPathWithinRoot(lexicalRelativePath)) {
    throw new Error(`${command} 知识文件必须位于当前知识库内，检测到路径越界: ${file}`);
  }

  const relativePath = toPosixPath(lexicalRelativePath);
  if (!relativePath.startsWith(`${tree}/`)) {
    throw new Error(`${command} 只接受 ${tree}/ 下的知识文件: ${relativePath}`);
  }
  if (path.extname(requestedPath).toLowerCase() !== '.md') {
    throw new Error(`${command} 知识文件必须是 Markdown: ${relativePath}`);
  }

  let entryStats;
  let realBaseDir;
  let realFilePath;
  let fileStats;
  try {
    [entryStats, realBaseDir, realFilePath, fileStats] = await Promise.all([
      lstat(requestedPath),
      realpath(resolvedBaseDir),
      realpath(requestedPath),
      stat(requestedPath),
    ]);
  } catch {
    throw new Error(`${command} 知识文件不存在或不是普通文件: ${relativePath}`);
  }
  if (entryStats.isSymbolicLink()) {
    throw new Error(`${command} 不接受文件符号链接: ${relativePath}`);
  }
  if (!fileStats.isFile()) {
    throw new Error(`${command} 知识文件不存在或不是普通文件: ${relativePath}`);
  }
  if (!isPathWithinRoot(path.relative(realBaseDir, realFilePath))) {
    throw new Error(`${command} 知识文件真实路径越出当前知识库: ${relativePath}`);
  }

  return {
    filePath: requestedPath,
    realFilePath,
    relativePath,
  };
}

export function assertConfirmedKnowledgeFile(command, relativePath, raw) {
  const status = readFrontmatterField(parseFrontmatter(raw).frontmatter, 'status');
  if (status !== 'confirmed') {
    throw new Error(`${command} 只接受 status: confirmed 的 knowledge/ 文件: ${relativePath}`);
  }
}

export async function prepareKnowledgeDirectory(baseDir, dirPath, command) {
  const resolvedBaseDir = path.resolve(baseDir);
  const resolvedDirPath = path.resolve(dirPath);
  const relativeDirPath = path.relative(resolvedBaseDir, resolvedDirPath);
  if (!isPathWithinRoot(relativeDirPath)) {
    throw new Error(`${command} 目标目录必须位于当前知识库内: ${toPosixPath(relativeDirPath)}`);
  }

  // 逐级检查后再创建，避免 recursive mkdir 先穿过外部 junction/symlink 产生越界副作用。
  let currentPath = resolvedBaseDir;
  for (const segment of relativeDirPath.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    let currentStats;
    try {
      currentStats = await lstat(currentPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
      try {
        await mkdir(currentPath);
      } catch (mkdirError) {
        if (mkdirError?.code !== 'EEXIST') {
          throw mkdirError;
        }
      }
      currentStats = await lstat(currentPath);
    }
    if (currentStats.isSymbolicLink()) {
      throw new Error(`${command} 目标目录不接受目录链接: ${toPosixPath(path.relative(resolvedBaseDir, currentPath))}`);
    }
    if (!currentStats.isDirectory()) {
      throw new Error(`${command} 目标路径不是目录: ${toPosixPath(path.relative(resolvedBaseDir, currentPath))}`);
    }
  }

  const [realBaseDir, realDirPath] = await Promise.all([
    realpath(resolvedBaseDir),
    realpath(resolvedDirPath),
  ]);
  if (!isPathWithinRoot(path.relative(realBaseDir, realDirPath))) {
    throw new Error(`${command} 目标目录真实路径越出当前知识库: ${toPosixPath(relativeDirPath)}`);
  }
}

export async function isExistingDirectory(dirPath) {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function appendNumericSuffix(filePath, suffix) {
  const extension = path.extname(filePath);
  return `${filePath.slice(0, -extension.length)}-${suffix}${extension}`;
}

export function createTemporaryPath(filePath, purpose) {
  temporaryFileSequence += 1;
  return path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${purpose}-${process.pid}-${Date.now()}-${temporaryFileSequence}.tmp`,
  );
}

export function resolveKnowledgeContext({ rootDir, knowledgeRoot } = {}) {
  const explicitKnowledgeRoot = knowledgeRoot || (!rootDir ? process.env.AGENT_KNOWLEDGE_ROOT : '');

  if (explicitKnowledgeRoot) {
    return {
      baseDir: path.resolve(explicitKnowledgeRoot),
      repositoryPrefix: '',
    };
  }

  const resolvedRoot = resolveRootDir(rootDir);
  return {
    baseDir: path.join(resolvedRoot, 'agent-knowledge'),
    repositoryPrefix: 'agent-knowledge',
  };
}

export function resolveRootDir(rootDir) {
  if (rootDir) {
    return path.resolve(rootDir);
  }

  const cwdRoot = resolveRootDirFromDirectory(process.cwd());
  if (cwdRoot) {
    return cwdRoot;
  }

  const moduleRoot = resolveRootDirFromModulePath();
  if (moduleRoot) {
    return moduleRoot;
  }

  throw new Error('无法定位包含 agent-knowledge 的仓库根目录，请在仓库根或 agent-knowledge 目录运行。');
}

function resolveRootDirFromDirectory(dir) {
  if (existsSync(path.join(dir, 'agent-knowledge', 'package.json'))) {
    return dir;
  }

  if (path.basename(dir) === 'agent-knowledge' && existsSync(path.join(dir, 'package.json'))) {
    return path.dirname(dir);
  }

  return null;
}

function resolveRootDirFromModulePath() {
  const agentKnowledgeDir = path.dirname(path.dirname(modulePath));
  if (path.basename(agentKnowledgeDir) !== 'agent-knowledge') {
    return null;
  }

  if (!existsSync(path.join(agentKnowledgeDir, 'package.json'))) {
    return null;
  }

  return path.dirname(agentKnowledgeDir);
}

export async function collectMarkdownFiles(agentKnowledgeDir) {
  const roots = [
    path.join(agentKnowledgeDir, 'knowledge'),
    path.join(agentKnowledgeDir, 'inbox'),
  ];
  const files = [];
  const resolvedKnowledgeRoot = await resolveRealPathIfExists(agentKnowledgeDir);
  if (!resolvedKnowledgeRoot) {
    return files;
  }

  for (const root of roots) {
    await collectMarkdownFilesUnder(
      root,
      files,
      agentKnowledgeDir,
      resolvedKnowledgeRoot,
    );
  }

  return files;
}

async function collectMarkdownFilesUnder(dir, files, baseDir, resolvedBaseDir) {
  const directoryInfo = await inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, dir);
  if (!directoryInfo?.stats.isDirectory()) {
    return;
  }

  const entries = await readdir(dir);
  for (const entry of entries) {
    const entryPath = path.join(dir, entry);
    const entryInfo = await inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, entryPath);
    if (entryInfo?.stats.isDirectory()) {
      await collectMarkdownFilesUnder(entryPath, files, baseDir, resolvedBaseDir);
    } else if (entryInfo?.stats.isFile() && entry.endsWith('.md')) {
      files.push(entryPath);
    }
  }
}

export async function resolveRealPathIfExists(filePath) {
  try {
    return await realpath(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function inspectMarkdownCollectionPath(baseDir, resolvedBaseDir, entryPath) {
  if (!resolvedBaseDir || !isPathWithinRoot(path.relative(baseDir, entryPath))) {
    return null;
  }

  try {
    const stats = await lstat(entryPath);
    if (stats.isSymbolicLink()) {
      return null;
    }
    const resolvedEntry = await realpath(entryPath);
    if (!isPathWithinRoot(path.relative(resolvedBaseDir, resolvedEntry))) {
      return null;
    }
    return { stats, resolvedEntry };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function readDoctorMarkdownFile(baseDir, resolvedBaseDir, filePath) {
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

export async function parseMarkdownFile(knowledgeContext, filePath) {
  const raw = await readFile(filePath, 'utf8');
  const parsedFrontmatter = parseFrontmatter(raw);
  const heading = parsedFrontmatter.body.match(/^#\s+(.+)$/m);
  const relativePath = toPosixPath(path.relative(knowledgeContext.baseDir, filePath));
  const repositoryPath = knowledgeContext.repositoryPrefix
    ? toPosixPath(path.join(knowledgeContext.repositoryPrefix, relativePath))
    : relativePath;

  return {
    fileName: path.basename(filePath),
    relativePath,
    repositoryPath,
    frontmatter: parsedFrontmatter.frontmatter,
    title: heading?.[1]?.trim() ?? '',
    body: parsedFrontmatter.body,
  };
}

export function parseFrontmatter(raw) {
  const normalized = raw.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return {
      frontmatter: '',
      body: raw,
    };
  }

  const closingIndex = normalized.indexOf('\n---\n', 4);
  if (closingIndex === -1) {
    return {
      frontmatter: '',
      body: raw,
    };
  }

  return {
    frontmatter: normalized.slice(4, closingIndex),
    body: normalized.slice(closingIndex + 5),
  };
}

export function readFrontmatterField(frontmatter, field) {
  const escapedField = escapeRegExp(field);
  const match = frontmatter.match(new RegExp(`^${escapedField}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) {
    return '';
  }

  return match[1].replace(/^['"]|['"]$/g, '').trim();
}

export function hasFrontmatterField(frontmatter, field) {
  return new RegExp(`^${escapeRegExp(field)}:\\s*.*$`, 'm').test(frontmatter);
}

export function updateFrontmatterFields(frontmatter, fields) {
  let nextFrontmatter = frontmatter.trimEnd();

  for (const [field, value] of Object.entries(fields)) {
    const escapedField = escapeRegExp(field);
    const line = `${field}: ${value}`;
    const pattern = new RegExp(`^${escapedField}:.*$`, 'm');
    if (pattern.test(nextFrontmatter)) {
      nextFrontmatter = nextFrontmatter.replace(pattern, line);
    } else {
      nextFrontmatter = nextFrontmatter ? `${nextFrontmatter}\n${line}` : line;
    }
  }

  return nextFrontmatter;
}

export function appendRefreshRecord(body, { date, commit, summary } = {}) {
  const normalizedBody = body.startsWith('\n') ? body : `\n${body}`;
  const cleanBody = normalizedBody.endsWith('\n') ? normalizedBody : `${normalizedBody}\n`;
  const cleanSummary = summary?.trim() || '已根据项目当前 HEAD 确认知识条目。';
  const entry = `- ${date}: refreshed against ${commit.slice(0, 12)}. ${cleanSummary}`;

  if (cleanBody.includes('\n## 刷新记录\n')) {
    return `${cleanBody.trimEnd()}\n${entry}\n`;
  }

  return `${cleanBody.trimEnd()}\n\n## 刷新记录\n\n${entry}\n`;
}

export async function readGitHead(projectRoot) {
  const { stdout } = await execFileAsync('git', ['-C', path.resolve(projectRoot), 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  });
  return stdout.trim();
}

export async function readTemplate(agentKnowledgeDir, templateName) {
  const templatePath = path.join(agentKnowledgeDir, 'templates', templateName);
  if (existsSync(templatePath)) {
    return readFile(templatePath, 'utf8');
  }

  // Tests pass an empty temporary rootDir; keep writes there but read packaged templates.
  return readFile(path.join(path.dirname(modulePath), '..', 'templates', templateName), 'utf8');
}

export function applyTemplateFields(template, fields) {
  let content = template;

  // Templates use simple frontmatter fields, so keep replacement textual and dependency-free.
  for (const [field, value] of Object.entries(fields)) {
    content = content.replace(new RegExp(`^${escapeRegExp(field)}:.*$`, 'm'), `${field}: ${value}`);
  }

  return content.replaceAll('{{title}}', fields.title);
}

export function slugify(title) {
  return title
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join('-') ?? '';
}

export function timestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}${values.month}${values.day}`;
  const time = `${values.hour}${values.minute}${values.second}`;

  return {
    date,
    compact: `${date}-${time}`,
    isoDate: `${values.year}-${values.month}-${values.day}`,
  };
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
