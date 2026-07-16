import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectMarkdownFiles,
  escapeRegExp,
  parseMarkdownFile,
  readFrontmatterField,
  readGitHead,
  resolveKnowledgeContext,
} from './knowledge-files.js';

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
const MAX_MUST_READ_RESULTS = 5;
const MIN_MUST_READ_SCORE_RATIO = 0.6;
const modulePath = fileURLToPath(import.meta.url);

// --- 同义词 / 别名映射（增强召回） ---
// 同义词文件不存在时退化为无扩展；文件格式为 { 规范词: [别名...] }，
// 构建双向映射，使任一成员的命中都能扩展出整组候选词。
let synonymsCache = null;

function loadSynonyms() {
  if (synonymsCache) {
    return synonymsCache;
  }

  const candidate = path.join(path.dirname(modulePath), '..', 'synonyms.json');
  const groups = new Map();
  try {
    const raw = readFileSync(candidate, 'utf8');
    const data = JSON.parse(raw);
    for (const [canonical, aliases] of Object.entries(data)) {
      const terms = [];
      const normalizedTerms = new Set();
      for (const term of [canonical, ...(Array.isArray(aliases) ? aliases : [])]) {
        const normalized = normalizeSearchTerm(term);
        if (!normalized || normalizedTerms.has(normalized)) {
          continue;
        }
        normalizedTerms.add(normalized);
        terms.push(term);
      }
      const group = {
        key: [...normalizedTerms].sort().join('\u0000'),
        terms,
      };
      for (const normalized of normalizedTerms) {
        groups.set(normalized, group);
      }
    }
  } catch {
    // 同义词文件缺省时不影响主流程
  }

  synonymsCache = groups;
  return groups;
}

function buildQueryModel(query = '') {
  const queryTerms = extractKeywords(query);
  const synonymGroups = loadSynonyms();
  const groups = [];
  const groupKeys = new Set();
  for (const candidate of segmentChineseBigrams(queryTerms)) {
    const normalizedCandidate = normalizeSearchTerm(candidate);
    if (!normalizedCandidate) {
      continue;
    }
    const synonymGroup = synonymGroups.get(normalizedCandidate);
    const group = synonymGroup ?? {
      key: normalizedCandidate,
      terms: [candidate],
    };
    if (!groupKeys.has(group.key)) {
      groupKeys.add(group.key);
      groups.push(group);
    }
  }

  const expandedTerms = [];
  const expandedKeys = new Set();
  for (const group of groups) {
    for (const term of group.terms) {
      const normalized = normalizeSearchTerm(term);
      if (!expandedKeys.has(normalized)) {
        expandedKeys.add(normalized);
        expandedTerms.push(term);
      }
    }
  }

  return { queryTerms, groups, expandedTerms };
}

export function extractQueryKeywords(query = '') {
  return buildQueryModel(query).expandedTerms;
}

export function getQueryMetadata(query = '') {
  const { queryTerms, expandedTerms } = buildQueryModel(query);
  return {
    keywords: expandedTerms,
    queryTerms,
    expandedTerms,
  };
}

// 对长度 >= 3 的中文整词补充相邻 2-gram，使「队列为空」这类短语也能拆出「队列」命中同义词/知识标题。
// 仅作用于查询侧；extractKeywords 保持纯净以便单测断言顺序。
function segmentChineseBigrams(keywords) {
  const result = [...keywords];
  const seen = new Set(keywords);
  for (const keyword of keywords) {
    if (/^[\p{Script=Han}]+$/u.test(keyword) && keyword.length >= 3) {
      for (let index = 0; index + 1 < keyword.length; index += 1) {
        const gram = keyword.slice(index, index + 2);
        if (!seen.has(gram)) {
          seen.add(gram);
          result.push(gram);
        }
      }
    }
  }
  return result;
}

