#!/usr/bin/env node

import { readdir, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'the',
  'that',
  'these',
  'this',
  'those',
  'to',
  'with',
]);

const FIX_TYPE_DIRS = {
  bug: ['inbox', 'fixes'],
  prd: ['inbox', 'prd-corrections'],
  tech: ['inbox', 'tech-solution-corrections'],
};

export function extractKeywords(text = '') {
  const keywords = [];
  const seen = new Set();

  function addKeyword(keyword) {
    if (!keyword) {
      return;
    }

    if (/^[A-Za-z]+$/.test(keyword)) {
      const normalized = keyword.toLowerCase();
      if (keyword.length < 2 || STOP_WORDS.has(normalized)) {
        return;
      }
    }

    if (!seen.has(keyword)) {
      seen.add(keyword);
      keywords.push(keyword);
    }
  }

  for (const match of text.matchAll(/[\p{Script=Han}]{2,}|[A-Za-z0-9_]+/gu)) {
    const keyword = match[0];
    addKeyword(keyword);

    if (/^[A-Za-z0-9_]+$/.test(keyword)) {
      for (const part of splitIdentifier(keyword)) {
        addKeyword(part);
      }
    }
  }

  return keywords;
}

function splitIdentifier(identifier) {
  if (!/[A-Z]/.test(identifier) || /_/.test(identifier)) {
    return [];
  }

  return identifier.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|$)|\d+/g) ?? [];
}

export async function searchKnowledge({ rootDir, knowledgeRoot, query } = {}) {
  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const keywords = extractKeywords(query);
  const files = await collectMarkdownFiles(knowledgeContext.baseDir);
  const results = [];

  for (const filePath of files) {
    const parsed = await parseMarkdownFile(knowledgeContext, filePath);
    const scored = scoreMarkdownFile(parsed, keywords);
    if (scored.score > 0) {
      results.push({
        path: parsed.relativePath,
        filePath,
        relativePath: parsed.relativePath,
        repositoryPath: parsed.repositoryPath,
        score: scored.score,
        hits: scored.hits,
        title: parsed.title,
        pending: parsed.relativePath.startsWith('inbox/'),
      });
    }
  }

  return results.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.relativePath.localeCompare(right.relativePath);
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
  const filePath = path.join(targetDir, fileName);

  await mkdir(targetDir, { recursive: true });
  await writeFile(filePath, content, { encoding: 'utf8' });

  return { path: filePath };
}

export async function recordFix({ rootDir, knowledgeRoot, type, title } = {}) {
  if (!FIX_TYPE_DIRS[type]) {
    throw new Error('recordFix requires --type <bug|prd|tech>');
  }

  const knowledgeContext = resolveKnowledgeContext({ rootDir, knowledgeRoot });
  const targetDir = path.join(knowledgeContext.baseDir, ...FIX_TYPE_DIRS[type]);
  const stamp = timestamp();
  const effectiveTitle = title || `fix-${stamp.compact}`;
  const slug = title ? slugify(title) : '';
  const fileName = slug ? `${stamp.date}-${slug}.md` : `fix-${stamp.compact}.md`;
  const template = await readTemplate(knowledgeContext.baseDir, 'fix-record.md');
  const content = applyTemplateFields(template, {
    title: effectiveTitle,
    type,
    status: 'pending',
    updated: stamp.isoDate,
  });
  const filePath = path.join(targetDir, fileName);

  await mkdir(targetDir, { recursive: true });
  await writeFile(filePath, content, { encoding: 'utf8' });

  return { path: filePath };
}

function resolveKnowledgeContext({ rootDir, knowledgeRoot } = {}) {
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

function resolveRootDir(rootDir) {
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

async function collectMarkdownFiles(agentKnowledgeDir) {
  const roots = [
    path.join(agentKnowledgeDir, 'knowledge'),
    path.join(agentKnowledgeDir, 'inbox'),
  ];
  const files = [];

  for (const root of roots) {
    if (existsSync(root)) {
      await collectMarkdownFilesUnder(root, files);
    }
  }

  return files;
}

async function collectMarkdownFilesUnder(dir, files) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectMarkdownFilesUnder(entryPath, files);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(entryPath);
    }
  }
}

