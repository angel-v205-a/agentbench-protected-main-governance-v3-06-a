import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseContract } from "../src/contract.js";
import { desiredRuleset } from "../src/normalize.js";
import type {
  GitHubRuleset,
  GitHubTransport,
  GovernanceContract,
  RepositoryState
} from "../src/types.js";

export function contract(): GovernanceContract {
  return parseContract(
    JSON.parse(readFileSync(resolve("governance-contract.json"), "utf8")) as unknown
  );
}

export function expectedRuleset(id = 42): GitHubRuleset {
  return { ...desiredRuleset(contract().rulesets[0]!, "main", contract().mergeMethod), id };
}

export function state(rulesets: GitHubRuleset[] = []): RepositoryState {
  return {
    owner: "octo-tester",
    repository: "agentbench-protected-main-governance",
    defaultBranch: "main",
    workflowChecks: ["CI / package", "CI / test"],
    rulesets
  };
}

export class RecordingTransport implements GitHubTransport {
  public readonly calls: Array<{ method: string; path: string; body?: unknown }> = [];
  public readonly responses: Array<{
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  }> = [];

  public queue(body: unknown, status = 200, headers: Record<string, string> = {}): void {
    this.responses.push({ status, headers, body });
  }

  public async request<T>(method: string, path: string, body?: unknown) {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const response = this.responses.shift();
    if (!response) throw new Error(`unexpected request: ${method} ${path}`);
    return {
      status: response.status,
      headers: response.headers ?? {},
      body: response.body as T
    };
  }
}

export class MemoryTransport implements GitHubTransport {
  public readonly calls: { method: string; path: string; body?: unknown }[] = [];
  public rulesets: GitHubRuleset[];
  public failure?: (method: string, path: string) => number | undefined;
  public constructor(rulesets: GitHubRuleset[] = []) {
    this.rulesets = structuredClone(rulesets);
  }
  public async request<T>(method: string, path: string, body?: unknown) {
    this.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const failure = this.failure?.(method, path);
    if (failure) return { status: failure, headers: {}, body: null as T };
    const id = Number(path.split("/").at(-1));
    let result: unknown = null;
    if (path.includes("/rulesets")) {
      if (method === "GET")
        result = Number.isNaN(id) ? this.rulesets : this.rulesets.find((r) => r.id === id);
      if (method === "POST") {
        result = {
          ...(body as GitHubRuleset),
          id: Math.max(100, ...this.rulesets.map((r) => r.id)) + 1
        };
        this.rulesets.push(result as GitHubRuleset);
      }
      if (method === "PUT") {
        result = { ...(body as GitHubRuleset), id };
        this.rulesets = this.rulesets.map((r) => (r.id === id ? (result as GitHubRuleset) : r));
      }
      if (method === "DELETE") this.rulesets = this.rulesets.filter((r) => r.id !== id);
    } else if (path.includes("/branches/")) result = { commit: { sha: "a".repeat(40) } };
    else if (path.includes("/contents/.github/workflows/"))
      result = {
        encoding: "base64",
        content: Buffer.from(
          "name: CI\non: pull_request\njobs:\n  test:\n    name: CI / test\n  package:\n    name: CI / package\n"
        ).toString("base64")
      };
    else if (path.includes("/contents/.github/workflows"))
      result = [{ name: "ci.yml" }, { name: "README.md" }];
    else result = { default_branch: "main" };
    return {
      status: method === "POST" ? 201 : method === "DELETE" ? 204 : 200,
      headers: {},
      body: structuredClone(result) as T
    };
  }
}