function toHalfWidth(text) {
  return String(text)
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

function normalizeSearchTerm(term) {
  return toHalfWidth(term).normalize('NFKC').trim().toLowerCase();
}

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
  const queryModel = buildQueryModel(query);
  const files = await collectMarkdownFiles(knowledgeContext.baseDir);
  const results = [];

  for (const filePath of files) {
    const parsed = await parseMarkdownFile(knowledgeContext, filePath);
    const scored = scoreMarkdownFile(parsed, queryModel);
    if (scored.score > 0) {
      const stale = await computeFileStale(parsed);
      results.push({
        path: parsed.relativePath,
        filePath,
        relativePath: parsed.relativePath,
        repositoryPath: parsed.repositoryPath,
        score: scored.score,
        hits: scored.hits,
        title: parsed.title,
        pending: parsed.relativePath.startsWith('inbox/'),
        coverage: scored.coverage,
        matched: scored.matched,
        total: scored.total,
        exactFile: scored.exactFile,
        exactTitle: scored.exactTitle,
        matchedTerms: scored.matchedTerms,
        reasonCodes: scored.reasonCodes,
        stale: stale.stale,
        staleReason: stale.reason,
        snippet: buildSnippet(parsed, queryModel.expandedTerms),
      });
    }
  }

  const sortedResults = results.sort((left, right) => {
    // 1) 覆盖率优先：命中的查询词比例越高越相关
    if (right.coverage !== left.coverage) {
      return right.coverage - left.coverage;
    }

    // 2) 标题 / 文件名整词精确命中加权
    const leftExact = (left.exactTitle ? 1 : 0) + (left.exactFile ? 1 : 0);
    const rightExact = (right.exactTitle ? 1 : 0) + (right.exactFile ? 1 : 0);
    if (rightExact !== leftExact) {
      return rightExact - leftExact;
    }

    // 3) 累计得分，4) 路径稳定排序
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return left.relativePath.localeCompare(right.relativePath);
  });
  applyMustReadClassification(sortedResults);
  return sortedResults;
}

function applyMustReadClassification(results) {
  const strongestScore = results.reduce((maximum, result) => Math.max(maximum, result.score), 0);
  let requiredCount = 0;
  for (const result of results) {
    const classification = classifyMustRead(result);
    if (!classification.mustRead) {
      result.mustRead = false;
      result.mustReadReason = classification.reason;
      continue;
    }
    // 必读会强制加载正文；与本次最强证据差距过大的候选只保留为相关项，避免泛化命中挤占上下文。
    if (result.score < strongestScore * MIN_MUST_READ_SCORE_RATIO) {
      result.mustRead = false;
      result.mustReadReason = 'related_score_gap';
      continue;
    }
    if (requiredCount >= MAX_MUST_READ_RESULTS) {
      result.mustRead = false;
      result.mustReadReason = 'must_read_limit';
      continue;
    }
    requiredCount += 1;
    result.mustRead = true;
    result.mustReadReason = classification.reason;
  }
}

function classifyMustRead(result) {
  if (!result.relativePath.startsWith('knowledge/')) {
    return { mustRead: false, reason: 'related_unconfirmed' };
  }
  if (result.matched === 0 || result.coverage < 0.5) {
    return { mustRead: false, reason: 'related_low_confidence' };
  }
  if (result.hits.includes('标题')) {
    return { mustRead: true, reason: 'high_coverage_title' };
  }
  if (result.hits.includes('文件名')) {
    return { mustRead: true, reason: 'high_coverage_filename' };
  }
  if (result.hits.includes('frontmatter')) {
    return { mustRead: true, reason: 'high_coverage_frontmatter' };
  }
  if (result.coverage >= 0.6 && result.matched >= 2) {
    return { mustRead: true, reason: 'high_coverage_body' };
  }
  return { mustRead: false, reason: 'related_low_confidence' };
}