async function parseMarkdownFile(knowledgeContext, filePath) {
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

function parseFrontmatter(raw) {
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

function scoreMarkdownFile(parsed, keywords) {
  let score = 0;
  const hitSet = new Set();

  for (const keyword of keywords) {
    const needle = keyword.toLowerCase();
    score += scoreField(parsed.fileName, needle, 8, hitSet, '文件名');
    score += scoreField(parsed.title, needle, 8, hitSet, '标题');
    score += scoreField(parsed.frontmatter, needle, 6, hitSet, 'frontmatter');
    score += scoreField(parsed.body, needle, 2, hitSet, '正文');
  }

  if (score > 0 && parsed.relativePath.startsWith('knowledge/')) {
    score += 2;
  }

  return {
    score,
    hits: [...hitSet],
  };
}

function scoreField(value, needle, points, hitSet, hitName) {
  if (value.toLowerCase().includes(needle)) {
    hitSet.add(hitName);
    return points;
  }

  return 0;
}

async function readTemplate(agentKnowledgeDir, templateName) {
  const templatePath = path.join(agentKnowledgeDir, 'templates', templateName);
  if (existsSync(templatePath)) {
    return readFile(templatePath, 'utf8');
  }

  // Tests pass an empty temporary rootDir; keep writes there but read packaged templates.
  return readFile(path.join(path.dirname(modulePath), '..', 'templates', templateName), 'utf8');
}

function applyTemplateFields(template, fields) {
  let content = template;

  // Templates use simple frontmatter fields, so keep replacement textual and dependency-free.
  for (const [field, value] of Object.entries(fields)) {
    content = content.replace(new RegExp(`^${escapeRegExp(field)}:.*$`, 'm'), `${field}: ${value}`);
  }

  return content.replaceAll('{{title}}', fields.title);
}

function slugify(title) {
  return title
    .toLowerCase()
    .match(/[a-z0-9]+/g)
    ?.join('-') ?? '';
}

function timestamp(now = new Date()) {
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

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatSearchOutput(query, results) {
  const keywords = extractKeywords(query);
  const lines = [
    `关键词列表：${keywords.length ? keywords.join(', ') : '无'}`,
    '命中文件：',
  ];

  if (results.length === 0) {
    lines.push('- 无');
  } else {
    for (const result of results) {
      const pending = result.pending ? '（待确认）' : '';
      lines.push(`- ${result.repositoryPath}${pending} | 分数：${result.score} | 命中位置：${result.hits.join(', ')}`);
    }
  }

  return lines.join('\n');
}

function formatBeforeTaskOutput(query, results) {
  const keywords = extractKeywords(query);
  const required = results.filter((result) => result.score >= 8 && result.relativePath.startsWith('knowledge/'));
  const related = results.filter((result) => !required.includes(result));
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
    lines.push(`- ${result.repositoryPath}${pending} | 分数：${result.score} | 命中位置：${result.hits.join(', ')}`);
  }
}

function usage() {
  return [
    '用法：agent-knowledge <command> [args]',
    '',
    '命令：',
    '  before-task <text>                              输出任务前知识提示',
    '  search <text>                                   搜索知识库',
    '  add-rule <title> [--confirmed]                  新增规则草稿或确认规则',
    '  record-fix --type <bug|prd|tech> --title <title> 记录修复经验',
    '',
    '选项：',
    '  --knowledge-root <path>                         使用分离的私有知识库根目录',
    '  AGENT_KNOWLEDGE_ROOT                            未传参数时使用的知识库根目录环境变量',
    '  --help                                          显示帮助',
  ].join('\n');
}

async function main(argv) {
  const [command, ...args] = argv;
  const globalOptions = parseGlobalOptions(args);

  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return 0;
  }

  if (command === 'search') {
    const query = globalOptions.args.join(' ').trim();
    const results = await searchKnowledge({
      query,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(formatSearchOutput(query, results));
    return 0;
  }

  if (command === 'before-task') {
    const query = globalOptions.args.join(' ').trim();
    const results = await searchKnowledge({
      query,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(formatBeforeTaskOutput(query, results));
    return 0;
  }

  if (command === 'add-rule') {
    const confirmed = globalOptions.args.includes('--confirmed');
    const title = globalOptions.args.filter((arg) => arg !== '--confirmed').join(' ').trim();
    const result = await addRule({
      title,
      confirmed,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(`已写入：${result.path}`);
    return 0;
  }

  if (command === 'record-fix') {
    const options = parseOptions(globalOptions.args);
    const result = await recordFix({
      type: options.type,
      title: options.title,
      knowledgeRoot: globalOptions.knowledgeRoot,
    });
    console.log(`已写入：${result.path}`);
    return 0;
  }

  console.error(`未知命令：${command}\n\n${usage()}`);
  return 1;
}

function parseGlobalOptions(args) {
  const remainingArgs = [];
  const options = {
    args: remainingArgs,
    knowledgeRoot: '',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--knowledge-root=')) {
      options.knowledgeRoot = arg.slice('--knowledge-root='.length);
    } else if (arg === '--knowledge-root') {
      options.knowledgeRoot = args[index + 1] ?? '';
      index += 1;
    } else {
      remainingArgs.push(arg);
    }
  }

  return options;
}

function parseOptions(args) {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith('--type=')) {
      options.type = arg.slice('--type='.length);
    } else if (arg === '--type') {
      options.type = args[index + 1];
      index += 1;
    } else if (arg.startsWith('--title=')) {
      options.title = arg.slice('--title='.length);
    } else if (arg === '--title') {
      const titleParts = [];
      while (args[index + 1] && !args[index + 1].startsWith('--')) {
        titleParts.push(args[index + 1]);
        index += 1;
      }
      options.title = titleParts.join(' ');
    }
  }

  return options;
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
