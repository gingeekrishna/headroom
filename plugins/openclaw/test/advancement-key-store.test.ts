import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DurableAdvancementKeyStore, defaultCommitLogPath } from "../src/advancement-key-store.js";

describe("DurableAdvancementKeyStore", () => {
  let dir: string;
  let storePath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "headroom-advancement-key-store-"));
    storePath = path.join(dir, "nested", "commit-log.json");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("commits a new key and creates the parent directory", async () => {
    const store = new DurableAdvancementKeyStore(storePath);

    await expect(store.tryCommit("turn-1")).resolves.toBe("committed");
    await expect(fs.stat(storePath)).resolves.toBeTruthy();
  });

  it("reports duplicate for an already-committed key", async () => {
    const store = new DurableAdvancementKeyStore(storePath);

    await expect(store.tryCommit("turn-1")).resolves.toBe("committed");
    await expect(store.tryCommit("turn-1")).resolves.toBe("duplicate");
  });

  it("persists across a simulated restart (a fresh store instance, same path)", async () => {
    const before = new DurableAdvancementKeyStore(storePath);
    await expect(before.tryCommit("turn-1")).resolves.toBe("committed");

    const after = new DurableAdvancementKeyStore(storePath);
    await expect(after.tryCommit("turn-1")).resolves.toBe("duplicate");
    // A key that was never committed is still accepted normally.
    await expect(after.tryCommit("turn-2")).resolves.toBe("committed");
  });

  it("treats a missing commit-log file as an empty store rather than an error", async () => {
    const store = new DurableAdvancementKeyStore(storePath);

    await expect(store.has("turn-1")).resolves.toBe(false);
    await expect(store.tryCommit("turn-1")).resolves.toBe("committed");
  });

  it("fails loudly on a corrupt commit-log file instead of silently forgetting its contents", async () => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, "{not valid json", "utf8");
    const store = new DurableAdvancementKeyStore(storePath);

    await expect(store.tryCommit("turn-1")).rejects.toThrow();
  });

  it("serializes concurrent commits of the same key so exactly one wins", async () => {
    const store = new DurableAdvancementKeyStore(storePath);

    const results = await Promise.all([
      store.tryCommit("turn-race"),
      store.tryCommit("turn-race"),
      store.tryCommit("turn-race"),
    ]);

    expect(results.filter((r) => r === "committed")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(2);
  });

  it("never evicts a key regardless of how many others were committed since", async () => {
    const store = new DurableAdvancementKeyStore(storePath);

    for (let i = 0; i < 600; i++) {
      await store.tryCommit(`turn-${i}`);
    }

    await expect(store.tryCommit("turn-0")).resolves.toBe("duplicate");
  });
});

describe("defaultCommitLogPath", () => {
  const originalWorkspaceDir = process.env.HEADROOM_WORKSPACE_DIR;

  afterEach(() => {
    if (originalWorkspaceDir === undefined) {
      delete process.env.HEADROOM_WORKSPACE_DIR;
    } else {
      process.env.HEADROOM_WORKSPACE_DIR = originalWorkspaceDir;
    }
  });

  it("honors HEADROOM_WORKSPACE_DIR when set", () => {
    process.env.HEADROOM_WORKSPACE_DIR = "/custom/workspace";

    expect(defaultCommitLogPath()).toBe(
      path.join("/custom/workspace", "openclaw", "commit-log.json"),
    );
  });

  it("falls back to ~/.headroom when unset", () => {
    delete process.env.HEADROOM_WORKSPACE_DIR;

    expect(defaultCommitLogPath()).toBe(
      path.join(os.homedir(), ".headroom", "openclaw", "commit-log.json"),
    );
  });
});
