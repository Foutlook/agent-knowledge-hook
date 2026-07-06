# Agent Knowledge Hook

面向 Codex、Claude、OpenCode 等 AI 编程工具的团队知识库命令式钩子。

它解决的问题是：AI 在分析需求、BUG 或技术方案时，不能只靠临时代码搜索，还需要先读取团队已经确认过的业务知识、服务边界、历史坑和人工纠错记录，避免反复踩同一个问题。

## 快速使用

从仓库根目录运行：

```powershell
node agent-knowledge/bin/agent-knowledge.js before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

Windows PowerShell 包装器：

```powershell
powershell -ExecutionPolicy Bypass -File .\agent-knowledge\bin\agent-knowledge.ps1 before-task "修复 queryEntityGraph 实体图谱 ownerId 为空"
```

搜索知识库：

```powershell
node agent-knowledge/bin/agent-knowledge.js search "RPC 本地依赖"
```

## 项目结构

- `agent-knowledge/`：核心 CLI、模板、知识库和测试。
- `agent-knowledge/knowledge/`：已确认的长期知识。
- `agent-knowledge/inbox/`：待确认规则草稿和纠错记录。
- `agent-knowledge/tool-adapters/`：Codex / Claude / OpenCode 接入说明。
- `.opencode/command/`：OpenCode 命令入口。
- `docs/superpowers/`：设计文档和实施计划。
- `AGENT.md`：通用 AI 使用规范和知识库钩子入口规则。

## 验证

```powershell
Push-Location agent-knowledge
npm.cmd run test
Pop-Location
```

当前测试覆盖关键词提取、搜索排序、路径推导、写入目录、纠错记录模板和 UTF-8 无 BOM 写入。

