import { readFile } from 'node:fs/promises';

const defaultContractUrl = new URL('../command-contract.json', import.meta.url);
const writeModeLabels = {
  never: '否',
  always: '是',
  conditional: '视参数而定',
};
const commandNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const commonStringFields = ['id', 'name', 'args', 'summary'];
const allowedWriteModes = new Set(Object.keys(writeModeLabels));
const allowedWrappers = new Set(['wrapper:projects', 'wrapper:raw']);

export function validateCommandContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error('命令契约必须是对象');
  }
  if (contract.version !== 1) {
    throw new Error('命令契约字段 version 必须严格等于 1');
  }
  if (!Array.isArray(contract.cliCommands)) {
    throw new Error('命令契约字段 cliCommands 必须是数组');
  }
  if (!Array.isArray(contract.akCommands)) {
    throw new Error('命令契约字段 akCommands 必须是数组');
  }

  validateCommandCollection(contract.cliCommands, 'cliCommands', false);
  validateCommandCollection(contract.akCommands, 'akCommands', true);
  validateAkCommandNamespace(contract.akCommands);
  validateAkMappings(contract.cliCommands, contract.akCommands);
  return contract;
}

export async function loadCommandContract(filePath = defaultContractUrl) {
  const raw = await readFile(filePath, 'utf8');
  return validateCommandContract(JSON.parse(raw));
}

export function renderCliUsage(contract) {
  return contract.cliCommands
    .map((command) => `  ${renderCommand(command)}  ${command.summary}`)
    .join('\n');
}

export function renderAkBasicUsage(contract) {
  const commandLines = contract.akCommands
    .map((command) => `  ${renderCommand(command, 'ak ')}  ${command.summary}`);
  return [
    'ak: agent-knowledge short commands',
    '',
    'Commands:',
    ...commandLines,
  ].join('\n');
}

export function renderAkCommandTable(contract) {
  return [
    '| 短命令 | 作用 |',
    '| --- | --- |',
    ...contract.akCommands.map((command) => (
      `| \`${escapeMarkdown(renderCommand(command, 'ak '))}\` | ${escapeMarkdown(command.summary)} |`
    )),
  ].join('\n');
}

export function renderCliCommandTable(contract) {
  return [
    '| 命令 | 什么时候用 | 是否写文件 |',
    '| --- | --- | --- |',
    ...contract.cliCommands.map((command) => (
      `| \`${escapeMarkdown(renderCommand(command))}\` | ${escapeMarkdown(command.summary)} | ${writeModeLabels[command.writeMode]} |`
    )),
  ].join('\n');
}

export function renderCliCommandList(contract) {
  return [
    '```text',
    ...contract.cliCommands.map((command) => renderCommand(command, 'agent-knowledge ')),
    '```',
  ].join('\n');
}

function renderCommand(command, prefix = '') {
  return `${prefix}${command.name}${command.args ? ` ${command.args}` : ''}`;
}

function escapeMarkdown(value) {
  return value.replaceAll('|', '\\|');
}

function validateCommandCollection(commands, collectionName, isAkCommand) {
  const ids = new Set();
  const names = new Set();

  for (const [index, command] of commands.entries()) {
    const context = `${collectionName}[${index}]`;
    if (!command || typeof command !== 'object' || Array.isArray(command)) {
      throw new Error(`${context} 必须是对象`);
    }

    for (const field of commonStringFields) {
      validateTextField(command[field], `${context}.${field}`, field === 'args');
    }
    validateCommandName(command.name, `${context}.name`);

    if (!allowedWriteModes.has(command.writeMode)) {
      throw new Error(`${context}.writeMode 必须是 never、always 或 conditional`);
    }
    if (typeof command.jsonOutput !== 'boolean') {
      throw new Error(`${context}.jsonOutput 必须是布尔值`);
    }
    if (ids.has(command.id)) {
      throw new Error(`${context}.id 与同一集合中的已有 id 重复：${command.id}`);
    }
    if (names.has(command.name)) {
      throw new Error(`${context}.name 与同一集合中的已有命令名重复：${command.name}`);
    }
    ids.add(command.id);
    names.add(command.name);

    if (isAkCommand) {
      validateAkFields(command, context);
    }
  }
}

function validateTextField(value, context, allowEmpty = false) {
  if (typeof value !== 'string') {
    throw new Error(`${context} 必须是字符串`);
  }
  if (!allowEmpty && value.length === 0) {
    throw new Error(`${context} 不能为空`);
  }
  if (/[\r\n`]/u.test(value)) {
    throw new Error(`${context} 必须是单行文本且不能包含反引号`);
  }
}

function validateCommandName(value, context) {
  if (!commandNamePattern.test(value)) {
    throw new Error(`${context} 只允许小写字母、数字和单个连字符分隔`);
  }
}

function validateAkFields(command, context) {
  if (!Array.isArray(command.aliases)) {
    throw new Error(`${context}.aliases 必须是数组`);
  }
  for (const [aliasIndex, alias] of command.aliases.entries()) {
    const aliasContext = `${context}.aliases[${aliasIndex}]`;
    validateTextField(alias, aliasContext);
    validateCommandName(alias, aliasContext);
  }
  validateTextField(command.mapsTo, `${context}.mapsTo`);
}

function validateAkCommandNamespace(commands) {
  // PowerShell 路由在同一命名空间解析主命令和别名，任何重复都会造成说明歧义。
  const names = new Map(commands.map((command, index) => [command.name, `akCommands[${index}].name`]));
  const aliases = new Map();

  for (const [commandIndex, command] of commands.entries()) {
    for (const [aliasIndex, alias] of command.aliases.entries()) {
      const context = `akCommands[${commandIndex}].aliases[${aliasIndex}]`;
      if (names.has(alias)) {
        throw new Error(`${context} 与主命令 ${names.get(alias)} 冲突：${alias}`);
      }
      if (aliases.has(alias)) {
        throw new Error(`${context} 与别名 ${aliases.get(alias)} 冲突：${alias}`);
      }
      aliases.set(alias, context);
    }
  }
}

function validateAkMappings(cliCommands, akCommands) {
  const cliNames = new Set(cliCommands.map(({ name }) => name));
  for (const [index, command] of akCommands.entries()) {
    if (!cliNames.has(command.mapsTo) && !allowedWrappers.has(command.mapsTo)) {
      throw new Error(`akCommands[${index}].mapsTo 必须指向已登记 CLI 命令或白名单 wrapper：${command.mapsTo}`);
    }
  }
}
