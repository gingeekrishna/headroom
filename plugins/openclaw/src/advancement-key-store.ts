/**
 * Durable, atomic, restart-safe, cross-instance-safe record of committed
 * turn advancements.
 *
 * OpenClaw's `atomic-idempotent-v1` transcriptSemantics contract requires
 * that a retried `commitTurn` call report "duplicate" for a key that was
 * already committed -- including after this process (or the host) restarts
 * -- and that "the accepted turn and key advance together" (the committed
 * messages are persisted atomically with the key, not discarded).
 *
 * Every `tryCommit` re-reads the file fresh (no long-lived in-memory cache)
 * and is serialized through a queue keyed by the resolved file path, shared
 * by every `DurableAdvancementKeyStore` instance pointed at that path --
 * not just calls on the same object. Two instances committing different
 * keys against the same file therefore can't race past each other's
 * read-modify-write and silently drop one of the commits.
 *
 * The in-memory state is never mutated ahead of the write: a key is only
 * "seen" once the atomic (temp file + rename) write that records it has
 * actually succeeded. If the write fails (e.g. the parent directory isn't
 * writable), nothing is persisted and nothing is remembered in memory
 * either, so retrying the same key attempts the commit again instead of
 * returning a phantom "duplicate" for a commit that never happened.
 *
 * Keys are never evicted. OpenClaw may retry at any point after a restart or
 * a long stall, so pruning by count or age would risk re-accepting an
 * already-committed turn -- exactly the failure this store exists to avoid.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import * as os from "node:os";

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

// Serializes read-modify-write cycles across every DurableAdvancementKeyStore
// instance that resolves to the same file, keyed by the resolved absolute
// path rather than by object identity -- this is what makes two *separate*
// store instances pointed at the same file safe to use concurrently.
const pathQueues = new Map<string, Promise<unknown>>();

function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const previous = pathQueues.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  // Keep the queue alive even if this operation failed, so later calls
  // (including a retry of the same key) still run instead of piling up
  // behind a permanently-rejected promise.
  pathQueues.set(
    key,
    run.catch(() => undefined),
  );
  return run;
}

export class DurableAdvancementKeyStore {
  constructor(private readonly path: string) {}

  private async readAll(): Promise<CommitLog> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
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
   * advances. Serialized (via the path-keyed queue above) against every
   * other call against this file, from this or any other store instance.
   *
   * Throws if the write fails -- the caller sees a rejected commit, not a
   * false "committed"/"duplicate", and a retry re-reads the (still
   * unchanged) on-disk state and attempts the write again.
   */
  async tryCommit(key: string, messages: unknown): Promise<"committed" | "duplicate"> {
    return withPathLock(this.path, async () => {
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
