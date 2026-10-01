import { resolve } from "node:path";
import { writePlanArtifacts } from "./artifacts.js";
import { readToken } from "./auth.js";
import { loadContract } from "./contract.js";
import { PolicyError } from "./errors.js";
import { FetchGitHubTransport, GitHubClient } from "./github.js";
import { buildPlan, isCompliant } from "./planner.js";
import { applyPlan, restoreSnapshot, type SnapshotStore } from "./reconciler.js";
import { resolveRepositoryFromOrigin } from "./remote.js";
import { readSnapshot, writeSnapshot } from "./snapshot.js";
import type { GitHubTransport, RepositoryState } from "./types.js";

export interface RuntimeOptions {
  cwd?: string;
  transport?: GitHubTransport;
  contractPath?: string;
  snapshotPath?: string;
}

async function liveContext(options: RuntimeOptions) {
  const cwd = options.cwd ?? process.cwd();
  const contractPath = options.contractPath ?? resolve(cwd, "governance-contract.json");
  const snapshotPath = options.snapshotPath ?? resolve(cwd, "artifacts", "recovery-snapshot.json");
  const coordinates = resolveRepositoryFromOrigin(cwd);
  const contract = await loadContract(contractPath);
  const transport = options.transport ?? new FetchGitHubTransport(await readToken());
  const client = new GitHubClient(coordinates.owner, coordinates.repository, transport);
  return { cwd, snapshotPath, coordinates, contract, client };
}

async function readState(
  owner: string,
  repository: string,
  client: GitHubClient,
  managedPrefix: string
): Promise<RepositoryState> {
  const defaultBranch = await client.getDefaultBranch();
  const branchHead = await client.getBranchHead(defaultBranch);
  const [rulesets, workflowChecks] = await Promise.all([
    client.listRulesets(managedPrefix),
    client.listWorkflowCheckNames(branchHead)
  ]);
  return { owner, repository, defaultBranch, branchHead, rulesets, workflowChecks };
}

export async function plan(options: RuntimeOptions = {}) {
  const { cwd, coordinates, contract, client } = await liveContext(options);
  const state = await readState(
    coordinates.owner,
    coordinates.repository,
    client,
    contract.managedNamePrefix
  );
  const result = buildPlan(contract, state);
  await writePlanArtifacts(
    result,
    resolve(cwd, "artifacts", "governance-plan.json"),
    resolve(cwd, "artifacts", "governance-plan.md")
  );
  return result;
}

export async function apply(options: RuntimeOptions = {}): Promise<void> {
  const context = await liveContext(options);
  const state = await readState(
    context.coordinates.owner,
    context.coordinates.repository,
    context.client,
    context.contract.managedNamePrefix
  );
  const result = buildPlan(context.contract, state);
  const snapshotStore: SnapshotStore = {
    save: (snapshot) => writeSnapshot(context.snapshotPath, snapshot),
    load: () => readSnapshot(context.snapshotPath)
  };
  await applyPlan(context.client, context.contract, result, state.rulesets, snapshotStore);
  await verify(options);
}

export async function verify(options: RuntimeOptions = {}): Promise<void> {
  const context = await liveContext(options);
  const state = await readState(
    context.coordinates.owner,
    context.coordinates.repository,
    context.client,
    context.contract.managedNamePrefix
  );
  const result = buildPlan(context.contract, state);
  if (!isCompliant(result)) {
    throw new PolicyError(
      `live policy differs from the contract (${String(result.actions.length)} change(s) required)`,
      "POLICY_DRIFT"
    );
  }
}

export async function restore(options: RuntimeOptions = {}): Promise<void> {
  const context = await liveContext(options);
  const snapshot = await readSnapshot(context.snapshotPath);
  if (snapshot.defaultBranch !== (await context.client.getDefaultBranch()))
    throw new PolicyError("snapshot default branch mismatch", "SNAPSHOT_MISMATCH");
  const current = await context.client.listRulesets(context.contract.managedNamePrefix);
  await restoreSnapshot(context.client, context.contract, snapshot, current);
}
