import { describe, expect, it } from "vitest";
import { GitHubClient } from "../src/github.js";
import { applyPlan, restoreSnapshot, type SnapshotStore } from "../src/reconciler.js";
import { buildPlan } from "../src/planner.js";
import { PolicyError } from "../src/errors.js";
import { contract, expectedRuleset, MemoryTransport, state } from "./helpers.js";
import type { RecoverySnapshot } from "../src/types.js";
function setup(
  initial = [
    { ...expectedRuleset(1), name: "agentbench/legacy-main" },
    { ...expectedRuleset(90), name: "manual/security-freeze" }
  ]
) {
  const transport = new MemoryTransport(initial);
  const client = new GitHubClient("octo", "repository", transport);
  const snapshot: RecoverySnapshot = {
    schemaVersion: 1,
    repository: "octo/repository",
    defaultBranch: "main",
    managedNamePrefix: "agentbench/",
    managedRulesets: initial.filter((r) => r.name.startsWith("agentbench/"))
  };
  const snapshots: SnapshotStore = {
    save: async () => {
      expect(transport.calls).toEqual([]);
    },
    load: async () => snapshot
  };
  const plan = () =>
    buildPlan(contract(), {
      ...state(transport.rulesets),
      owner: "octo",
      repository: "repository"
    });
  const apply = () =>
    applyPlan(client, contract(), plan(), structuredClone(transport.rulesets), snapshots);
  return { transport, client, snapshot, snapshots, plan, apply };
}
describe("failure-safe reconciliation", () => {
  it("verifies a replacement before deletion and repeats without any write", async () => {
    const s = setup();
    await s.apply();
    expect(s.transport.calls.map((c) => c.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(s.transport.rulesets.find((r) => r.id === 90)).toEqual({
      ...expectedRuleset(90),
      name: "manual/security-freeze"
    });
    s.transport.calls.length = 0;
    await s.apply();
    expect(s.transport.calls).toEqual([]);
  });
  it("preserves legacy protection when create or readback fails", async () => {
    for (const method of ["POST", "GET"]) {
      const s = setup();
      s.transport.failure = (m) => (m === method ? 500 : undefined);
      await expect(s.apply()).rejects.toThrow();
      expect(s.transport.rulesets.some((r) => r.id === 1)).toBe(true);
      expect(s.transport.calls.some((c) => c.method === "DELETE")).toBe(false);
    }
  });
  it("retains verified replacement after partial deletion failure and resumes without duplicate creation", async () => {
    const s = setup();
    s.transport.failure = (m) => (m === "DELETE" ? 500 : undefined);
    await expect(s.apply()).rejects.toThrow();
    expect(s.transport.rulesets.some((r) => r.name === "agentbench/protected-main")).toBe(true);
    s.transport.failure = () => undefined;
    s.transport.calls.length = 0;
    s.snapshots.save = async () => {
      throw new PolicyError("exists", "SNAPSHOT_EXISTS");
    };
    await s.apply();
    expect(s.transport.calls.map((c) => c.method)).toEqual(["GET", "DELETE"]);
  });
  it("repairs a drifted policy with one PUT and independent GET", async () => {
    const s = setup([{ ...expectedRuleset(12), enforcement: "disabled" }]);
    await s.apply();
    expect(s.transport.calls.map((c) => c.method)).toEqual(["PUT", "GET"]);
    expect(s.plan().actions).toEqual([]);
  });
  it("restores the previous state after an update readback failure", async () => {
    const previous = { ...expectedRuleset(12), rules: [{ type: "non_fast_forward" }] };
    const s = setup([previous]);
    let failed = false;
    s.transport.failure = (m) => {
      if (m === "GET" && !failed) {
        failed = true;
        return 500;
      }
      return undefined;
    };
    await expect(s.apply()).rejects.toThrow(/restored and verified/);
    expect(s.transport.rulesets).toEqual([previous]);
    expect(s.transport.calls.map((c) => c.method)).toEqual(["PUT", "GET", "PUT", "GET"]);
  });
  it("reports unverified recovery and never deletes on persistent failures", async () => {
    const s = setup([{ ...expectedRuleset(12), enforcement: "disabled" }]);
    s.transport.failure = () => 500;
    await expect(s.apply()).rejects.toThrow(/operator recovery required/);
    expect(s.transport.calls.map((c) => c.method)).toEqual(["PUT", "PUT"]);
  });
  it("refuses untrusted plans and invalid or mismatched snapshots before writes", async () => {
    const s = setup();
    const p = s.plan();
    p.repository = "other/repo";
    await expect(
      applyPlan(s.client, contract(), p, s.transport.rulesets, s.snapshots)
    ).rejects.toThrow(/mismatch/);
    p.repository = "octo/repository";
    p.actions = [{ kind: "delete", name: "manual/security-freeze", rulesetId: 90 }];
    await expect(
      applyPlan(s.client, contract(), p, s.transport.rulesets, s.snapshots)
    ).rejects.toThrow(/does not match/);
    s.snapshots.save = async () => {
      throw new PolicyError("exists", "SNAPSHOT_EXISTS");
    };
    s.snapshot.defaultBranch = "other";
    await expect(s.apply()).rejects.toThrow(/mismatch/);
    s.snapshots.save = async () => {
      throw new Error("disk full");
    };
    await expect(s.apply()).rejects.toThrow(/disk full/);
    expect(s.transport.calls).toEqual([]);
  });
  it("stops on a successful write whose independent readback differs", async () => {
    const s = setup();
    const original = s.client.getRuleset.bind(s.client);
    s.client.getRuleset = async (id) => ({ ...(await original(id)), enforcement: "disabled" });
    await expect(s.apply()).rejects.toThrow(/verification failed/);
    expect(s.transport.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
describe("scoped restore", () => {
  it("restores missing recorded policies while keeping unmanaged and replacement policies", async () => {
    const s = setup();
    const target = structuredClone(s.snapshot);
    s.transport.rulesets = [expectedRuleset(4), { ...expectedRuleset(90), name: "manual/freeze" }];
    await restoreSnapshot(s.client, contract(), target, s.transport.rulesets);
    expect(s.transport.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(s.transport.rulesets).toHaveLength(3);
    s.transport.calls.length = 0;
    await restoreSnapshot(s.client, contract(), target, s.transport.rulesets);
    expect(s.transport.calls.map((c) => c.method)).toEqual(["GET"]);
  });
  it("updates only a recorded name and rolls back on partial remote failure", async () => {
    const s = setup([expectedRuleset(12)]);
    const target = structuredClone(s.snapshot);
    target.managedRulesets[0]!.rules = [{ type: "non_fast_forward" }];
    await restoreSnapshot(s.client, contract(), target, s.transport.rulesets);
    expect(s.transport.rulesets).toEqual(target.managedRulesets);
    s.transport.failure = (m) => (m === "GET" ? 500 : undefined);
    await expect(
      restoreSnapshot(s.client, contract(), s.snapshot, s.transport.rulesets)
    ).rejects.toThrow(/recovery/);
    expect(s.transport.calls.some((c) => c.method === "DELETE")).toBe(false);
  });
  it("retains existing policies when creating a recorded policy fails", async () => {
    const s = setup();
    const old = structuredClone(s.transport.rulesets);
    s.snapshot.managedRulesets = [expectedRuleset(42)];
    s.transport.failure = (m) => (m === "POST" ? 403 : undefined);
    await expect(restoreSnapshot(s.client, contract(), s.snapshot, old)).rejects.toThrow(/403/);
    expect(s.transport.rulesets).toEqual(old);
    s.snapshot.managedNamePrefix = "other/";
    s.snapshot.managedRulesets = [];
    await expect(restoreSnapshot(s.client, contract(), s.snapshot, old)).rejects.toThrow(
      /mismatch/
    );
  });
});
