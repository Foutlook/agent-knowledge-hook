import { readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

const RFC4122_UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const RFC4122_UUID_PATTERN = new RegExp(`^${RFC4122_UUID_SOURCE}$`, 'i');
const LOCK_CONTENT_PATTERN = new RegExp(
  `^([1-9]\\d*):(${RFC4122_UUID_SOURCE})(?:\\r\\n|\\n)?(?![\\s\\S])`,
  'i',
);

export const FILE_LOCK_TIMEOUT_MS = 5000;
export const FILE_LOCK_RETRY_DELAY_MS = 25;

export function isRfc4122Uuid(value) {
  return RFC4122_UUID_PATTERN.test(value);
}

export async function acquireAdjacentFileLock(filePath, { timeoutMs, retryDelayMs }) {
  const lockPath = `${filePath}.lock`;
  const reclaimPath = `${lockPath}.reclaim`;
  const startedAt = Date.now();
  const lockContent = createLockContent();

  for (;;) {
    const reclaimContent = createLockContent();
    if (await tryCreateLock(reclaimPath, reclaimContent)) {
      let acquired = false;
      try {
        acquired = await tryCreateLock(lockPath, lockContent);
        if (!acquired && await removeLockOwnedByDeadProcess(lockPath)) {
          acquired = await tryCreateLock(lockPath, lockContent);
        }
      } finally {
        await releaseOwnedLock(reclaimPath, reclaimContent);
      }

      if (acquired) {
        return async () => releaseOwnedLock(lockPath, lockContent);
      }
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const error = new Error(`等待文件锁超时（${timeoutMs}ms）: ${lockPath}`);
      error.code = 'LOCK_TIMEOUT';
      throw error;
    }

    await delay(retryDelayMs);
  }
}

function createLockContent() {
  return `${process.pid}:${randomUUID()}\n`;
}

export function parseLockContent(raw) {
  const match = String(raw).match(LOCK_CONTENT_PATTERN);
  if (!match) {
    return null;
  }

  const ownerPid = Number(match[1]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    return null;
  }

  return { ownerPid };
}

async function tryCreateLock(lockPath, content) {
  try {
    await writeFile(lockPath, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

async function releaseOwnedLock(lockPath, content) {
  let currentContent;
  try {
    currentContent = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  // token 不匹配说明锁已不属于当前调用，绝不能删除后继持有者的锁。
  if (currentContent === content) {
    await rm(lockPath);
  }
}

async function removeLockOwnedByDeadProcess(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT';
  }

  const lock = parseLockContent(raw);
  if (!lock) {
    return false;
  }

  if (isProcessAlive(lock.ownerPid)) {
    return false;
  }

  // 调用方持有 reclaim guard，重新读取并确认 PID 已退出后才能删除主锁，避免 ABA 误删新锁。
  try {
    await rm(lockPath);
    return true;
  } catch (error) {
    return error?.code === 'ENOENT';
  }
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}
