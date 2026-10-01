import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { apply, plan, restore, verify } from "../src/runtime.js";
import { resolveRepositoryFromOrigin } from "../src/remote.js";
import { planMarkdown } from "../src/artifacts.js";
import { contract, expectedRuleset, MemoryTransport } from "./helpers.js";
vi.mock("../src/auth.js", () => ({
  readToken: vi.fn(() => {
    throw new Error("live token access forbidden in tests");
  })
}));
async function workspace() {
  const cwd = await mkdtemp(join(tmpdir(), "governance-runtime-"));
  execFileSync("git", ["init", "--quiet", cwd]);
  execFileSync("git", ["remote", "add", "origin", "https://github.com/octo/repository.git"], {
    cwd
  });
  await writeFile(join(cwd, "governance-contract.json"), JSON.stringify(contract()));
  return cwd;
}
describe("runtime in temporary Git repositories", () => {
  it("plans read-only and byte-identically, applies, verifies and repeats without writes", async () => {
    const cwd = await workspace();
    const transport = new MemoryTransport();
    const options = { cwd, transport };
    expect(resolveRepositoryFromOrigin(cwd)).toEqual({ owner: "octo", repository: "repository" });
    const first = await plan(options);
    const json = await readFile(join(cwd, "artifacts/governance-plan.json"), "utf8");
    await plan(options);
    expect(await readFile(join(cwd, "artifacts/governance-plan.json"), "utf8")).toBe(json);
    expect(first.actions).toHaveLength(1);
    expect(transport.calls.every((c) => c.method === "GET")).toBe(true);
    await expect(verify(options)).rejects.toThrow(/differs/);
    await apply(options);
    await verify(options);
    transport.calls.length = 0;
    await apply(options);
    expect(transport.calls.every((c) => c.method === "GET")).toBe(true);
    const result = await plan(options);
    expect(planMarkdown(result)).toContain("No changes required");
    await restore(options); // Empty pre-change snapshot performs no policy write.
  });
  it("reuses the private snapshot to resume partial rollout", async () => {
    const cwd = await workspace();
    const legacy = { ...expectedRuleset(8), name: "agentbench/legacy" };
    const transport = new MemoryTransport([legacy]);
    transport.failure = (m) => (m === "DELETE" ? 500 : undefined);
    await expect(apply({ cwd, transport })).rejects.toThrow();
    const before = await readFile(join(cwd, "artifacts/recovery-snapshot.json"), "utf8");
    transport.failure = () => undefined;
    await apply({ cwd, transport });
    expect(await readFile(join(cwd, "artifacts/recovery-snapshot.json"), "utf8")).toBe(before);
    await restore({ cwd, transport });
    expect(transport.rulesets.some((r) => r.name === legacy.name)).toBe(true);
  });
  it("fails restore for missing, malformed, and wrong-branch snapshots", async () => {
    const cwd = await workspace();
    const transport = new MemoryTransport();
    const snapshotPath = join(cwd, "recovery.json");
    await expect(restore({ cwd, transport, snapshotPath })).rejects.toThrow(/missing/);
    await writeFile(snapshotPath, "not JSON");
    await expect(restore({ cwd, transport, snapshotPath })).rejects.toThrow(/valid JSON/);
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        repository: "octo/repository",
        defaultBranch: "trunk",
        managedNamePrefix: "agentbench/",
        managedRulesets: []
      })
    );
    await expect(restore({ cwd, transport, snapshotPath })).rejects.toThrow(/branch mismatch/);
    expect(transport.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("rejects a workspace with no origin and never falls through to live authentication", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "governance-empty-"));
    expect(() => resolveRepositoryFromOrigin(cwd)).toThrow(/origin/);
    await expect(plan({ cwd })).rejects.toThrow(/origin/);
    const repo = await workspace();
    await expect(plan({ cwd: repo })).rejects.toThrow(/forbidden/);
  });
  it("renders preserved unmanaged rulesets", async () => {
    const cwd = await workspace();
    const transport = new MemoryTransport([{ ...expectedRuleset(9), name: "manual/freeze" }]);
    expect(planMarkdown(await plan({ cwd, transport }))).toContain("manual/freeze");
  });
});
