import { PolicyError } from "./errors.js";
import type { GitHubClient } from "./github.js";
import { desiredRuleset } from "./normalize.js";
import { equivalent } from "./ruleset.js";
import { validateSnapshot } from "./snapshot.js";
import { buildPlan } from "./planner.js";
import { stableJson } from "./stable-json.js";
import type {
  GitHubRuleset,
  GovernanceContract,
  GovernancePlan,
  RecoverySnapshot
} from "./types.js";

export interface SnapshotStore {
  save(snapshot: RecoverySnapshot): Promise<void>;
  load(): Promise<RecoverySnapshot>;
}
function checkIdentity(
  client: GitHubClient,
  contract: GovernanceContract,
  snapshot: RecoverySnapshot,
  branch?: string
): void {
  if (snapshot.repository !== client.repositoryName)
    throw new PolicyError("snapshot repository mismatch", "SNAPSHOT_MISMATCH");
  if (
    snapshot.managedNamePrefix !== contract.managedNamePrefix ||
    (branch !== undefined && snapshot.defaultBranch !== branch)
  )
    throw new PolicyError(
      "snapshot managed prefix or default branch mismatch",
      "SNAPSHOT_MISMATCH"
    );
}
async function check(client: GitHubClient, id: number, desired: GitHubRuleset): Promise<void> {
  if (!equivalent(await client.getRuleset(id), desired))
    throw new PolicyError(
      "replacement verification failed; existing policies retained",
      "VERIFICATION_FAILED"
    );
}
async function updateVerified(
  client: GitHubClient,
  previous: GitHubRuleset,
  desired: GitHubRuleset
): Promise<void> {
  try {
    await client.updateRuleset(previous.id, desired);
    await check(client, previous.id, desired);
  } catch {
    try {
      await client.updateRuleset(previous.id, previous);
      await check(client, previous.id, previous);
    } catch {
      throw new PolicyError(
        "policy update and recovery could not be verified; snapshot retained, no policies deleted; operator recovery required",
        "RECOVERY_REQUIRED"
      );
    }
    throw new PolicyError(
      "policy update failed; previous policy restored and verified",
      "UPDATE_FAILED"
    );
  }
}
export async function applyPlan(
  client: GitHubClient,
  contract: GovernanceContract,
  plan: GovernancePlan,
  before: GitHubRuleset[],
  snapshots: SnapshotStore
): Promise<void> {
  if (plan.repository !== client.repositoryName)
    throw new PolicyError("plan repository mismatch", "PLAN_MISMATCH");
  const expected = buildPlan(contract, {
    owner: client.repositoryName.split("/")[0] ?? "",
    repository: client.repositoryName.split("/")[1] ?? "",
    defaultBranch: plan.defaultBranch,
    workflowChecks: contract.rulesets.flatMap((r) => r.rules.requireStatusChecks),
    rulesets: before
  });
  const actions = (p: GovernancePlan) => p.actions.map((a) => stableJson(a)).sort();
  if (stableJson(actions(expected)) !== stableJson(actions(plan)))
    throw new PolicyError("plan does not match managed contract state", "PLAN_MISMATCH");
  if (!plan.actions.length) return;
  const snapshot = validateSnapshot({
    schemaVersion: 1,
    repository: plan.repository,
    defaultBranch: plan.defaultBranch,
    managedNamePrefix: contract.managedNamePrefix,
    managedRulesets: before.filter((r) => r.name.startsWith(contract.managedNamePrefix))
  });
  try {
    await snapshots.save(snapshot);
  } catch (error) {
    if (!(error instanceof PolicyError) || error.code !== "SNAPSHOT_EXISTS") throw error;
    checkIdentity(client, contract, validateSnapshot(await snapshots.load()), plan.defaultBranch);
  }
  const live = new Map(before.map((r) => [r.id, r]));
  const verified = new Set<number>();
  for (const action of expected.actions) {
    if (action.kind === "create") {
      const created = await client.createRuleset(action.desired);
      await check(client, created.id, action.desired);
      live.set(created.id, { ...action.desired, id: created.id });
      verified.add(created.id);
    } else if (action.kind === "update") {
      const previous = before.find((r) => r.id === action.rulesetId);
      if (!previous) throw new PolicyError("planned ruleset missing", "PLAN_MISMATCH");
      await updateVerified(client, previous, action.desired);
      live.set(previous.id, { ...action.desired, id: previous.id });
      verified.add(previous.id);
    }
  }
  // Verify every desired policy before any obsolete/duplicate deletion, including unchanged ones.
  for (const rule of contract.rulesets) {
    const desired = desiredRuleset(rule, plan.defaultBranch, contract.mergeMethod);
    const matching = [...live.values()].find((r) => equivalent(r, desired));
    if (!matching)
      throw new PolicyError("replacement is missing; no policies deleted", "VERIFICATION_FAILED");
    if (!verified.has(matching.id)) await check(client, matching.id, desired);
  }
  for (const action of expected.actions)
    if (action.kind === "delete") await client.deleteRuleset(action.rulesetId);
}
export async function restoreSnapshot(
  client: GitHubClient,
  contract: GovernanceContract,
  input: RecoverySnapshot,
  current: GitHubRuleset[]
): Promise<void> {
  const snapshot = validateSnapshot(input);
  checkIdentity(client, contract, snapshot);
  const used = new Set<number>();
  // Add or repair only recorded policies; never delete a replacement or an unrecorded policy.
  for (const desired of snapshot.managedRulesets) {
    const candidates = current.filter((r) => r.name === desired.name && !used.has(r.id));
    const previous =
      candidates.find((r) => r.id === desired.id) ??
      candidates.find((r) => equivalent(r, desired)) ??
      candidates[0];
    if (previous) {
      used.add(previous.id);
      if (!equivalent(previous, desired)) await updateVerified(client, previous, desired);
      else await check(client, previous.id, desired);
    } else {
      const created = await client.createRuleset(desired);
      await check(client, created.id, desired);
    }
  }
}
