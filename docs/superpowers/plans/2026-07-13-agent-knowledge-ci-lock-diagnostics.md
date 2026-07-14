# Agent Knowledge 最小 CI 与孤儿锁诊断实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Every behavior change follows RED-GREEN and preserves UTF-8 without BOM.

**Goal:** 在不引入无法证明安全的自动解锁逻辑前提下，让孤儿锁可诊断、活锁不被误删，并用最小 CI 阻止测试、适配器和示例知识库健康状态回归。

**Architecture:** 保留现有“持有 reclaim guard 时回收已退出进程主锁”的流程。对 orphan reclaim guard 不做自动删除，因为零依赖 Node 文件 API 无法提供 compare-and-unlink，多个回收者会产生 ABA 误删活 guard。`doctor` 只读扫描知识库内已知锁位置并报告 orphan/invalid 状态，锁获取继续安全超时。GitHub Actions 运行可重复的本仓库门禁，不访问私有团队知识库。

**Tech Stack:** Node.js ESM、`node:test`、GitHub Actions。

**Prerequisite:** `docs/superpowers/plans/2026-07-13-fix-resolution.md` 已完成；resolve 的固定锁路径已存在。

**Execution note:** 当前共享 `main` 工作区已有同一优化链路的未提交修改。本计划直接在当前工作区执行，不创建 worktree、不自动暂存、不提交 Git。

---

### Task 1: 孤儿锁只读诊断与安全退化

**Files:**
- Modify: `agent-knowledge/bin/agent-knowledge.js`
- Modify: `agent-knowledge/tests/agent-knowledge.test.js`
- Modify: `agent-knowledge/README.md`
- Modify: `agent-knowledge/help/ak.zh-CN.txt`

- [x] **Step 1: 写 doctor 锁诊断失败测试**

在知识库内创建相邻主 `.lock`、`.lock.reclaim` 和 `work/locks/resolve/*.lock`：

- 合法 token 且 PID 已退出：`orphan_lock` warning；
- 内容无法解析：`invalid_lock` warning；
- 当前活进程 PID：不报告；
- 知识库外同名锁：不扫描。
- 将固定 resolve 锁目录或相邻锁扫描路径的父目录替换为指向知识库外部的 junction/symlink：doctor 不读取、不报告外部锁，也不修改链接内外任何文件。

断言 doctor 不修改或删除任何锁，问题稳定排序。

- [x] **Step 2: 写 orphan reclaim guard 安全超时测试**

创建已退出进程留下的 `.lock.reclaim`。断言后续锁获取会超时、guard 保持原样，doctor 能定位它。增加三个并发进程场景，证明实现没有任何自动回收 orphan guard 的路径，因此不会出现 A 删除旧 guard、C 创建活 guard、B 误删 C 的 ABA。

- [x] **Step 3: 运行聚焦测试并确认 RED**

```powershell
node --test --test-name-pattern="orphan lock|invalid lock|reclaim guard diagnosis" tests/agent-knowledge.test.js
```

- [x] **Step 4: 实现只读诊断**

复用统一锁 token 解析，只遍历知识库真实根内的固定锁范围，不跟随越界链接。doctor 报告建议包含锁路径、PID 和“确认无活跃任务后人工处理”的说明，但绝不自动删除。主锁的既有自动恢复仍必须先成功持有 reclaim guard；不扩大删除权限。

- [x] **Step 5: 更新文档并确认 GREEN**

明确自动恢复边界、超时含义和人工排查步骤，不提供无 token/无停机确认的强制解锁命令。

### Task 2: 最小 CI

**Files:**
- Create: `.github/workflows/agent-knowledge-ci.yml`
- Modify: `agent-knowledge/README.md`

- [x] **Step 1: 新增 GitHub Actions**

在 `push` 和 `pull_request` 上使用当前 Node LTS，设置 `agent-knowledge/` 为工作目录，依次执行：

```powershell
npm test
node bin/agent-knowledge.js sync-adapters --check --repository-root ..
node bin/agent-knowledge.js doctor --repository-root ..
```

不安装第三方包、不写私有知识库、不自动同步适配器、不忽略失败退出码。

- [x] **Step 2: 本地运行 CI 同等命令**

示例知识库 doctor 必须通过。若本机存在 `C:\idea_workspace_tob\team-agent-knowledge`，可额外运行只读 doctor，但它是非阻塞环境检查，不能写入 CI 或作为跨环境完成条件。

### Task 3: 完整验证

- [x] 运行 `npm.cmd test`。
- [x] 运行 `node --experimental-test-coverage --test tests/*.test.js`，line/branch coverage 不低于前一阶段。
- [x] 运行适配器 check、示例 doctor、`git diff --check` 和 UTF-8 无 BOM 检查。
- [x] 审查 workflow 权限最小化，不含写权限、私有路径或外部脚本下载。
