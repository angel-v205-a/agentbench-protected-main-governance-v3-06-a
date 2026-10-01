import { readFile } from "node:fs/promises";
import { ContractValidationError } from "./errors.js";
import * as v from "./validation.js";
import type { ContractRuleset, GovernanceContract } from "./types.js";

function parseRuleset(input: unknown, index: number): ContractRuleset {
  const path = `rulesets[${String(index)}]`;
  const value = v.record(input, path);
  v.keys(value, ["name", "target", "enforcement", "branches", "bypassActors", "rules"], path);
  const rules = v.record(value.rules, `${path}.rules`);
  v.keys(
    rules,
    [
      "requirePullRequest",
      "requiredApprovals",
      "requireResolvedConversations",
      "requireStatusChecks",
      "strictStatusChecks",
      "requireLinearHistory",
      "blockForcePushes",
      "blockDeletions"
    ],
    `${path}.rules (unsupported rule types rejected)`
  );
  const result: ContractRuleset = {
    name: v.text(value.name, `${path}.name`),
    target: v.choice(value.target, ["branch"], `${path}.target`),
    enforcement: v.choice(value.enforcement, ["active"], `${path}.enforcement`),
    branches: v.unique(
      v.list(value.branches, `${path}.branches`).map((b) => v.branch(b, `${path}.branches`, true)),
      `${path}.branches`
    ),
    bypassActors: v.list(value.bypassActors, `${path}.bypassActors`).map((input) => {
      const actor = v.record(input, "bypass actor");
      v.keys(actor, ["actorId", "actorType", "bypassMode"], "bypass actor");
      return {
        actorId: v.integer(actor.actorId, "actorId", 1),
        actorType: v.choice(
          actor.actorType,
          ["RepositoryRole", "Team", "Integration", "OrganizationAdmin"],
          "actorType"
        ),
        bypassMode: v.choice(actor.bypassMode, ["always", "pull_request"], "bypassMode")
      };
    }),
    rules: {
      requirePullRequest: v.boolean(rules.requirePullRequest, "requirePullRequest"),
      requiredApprovals: v.integer(rules.requiredApprovals, "requiredApprovals", 0, 6),
      requireResolvedConversations: v.boolean(
        rules.requireResolvedConversations,
        "requireResolvedConversations"
      ),
      requireStatusChecks: v.unique(
        v
          .list(rules.requireStatusChecks, "status checks")
          .map((c) => v.text(c, "status check name")),
        "status checks"
      ),
      strictStatusChecks: v.boolean(rules.strictStatusChecks, "strictStatusChecks"),
      requireLinearHistory: v.boolean(rules.requireLinearHistory, "requireLinearHistory"),
      blockForcePushes: v.boolean(rules.blockForcePushes, "blockForcePushes"),
      blockDeletions: v.boolean(rules.blockDeletions, "blockDeletions")
    }
  };
  if (!result.branches.length) v.fail(`${path}.branches cannot be empty`);
  v.unique(
    result.bypassActors.map((a) => `${a.actorType}:${String(a.actorId)}`),
    "bypassActors"
  );
  if (
    !result.rules.requirePullRequest &&
    (result.rules.requiredApprovals > 0 || result.rules.requireResolvedConversations)
  )
    v.fail("conflicting pull request policies");
  if (result.rules.strictStatusChecks && !result.rules.requireStatusChecks.length)
    v.fail("conflicting strict status checks policy");
  return result;
}
export function parseContract(input: unknown): GovernanceContract {
  const value = v.record(input, "contract");
  v.keys(
    value,
    ["version", "managedNamePrefix", "defaultBranch", "mergeMethod", "rulesets"],
    "contract"
  );
  if (value.version !== 1) v.fail("unsupported contract version");
  const managedNamePrefix = v.text(value.managedNamePrefix, "managedNamePrefix");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*\/$/.test(managedNamePrefix))
    v.fail("managedNamePrefix must be a namespace ending in /");
  const defaultBranch = v.branch(value.defaultBranch, "defaultBranch");
  const mergeMethod = v.choice(value.mergeMethod, ["merge", "squash", "rebase"], "mergeMethod");
  const rulesets = v.list(value.rulesets, "rulesets").map(parseRuleset);
  if (!rulesets.length) v.fail("rulesets must be a non-empty array");
  const names = new Set<string>();
  const targets = new Set<string>();
  for (const ruleset of rulesets) {
    if (!ruleset.name.startsWith(managedNamePrefix) || ruleset.name === managedNamePrefix)
      v.fail(`ruleset ${ruleset.name} is outside the managed prefix`);
    if (names.has(ruleset.name)) v.fail(`duplicate ruleset ${ruleset.name}`);
    names.add(ruleset.name);
    if (mergeMethod === "merge" && ruleset.rules.requireLinearHistory)
      v.fail("conflicting mergeMethod and linear history policies");
    for (const branch of ruleset.branches) {
      const resolved = branch === "~DEFAULT_BRANCH" ? `refs/heads/${defaultBranch}` : branch;
      if (targets.has(resolved)) v.fail("conflicting overlapping branch policies");
      targets.add(resolved);
    }
  }
  return { version: 1, managedNamePrefix, defaultBranch, mergeMethod, rulesets };
}
export async function loadContract(path: string): Promise<GovernanceContract> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new ContractValidationError("contract cannot be read as valid JSON");
  }
  return parseContract(value);
}
