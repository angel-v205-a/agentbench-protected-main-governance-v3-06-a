import { describe, expect, it } from "vitest";
import { parseContract, loadContract } from "../src/contract.js";
import { parseRuleset, equivalent } from "../src/ruleset.js";
import { buildPlan } from "../src/planner.js";
import { validateSnapshot, readSnapshot } from "../src/snapshot.js";
import { contract, expectedRuleset, state } from "./helpers.js";
import * as v from "../src/validation.js";

const snapshot = () => ({
  schemaVersion: 1,
  repository: "octo/repository",
  defaultBranch: "main",
  managedNamePrefix: "agentbench/",
  managedRulesets: [expectedRuleset()]
});
describe("strict contract and policy boundaries", () => {
  it.each([
    ["rulesets", []],
    ["rulesets", null],
    ["managedNamePrefix", ""],
    ["managedNamePrefix", "/"],
    ["defaultBranch", "foo..bar"]
  ])("rejects invalid %s", (key, value) => {
    expect(() => parseContract({ ...contract(), [key]: value })).toThrow();
  });
  it.each([
    ["target", "tag"],
    ["enforcement", "disabled"],
    ["branches", []],
    ["branches", ["main"]],
    ["branches", ["refs/heads/a.lock"]],
    ["branches", ["refs/heads/main", "refs/heads/main"]],
    ["unknown", true],
    ["bypassActors", [{}]],
    ["rules", null]
  ])("rejects invalid ruleset %s", (key, value) => {
    const c = contract();
    Object.assign(c.rulesets[0]!, { [key]: value });
    expect(() => parseContract(c)).toThrow();
  });
  it.each([
    ["requiredApprovals", 7],
    ["requiredApprovals", 0.5],
    ["requirePullRequest", "true"],
    ["requireStatusChecks", ["same", "same"]],
    ["requireStatusChecks", []],
    ["unsupportedType", true],
    ["requirePullRequest", false]
  ])("rejects conflicting or invalid rule %s", (key, value) => {
    const c = contract();
    Object.assign(c.rulesets[0]!.rules, { [key]: value });
    expect(() => parseContract(c)).toThrow();
  });
  it("rejects conflicts across rulesets and merge modes", () => {
    const c = contract();
    c.mergeMethod = "merge";
    expect(() => parseContract(c)).toThrow(/conflicting/);
    c.mergeMethod = "squash";
    c.rulesets.push({ ...c.rulesets[0]!, name: "agentbench/other" });
    expect(() => parseContract(c)).toThrow(/overlapping/);
    c.rulesets[1]!.branches = ["refs/heads/trunk"];
    expect(() => buildPlan(parseContract(c), { ...state(), defaultBranch: "trunk" })).toThrow(
      /conflicting/
    );
  });
  it("validates bypass actors and accepts explicit policy choices", () => {
    const c = contract();
    c.rulesets[0]!.bypassActors = [{ actorId: 1, actorType: "Team", bypassMode: "pull_request" }];
    expect(parseContract(c)).toEqual(c);
    c.rulesets[0]!.bypassActors.push(c.rulesets[0]!.bypassActors[0]!);
    expect(() => parseContract(c)).toThrow(/duplicate/);
  });
  it("rejects malformed contract JSON safely", async () => {
    await expect(loadContract("package.json")).rejects.toThrow();
    await expect(loadContract("/nonexistent/contract.json")).rejects.toThrow(
      "contract cannot be read as valid JSON"
    );
  });
  it.each([null, [], false, "bad"])("rejects non-object contract", (value) =>
    expect(() => parseContract(value)).toThrow()
  );
  it("checks strings, references, and primitive types without exposing values", () => {
    for (const value of [
      "",
      " leading",
      "line\nbreak",
      "/absolute/path",
      "https://host",
      ["ghp", "fake"].join("_")
    ])
      expect(() => v.text(value, "field")).toThrow();
    for (const value of [
      "~ALL",
      "refs/heads/a?",
      "refs/heads/.hidden",
      "refs/heads/a//b",
      "refs/heads/a.",
      "refs/heads/a@b",
      "refs/heads/",
      "refs/heads/a b"
    ])
      expect(() => v.branch(value, "ref", true)).toThrow();
    expect(() => v.integer(-1, "id")).toThrow();
    expect(() => v.integer("1", "id")).toThrow();
  });
  it("normalizes ordering and GitHub default fields without hiding drift", () => {
    const a = expectedRuleset();
    const b = structuredClone(a);
    b.rules.reverse();
    b.rules.find((r) => r.type === "required_status_checks")!.parameters = {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: "CI / package", integration_id: null },
        { context: "CI / test", integration_id: null }
      ]
    };
    expect(equivalent(a, b)).toBe(true);
    expect(buildPlan(contract(), state([b])).actions).toEqual([]);
    b.enforcement = "disabled";
    expect(equivalent(a, b)).toBe(false);
    expect(buildPlan(contract(), state([b])).actions[0]!.kind).toBe("update");
  });
  it("retains a compliant duplicate and deterministically removes only the extra", () => {
    const bad = { ...expectedRuleset(1), enforcement: "disabled" as const };
    expect(buildPlan(contract(), state([bad, expectedRuleset(2)])).actions).toEqual([
      { kind: "delete", name: bad.name, rulesetId: 1 }
    ]);
    expect(() => buildPlan(contract(), { ...state(), workflowChecks: [] })).toThrow(/missing/);
  });
  it.each([
    { schemaVersion: 2 },
    { repository: "../else" },
    { managedNamePrefix: "/" },
    { managedRulesets: [{ ...expectedRuleset(), name: "manual/foo" }] },
    { managedRulesets: [expectedRuleset(), expectedRuleset()] },
    { managedRulesets: [{ ...expectedRuleset(), extra: "bad" }] }
  ])("rejects unsafe snapshots", (change) =>
    expect(() => validateSnapshot({ ...snapshot(), ...change })).toThrow()
  );
  it("rejects missing snapshots", async () => {
    await expect(readSnapshot("/nonexistent/snapshot.json")).rejects.toThrow(/missing/);
  });
  it("validates nested API rules without preserving arbitrary metadata", () => {
    expect(parseRuleset({ ...expectedRuleset(), node_id: "ignored" })).toEqual(expectedRuleset());
    for (const rules of [
      [{ type: "unknown" }],
      [{ type: "deletion", parameters: {} }],
      [{ type: "required_status_checks", parameters: {} }],
      [expectedRuleset().rules[0], expectedRuleset().rules[0]]
    ])
      expect(() => parseRuleset({ ...expectedRuleset(), rules })).toThrow();
    expect(() =>
      parseRuleset({ ...expectedRuleset(), bypass_actors: [{ actor_id: 0 }] })
    ).toThrow();
    const r = expectedRuleset();
    r.bypass_actors = [{ actor_id: 1, actor_type: "Integration", bypass_mode: "always" }];
    (
      r.rules.find((r) => r.type === "pull_request")!.parameters as Record<string, unknown>
    ).allowed_merge_methods = ["squash"];
    (
      r.rules.find((r) => r.type === "required_status_checks")!.parameters as Record<
        string,
        unknown
      >
    ).do_not_enforce_on_create = false;
    expect(parseRuleset(r)).toEqual(r);
  });
});

describe("GitHub pull request defaults", () => {
  it("accepts empty reviewer defaults but rejects unsupported non-default semantics", () => {
    const r = expectedRuleset();
    const p = r.rules.find((r) => r.type === "pull_request")!.parameters as Record<string, unknown>;
    p.required_reviewers = [];
    p.require_extra_approval_for_unattributed_changes = true;
    expect(equivalent(parseRuleset(r), expectedRuleset())).toBe(true);
    p.required_reviewers = [{ reviewer: { id: 1, type: "Team" } }];
    expect(() => parseRuleset(r)).toThrow(/non-empty/);
    p.required_reviewers = [];
    p.require_extra_approval_for_unattributed_changes = false;
    expect(equivalent(parseRuleset(r), expectedRuleset())).toBe(false);
  });
  it("does not treat arbitrary three-item merge method arrays as the default", () => {
    const r = expectedRuleset();
    const p = r.rules.find((r) => r.type === "pull_request")!.parameters as Record<string, unknown>;
    p.allowed_merge_methods = ["squash", "squash", "squash"];
    expect(equivalent(r, expectedRuleset())).toBe(false);
  });
});
