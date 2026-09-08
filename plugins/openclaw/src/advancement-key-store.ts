/**
 * Durable, atomic, restart-safe, cross-process-safe record of committed
 * turn advancements.
 *
 * OpenClaw's `atomic-idempotent-v1` transcriptSemantics contract requires
 * that a retried `commitTurn` call report "duplicate" for a key that was
 * already committed -- including after this process (or the host) restarts
 * -- and that "the accepted turn and key advance together" (the committed
 * messages are persisted atomically with the key, not discarded).
 *
 * The default commit-log path is shared by every gateway process using the
 * same Headroom workspace, not just every store instance in one process --
 * an in-process mutex (a JS `Map`/promise queue) does nothing to stop two
 * separate OS processes from each reading the same file, adding a different
 * key, and racing their renames, with the loser's accepted turn silently
 * discarded. The read/check/write transaction is therefore protected by a
 * real inter-process lock: an exclusive lock FILE (`<path>.lock`), acquired
 * via atomic exclusive creation (`open(..., "wx")`, which is atomic at the
 * OS level on POSIX and Windows alike) so only one process -- in this one or
 * any other -- can be inside the critical section at a time. A lock whose
 * holder crashed without releasing it is broken after `STALE_LOCK_MS` so a
 * dead process can't wedge every future commit to this file forever.
 *
 * Every `tryCommit` re-reads the file fresh from disk inside the lock (no
 * long-lived in-memory cache), and the in-memory return value is only ever
 * "committed" once the atomic (temp file + rename) write recording the key
 * has actually succeeded -- a failed write is never remembered as seen, so
 * retrying the same key attempts the commit again instead of returning a
 * phantom "duplicate" for a commit that never reached disk.
 *
 * Keys are never evicted. OpenClaw may retry at any point after a restart or
 * a long stall, so pruning by count or age would risk re-accepting an
 * already-committed turn -- exactly the failure this store exists to avoid.
 */

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as os from "node:os";

/**
 * True if `p` exists and is something other than a directory (e.g. a file
 * sitting where a directory needs to be). Some platforms (observed on
 * Windows) report `ENOENT` -- not a distinct "not a directory" code -- for
 * `readFile` when a path component like this blocks the rest of the path,
 * which is indistinguishable from "the commit log just doesn't exist yet"
 * by error code alone. Checking the parent directly is what tells the two
 * apart: silently treating a broken storage path as an empty store would
 * make every future commit re-accept an already-committed key.
 */
async function isBlockingNonDirectory(p: string): Promise<boolean> {
  try {
    const info = await stat(p);
    return !info.isDirectory();
  } catch {
    return false; // Doesn't exist -- not blocking anything.
  }
}

/** Default commit-log location, honoring the same workspace override the
 * rest of the Headroom workspace convention uses (`HEADROOM_WORKSPACE_DIR`). */
export function defaultCommitLogPath(): string {
  const workspaceDir = process.env.HEADROOM_WORKSPACE_DIR?.trim() || join(os.homedir(), ".headroom");
  return join(workspaceDir, "openclaw", "commit-log.json");
}

/** One durably-committed turn: the accepted messages plus when they landed. */
export interface CommittedTurn {
  messages: unknown;
  committedAt: string;
}

type CommitLog = Record<string, CommittedTurn>;

/** A lock older than this is assumed to belong to a crashed holder and is broken. */
const STALE_LOCK_MS = 30_000;
/** Give up (rather than poll forever) if the lock still can't be acquired after this long. */
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const LOCK_POLL_BASE_MS = 20;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding an exclusive lock on `path` (a sibling `<path>.lock`
 * file). Serializes every caller -- this process or another -- against the
 * same file, not just calls on one object or one process.
 */
async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let attempt = 0;
  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }
      // Someone else holds the lock (this process or another). Break it if
      // it looks abandoned -- a crashed holder must not wedge every future
      // commit to this file forever -- then retry acquiring immediately.
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > STALE_LOCK_MS) {
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException)?.code !== "ENOENT") {
          throw statError;
        }
        // Lock file vanished between our failed open and this stat -- retry.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for the advancement-key-store lock on ${path}`);
      }
      attempt += 1;
      await sleep(LOCK_POLL_BASE_MS + Math.random() * LOCK_POLL_BASE_MS * Math.min(attempt, 10));
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => undefined);
  }
}

export class DurableAdvancementKeyStore {
  constructor(private readonly path: string) {}

  private async readAll(): Promise<CommitLog> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      if (await isBlockingNonDirectory(dirname(this.path))) {
        throw error;
      }
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as CommitLog;
    }
    if (Array.isArray(parsed)) {
      // Migrate the earlier key-only array format (no message payload) so
      // upgrading from it never re-accepts an already-committed key.
      const migrated: CommitLog = {};
      for (const entry of parsed) {
        if (typeof entry === "string") {
          migrated[entry] = { messages: null, committedAt: "" };
        }
      }
      return migrated;
    }
    return {};
  }

  private async writeAll(entries: CommitLog): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmpPath = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await writeFile(tmpPath, JSON.stringify(entries), "utf8");
    await rename(tmpPath, this.path);
  }

  /**
   * Atomically check-and-record `key` together with the `messages` it
   * advances. Holds the cross-process file lock (see `withFileLock`) for
   * the full read/check/write transaction, so two processes -- or two
   * instances in this one -- can't each read the same starting state and
   * race their writes.
   *
   * Throws if the write fails -- the caller sees a rejected commit, not a
   * false "committed"/"duplicate", and a retry re-reads the (still
   * unchanged) on-disk state and attempts the write again.
   */
  async tryCommit(key: string, messages: unknown): Promise<"committed" | "duplicate"> {
    return withFileLock(this.path, async () => {
      const entries = await this.readAll();
      if (key in entries) {
        return "duplicate";
      }
      const next: CommitLog = {
        ...entries,
        [key]: { messages, committedAt: new Date().toISOString() },
      };
      await this.writeAll(next);
      return "committed";
    });
  }

  /** Test-only: check membership without recording. */
  async has(key: string): Promise<boolean> {
    const entries = await this.readAll();
    return key in entries;
  }

  /** Test-only: read back a committed entry (messages + commit time) without recording. */
  async get(key: string): Promise<CommittedTurn | undefined> {
    const entries = await this.readAll();
    return entries[key];
  }
}
