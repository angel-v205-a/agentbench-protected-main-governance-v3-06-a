import { parse as parseYaml } from "yaml";
import { GitHubApiError, PolicyError } from "./errors.js";
import { parseRuleset, rulesetBody } from "./ruleset.js";
import * as v from "./validation.js";
import type { GitHubRuleset, GitHubTransport } from "./types.js";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: RequestRedirect;
  }
) => Promise<{
  status: number;
  headers: { entries(): IterableIterator<[string, string]> };
  text(): Promise<string>;
}>;
export interface TransportOptions {
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export class FetchGitHubTransport implements GitHubTransport {
  public constructor(
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    private readonly apiBase = "https://api.github.com",
    private readonly options: TransportOptions = {}
  ) {
    if (!token.trim()) throw new PolicyError("GitHub token is empty", "EMPTY_TOKEN");
    if (apiBase !== "https://api.github.com")
      throw new PolicyError("unsupported API origin", "INVALID_API_ORIGIN");
  }
  public async request<T>(method: string, path: string, body?: unknown) {
    if (!path.startsWith("/") || path.startsWith("//") || /[\r\n?#]/.test(path.split("?")[0] ?? ""))
      throw new PolicyError("invalid API path", "INVALID_API_PATH");
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let response: Awaited<ReturnType<FetchLike>>;
      let raw: string;
      try {
        const operation = async () => {
          const response = await this.fetchImpl(`${this.apiBase}${path}`, {
            method,
            headers: {
              Accept: "application/vnd.github+json",
              Authorization: `Bearer ${this.token.trim()}`,
              "Content-Type": "application/json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "protected-main-governance-rollout"
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            signal: controller.signal,
            redirect: "error"
          });
          return { response, raw: await response.text() };
        };
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("timeout"));
          }, this.options.timeoutMs ?? 15000);
        });
        ({ response, raw } = await Promise.race([operation(), timeout]));
      } catch {
        if (method !== "GET" || attempt === 2)
          throw new GitHubApiError(
            "GitHub request failed or timed out; details [REDACTED]. Re-read state before retrying a write.",
            0
          );
        await this.sleep(1000 * 2 ** attempt);
        continue;
      } finally {
        clearTimeout(timer);
      }
      const headers = Object.fromEntries(
        [...response.headers.entries()].map(([k, v]) => [k.toLowerCase(), v])
      );
      if (response.status >= 200 && response.status < 300) {
        let parsed: unknown = null;
        try {
          if (raw) parsed = JSON.parse(raw);
        } catch {
          throw new GitHubApiError("malformed GitHub JSON response [REDACTED]", 502);
        }
        return { status: response.status, headers, body: parsed as T };
      }
      const limited =
        response.status === 429 ||
        (response.status === 403 &&
          (headers["retry-after"] !== undefined || headers["x-ratelimit-remaining"] === "0"));
      if (method === "GET" && attempt < 2 && (limited || response.status >= 500)) {
        const now = (this.options.now ?? Date.now)();
        const retry = headers["retry-after"];
        let delay = 1000 * 2 ** attempt;
        if (retry !== undefined) {
          delay = /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
          if (!Number.isFinite(delay))
            throw new GitHubApiError("invalid Retry-After; response [REDACTED]", response.status);
          delay = Math.max(0, delay);
        } else if (limited && headers["x-ratelimit-reset"])
          delay = Math.max(delay, Number(headers["x-ratelimit-reset"]) * 1000 - now);
        if (!Number.isFinite(delay) || delay > 60000)
          throw new GitHubApiError(
            "rate limit exceeds bounded retry window; retry later [REDACTED]",
            response.status
          );
        await this.sleep(delay);
        continue;
      }
      throw new GitHubApiError(
        `GitHub ${method} failed (HTTP ${String(response.status)}); response [REDACTED]`,
        response.status
      );
    }
    /* Every final attempt returns or throws above. */
    throw new GitHubApiError("retry budget exhausted", 0);
  }
  private async sleep(ms: number): Promise<void> {
    await (
      this.options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
    )(ms);
  }
}

