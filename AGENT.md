# AGENT.md

## Purpose

This document defines **how coding agents (ClaudeCode / Codex / OpenCode, etc.) are expected to be used in this repository**.

The goal is not to slow development down, but to **preserve engineering correctness, simplicity, and accountability** while taking advantage of agent-driven leverage.

These guidelines are written **for agents to read**, and **for engineers to enforce**.

---

## Core Assumption

Agents are powerful, fast, and tireless — but they are also:

* Confident even when wrong
* Prone to silent assumptions
* Biased toward over-design
* Willing to modify code they do not fully understand

**Therefore: agents amplify judgment; they do not replace it.**

---

## 1. Think Before Coding

**Do not assume. Do not hide confusion. Surface tradeoffs.**

Before writing or modifying code, the agent MUST:

* Explicitly state key assumptions
* Ask questions when information is missing or ambiguous
* Present multiple reasonable interpretations if they exist
* Call out simpler approaches when applicable
* Push back when requirements appear unnecessary or harmful

If something is unclear:

* Stop
* Name what is confusing
* Ask

Silent decision-making is not allowed.

---

## 2. Simplicity First

**Write the minimum code that solves the problem. Nothing speculative.**

Constraints:

* Do not add features beyond what was requested
* Do not introduce abstractions for single-use code
* Do not add configurability or flexibility unless explicitly required
* Do not add error handling for impossible or undefined scenarios

Rule of thumb:

> If 200 lines can be written as 50, rewrite it.

Self-check:

> Would a senior engineer say this is overcomplicated?
> If yes — simplify.

---

## 3. Surgical Changes Only

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

* Do NOT refactor unrelated code
* Do NOT improve adjacent code, comments, or formatting
* Do NOT change existing style to your preference
* Match the surrounding style exactly

If unrelated dead code is noticed:

* Mention it
* Do NOT remove it unless explicitly asked

When your changes create orphans:

* Remove imports / variables / functions made unused by YOUR changes
* Do NOT remove pre-existing dead code

Test:

> Every changed line must trace directly to the user request.

---

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform vague tasks into verifiable goals:

* "Add validation" → write failing tests, then make them pass
* "Fix bug" → reproduce with a test, then fix
* "Refactor" → ensure tests pass before and after

For multi-step tasks:
Provide a brief plan:

1. Step → verify: check
2. Step → verify: check
3. Step → verify: check

Strong success criteria enable autonomous looping.
Weak criteria require constant human correction.

---

## 5. Assume You Might Be Wrong

**The agent must default to skepticism toward its own output.**

Therefore:

* Highlight assumptions explicitly
* Flag areas of uncertainty
* Call out code paths that deserve extra human review

Engineering rule:

> The more confident, clean, and complete the solution appears,
> the more carefully it should be reviewed.

---

## IDE Requirement

All non-trivial or production-impacting code MUST:

* Be fully reviewed in an IDE
* Be understood end-to-end by a human
* Meet the same quality bar as hand-written code

Agents do not bypass code review standards.

---

## Summary

* Agents execute; humans decide
* Simplicity beats cleverness
* Explicit assumptions beat silent ones
* Goals beat instructions
* IDEs are safety equipment, not optional tooling

**We use agents to scale engineering judgment — not to outsource it.**

---

## 团队知识库钩子

在分析需求、BUG 或技术方案前，先运行团队知识库钩子：

```bash
agent-knowledge before-task "<任务描述>"
```

如果本机未安装全局 `agent-knowledge` 命令，从仓库根目录使用稳定 Node 入口：

```bash
node agent-knowledge/bin/agent-knowledge.js before-task "<任务描述>"
```

如果输出中出现“必须阅读”，必须先按路径读完所有必须阅读项，再给出结论、方案或修改建议。`before-task` 的输出只是知识入口，仍需沿真实代码路径确认失败点、最终数据源和关键参数。

发生人工纠正后，使用 `record-fix` 记录纠错材料：

```bash
agent-knowledge record-fix --type <bug|prd|tech> --title "<纠错标题>"
```

未安装全局命令时，从仓库根目录使用：

```bash
node agent-knowledge/bin/agent-knowledge.js record-fix --type <bug|prd|tech> --title "<纠错标题>"
```

`bug` 用于 BUG 分析纠错，`prd` 用于需求或 PRD 理解纠错，`tech` 用于技术方案纠错。

`knowledge/` 存放已经确认的团队知识，可作为稳定约束并结合当前代码证据验证；`inbox/` 存放待确认材料，只能作为线索和复盘入口，不能当成强规则直接套用。
