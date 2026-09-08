/**
 * Durable, atomic, restart-safe record of committed turn-advancement keys.
 *
 * OpenClaw's `atomic-idempotent-v1` transcriptSemantics contract requires
 * that a retried `commitTurn` call report "duplicate" for a key that was
 * already committed -- including after this process (or the host) restarts.
 * An in-memory `Set` cannot satisfy that: a restart silently forgets every
 * committed key, so a retried commit is wrongly re-accepted as new.
 *
 * Keys are never evicted. OpenClaw may retry at any point after a restart or
 * a long stall, so pruning by count or age would risk re-accepting an
 * already-committed turn -- exactly the failure this store exists to avoid.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as os from "node:os";

/** Default commit-log location, honoring the same workspace override the
 * rest of the Headroom workspace convention uses (`HEADROOM_WORKSPACE_DIR`). */
export function defaultCommitLogPath(): string {
  const workspaceDir = process.env.HEADROOM_WORKSPACE_DIR?.trim() || join(os.homedir(), ".headroom");
  return join(workspaceDir, "openclaw", "commit-log.json");
}

export class DurableAdvancementKeyStore {
  private loaded: Set<string> | null = null;
  private loadPromise: Promise<Set<string>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  private async ensureLoaded(): Promise<Set<string>> {
    if (this.loaded) return this.loaded;
    if (!this.loadPromise) {
      this.loadPromise = (async () => {
        try {
          const raw = await readFile(this.path, "utf8");
          const parsed = JSON.parse(raw) as unknown;
          this.loaded = new Set(
            Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [],
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
            throw error;
          }
          this.loaded = new Set();
        }
        return this.loaded;
      })();
    }
    return this.loadPromise;
  }

  /**
   * Atomically check-and-record `key`. Calls on this store are serialized
   * (same process) so a burst of concurrent commits for the same key can't
   * race past the has-then-record check.
   */
  async tryCommit(key: string): Promise<"committed" | "duplicate"> {
    const run = async (): Promise<"committed" | "duplicate"> => {
      const keys = await this.ensureLoaded();
      if (keys.has(key)) {
        return "duplicate";
      }
      keys.add(key);
      await mkdir(dirname(this.path), { recursive: true });
      const tmpPath = `${this.path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmpPath, JSON.stringify([...keys]), "utf8");
      await rename(tmpPath, this.path);
      return "committed";
    };
    const result = this.queue.then(run, run);
    // Keep the queue alive even if a write fails, so later calls still run.
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Test-only: check membership without recording. */
  async has(key: string): Promise<boolean> {
    const keys = await this.ensureLoaded();
    return keys.has(key);
  }
}