function scoreMarkdownFile(parsed, queryModel) {
  let score = 0;
  const hitSet = new Set();
  const reasonCodes = new Set();
  const matchedTermsByGroup = new Map();

  for (const group of queryModel.groups) {
    score += scoreGroupField(parsed.fileName, group, 8, {
      hitSet,
      hitName: '文件名',
      reasonCodes,
      reasonCode: 'filename',
      matchedTermsByGroup,
    });
    score += scoreGroupField(parsed.title, group, 8, {
      hitSet,
      hitName: '标题',
      reasonCodes,
      reasonCode: 'title',
      matchedTermsByGroup,
    });
    score += scoreGroupField(parsed.frontmatter, group, 6, {
      hitSet,
      hitName: 'frontmatter',
      reasonCodes,
      reasonCode: 'frontmatter',
      matchedTermsByGroup,
    });
    score += scoreGroupField(parsed.body, group, 2, {
      hitSet,
      hitName: '正文',
      reasonCodes,
      reasonCode: 'body',
      matchedTermsByGroup,
    });
  }

  // 标题 / 文件名整词精确命中加权，避免长正文靠堆砌零散词胜出
  let exactFile = false;
  let exactTitle = false;
  const baseName = normalizeSearchTerm(parsed.fileName.replace(/\.md$/i, ''));
  const normalizedTitle = normalizeSearchTerm(parsed.title);
  for (const group of queryModel.groups) {
    if (group.terms.some((term) => isExactTermMatch(baseName, term))) {
      score += 4;
      exactFile = true;
    }
    if (group.terms.some((term) => isExactTermMatch(normalizedTitle, term))) {
      score += 4;
      exactTitle = true;
    }
  }

  if (score > 0 && parsed.relativePath.startsWith('knowledge/')) {
    score += 2;
  }

  const matched = matchedTermsByGroup.size;
  const total = queryModel.groups.length;
  const coverage = total > 0 ? matched / total : 0;

  return {
    score,
    hits: [...hitSet],
    coverage,
    matched,
    total,
    exactFile,
    exactTitle,
    matchedTerms: queryModel.groups
      .filter((group) => matchedTermsByGroup.has(group.key))
      .map((group) => matchedTermsByGroup.get(group.key)),
    reasonCodes: [...reasonCodes],
  };
}

function scoreGroupField(value, group, points, {
  hitSet,
  hitName,
  reasonCodes,
  reasonCode,
  matchedTermsByGroup,
}) {
  const matchedTerm = findMatchingGroupTerm(value, group);
  if (!matchedTerm) {
    return 0;
  }

  hitSet.add(hitName);
  reasonCodes.add(reasonCode);
  if (!matchedTermsByGroup.has(group.key)) {
    matchedTermsByGroup.set(group.key, normalizeSearchTerm(matchedTerm));
  }
  return points;
}

function findMatchingGroupTerm(value, group) {
  const normalizedValue = normalizeSearchTerm(value);
  return group.terms.find((term) => normalizedValue.includes(normalizeSearchTerm(term))) ?? '';
}

function isExactTermMatch(normalizedValue, term) {
  const normalizedTerm = normalizeSearchTerm(term);
  const wordBoundary = new RegExp(`(^|[^a-z0-9])${escapeRegExp(normalizedTerm)}([^a-z0-9]|$)`, 'i');
  return wordBoundary.test(normalizedValue);
}

// 根据文件 frontmatter 的 project_root + last_scanned_commit 判断知识是否可能落后于项目 HEAD。
// 非 knowledge/ 文件、缺少字段或 git 不可用时均视为「未知（不告警）」，失败被吞掉以避免阻断检索。
async function computeFileStale(parsed) {
  if (!parsed.relativePath.startsWith('knowledge/')) {
    return { stale: false, reason: '' };
  }

  const projectRoot = readFrontmatterField(parsed.frontmatter, 'project_root');
  const scannedCommit = readFrontmatterField(parsed.frontmatter, 'last_scanned_commit');
  if (!projectRoot || !scannedCommit) {
    return { stale: false, reason: '' };
  }

  try {
    const currentCommit = await readGitHead(projectRoot);
    const stale = scannedCommit !== currentCommit;
    return {
      stale,
      reason: stale ? 'commit_changed' : 'fresh',
    };
  } catch {
    return { stale: false, reason: '' };
  }
}

// 取首个命中关键词的附近行作为摘要，减少 Agent 逐一打开文件的成本。
function buildSnippet(parsed, keywords) {
  const lines = [parsed.title, ...parsed.body.split('\n')];
  for (const line of lines) {
    const lower = toHalfWidth(line).toLowerCase();
    for (const keyword of keywords) {
      if (lower.includes(toHalfWidth(keyword).toLowerCase())) {
        const trimmed = line.trim();
        return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
      }
    }
  }

  return '';
}