export class GitHubClient {
  public readonly repositoryName: string;
  private readonly base: string;
  public constructor(
    owner: string,
    repository: string,
    private readonly transport: GitHubTransport
  ) {
    if (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repository))
      throw new PolicyError("invalid repository coordinates", "INVALID_REPOSITORY");
    this.repositoryName = `${owner}/${repository}`;
    this.base = `/repos/${this.repositoryName}`;
  }
  private async request(method: string, path: string, body?: unknown) {
    const response = await this.transport.request<unknown>(method, path, body);
    if (response.status < 200 || response.status >= 300)
      throw new GitHubApiError(
        `GitHub ${method} failed (HTTP ${String(response.status)}); response [REDACTED]`,
        response.status
      );
    return response;
  }
  private async pages(path: string): Promise<unknown[]> {
    const results: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.request(
        "GET",
        `${this.base}${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${String(page)}`
      );
      if (!Array.isArray(response.body))
        throw new GitHubApiError("malformed GitHub list response [REDACTED]", 502);
      results.push(...(response.body as unknown[]));
      if (!(response.headers.link ?? "").includes('rel="next"')) return results;
      // Construct our own same-repository URL; never forward credentials to a Link target.
    }
    throw new GitHubApiError("pagination exceeds safety limit", 502);
  }
  public async getDefaultBranch(): Promise<string> {
    const response = await this.request("GET", this.base);
    return v.branch(v.record(response.body, "repository").default_branch, "default_branch");
  }
  public async getBranchHead(branch: string): Promise<string> {
    const response = await this.request(
      "GET",
      `${this.base}/branches/${encodeURIComponent(branch)}`
    );
    const value = v.record(response.body, "branch");
    const sha = v.text(v.record(value.commit, "branch commit").sha, "branch sha");
    if (!/^[a-f0-9]{40}$/.test(sha)) throw new GitHubApiError("malformed branch SHA", 502);
    return sha;
  }
  public async listRulesets(managedPrefix = ""): Promise<GitHubRuleset[]> {
    const list = await this.pages("/rulesets?includes_parents=false");
    const result: GitHubRuleset[] = [];
    for (const input of list) {
      const summary = v.record(input, "ruleset summary");
      const id = v.integer(summary.id, "ruleset id", 1);
      const name = v.text(summary.name, "ruleset name");
      if (!name.startsWith(managedPrefix)) {
        // Unmanaged contents are deliberately opaque and cannot enter a write payload.
        result.push({
          id,
          name,
          target: "branch",
          enforcement: "disabled",
          conditions: { ref_name: { include: [], exclude: [] } },
          rules: [],
          bypass_actors: []
        });
      } else
        result.push(
          summary.rules === undefined ? await this.getRuleset(id) : parseRuleset(summary)
        );
    }
    return result;
  }
  public async getRuleset(id: number): Promise<GitHubRuleset> {
    const response = await this.request(
      "GET",
      `${this.base}/rulesets/${String(v.integer(id, "ruleset id", 1))}`
    );
    const ruleset = parseRuleset(response.body);
    if (ruleset.id !== id) throw new GitHubApiError("ruleset identity mismatch", 502);
    return ruleset;
  }
  public async listWorkflowCheckNames(ref?: string): Promise<string[]> {
    const query = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const response = await this.request("GET", `${this.base}/contents/.github/workflows${query}`);
    const entries = v.list(response.body, "workflow directory");
    const names: string[] = [];
    for (const input of entries) {
      const file = v.record(input, "workflow file");
      const name = v.text(file.name, "workflow filename");
      if (!/^[\w.-]+\.ya?ml$/.test(name)) continue;
      const response = await this.request(
        "GET",
        `${this.base}/contents/.github/workflows/${encodeURIComponent(name)}${query}`
      );
      const content = v.record(response.body, "workflow content");
      if (content.encoding !== "base64" || typeof content.content !== "string")
        throw new GitHubApiError("malformed workflow content", 502);
      let yaml: unknown;
      try {
        yaml = parseYaml(Buffer.from(content.content, "base64").toString("utf8")) as unknown;
      } catch {
        throw new GitHubApiError("malformed workflow YAML [REDACTED]", 502);
      }
      const jobs = v.record(v.record(yaml, "workflow").jobs, "workflow jobs");
      for (const [id, input] of Object.entries(jobs)) {
        const job = v.record(input, "workflow job");
        const check = v.text(job.name ?? id, "workflow check name");
        if (check.includes("${{") || job.strategy !== undefined || job.uses !== undefined)
          throw new PolicyError(
            "dynamic, matrix and reusable workflow jobs require explicit support",
            "UNSUPPORTED_WORKFLOW"
          );
        names.push(check);
      }
    }
    return [...new Set(names)].sort();
  }
  public async createRuleset(desired: GitHubRuleset): Promise<GitHubRuleset> {
    const response = await this.request("POST", `${this.base}/rulesets`, rulesetBody(desired));
    return parseRuleset(response.body);
  }
  public async updateRuleset(id: number, desired: GitHubRuleset): Promise<GitHubRuleset> {
    const response = await this.request(
      "PUT",
      `${this.base}/rulesets/${String(id)}`,
      rulesetBody(desired)
    );
    return parseRuleset(response.body);
  }
  public async deleteRuleset(id: number): Promise<void> {
    await this.request("DELETE", `${this.base}/rulesets/${String(id)}`);
  }
}
