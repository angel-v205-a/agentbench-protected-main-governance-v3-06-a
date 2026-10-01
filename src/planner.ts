import { desiredRuleset } from "./normalize.js";
import { equivalent } from "./ruleset.js";
import { PolicyError } from "./errors.js";
import type { GovernanceContract, GovernancePlan, PlanAction, RepositoryState } from "./types.js";

export function buildPlan(contract: GovernanceContract, state: RepositoryState): GovernancePlan {
  const required = contract.rulesets.flatMap((r) => r.rules.requireStatusChecks);
  if (required.some((name) => !state.workflowChecks.includes(name)))
    throw new PolicyError(
      "required status check is missing from configured workflow jobs",
      "MISSING_CHECK"
    );
  const managed = state.rulesets.filter((r) => r.name.startsWith(contract.managedNamePrefix));
  const actions: PlanAction[] = [];
  const retained = new Set<number>();
  const targets = new Set<string>();
  for (const expected of [...contract.rulesets].sort((a, b) => a.name.localeCompare(b.name))) {
    const desired = desiredRuleset(expected, state.defaultBranch, contract.mergeMethod);
    for (const target of desired.conditions.ref_name.include) {
      if (targets.has(target))
        throw new PolicyError(
          "conflicting policies on the actual default branch",
          "POLICY_CONFLICT"
        );
      targets.add(target);
    }
    const candidates = managed
      .filter((r) => r.name === expected.name)
      .sort(
        (a, b) => Number(equivalent(b, desired)) - Number(equivalent(a, desired)) || a.id - b.id
      );
    const current = candidates[0];
    if (!current) actions.push({ kind: "create", name: expected.name, desired });
    else {
      retained.add(current.id);
      if (!equivalent(current, desired))
        actions.push({ kind: "update", name: expected.name, rulesetId: current.id, desired });
    }
  }
  for (const current of managed
    .filter((r) => !retained.has(r.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id))
    actions.push({ kind: "delete", name: current.name, rulesetId: current.id });
  return {
    schemaVersion: 1,
    repository: `${state.owner}/${state.repository}`,
    defaultBranch: state.defaultBranch,
    actions,
    preservedUnmanagedRulesets: state.rulesets
      .filter((r) => !r.name.startsWith(contract.managedNamePrefix))
      .map((r) => r.name)
      .sort()
  };
}
export function isCompliant(plan: GovernancePlan): boolean {
  return plan.actions.length === 0;
}
