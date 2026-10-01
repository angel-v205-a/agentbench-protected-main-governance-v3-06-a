import { describe, expect, it, vi } from "vitest";
import { FetchGitHubTransport, GitHubClient, type FetchLike } from "../src/github.js";
import { RecordingTransport, expectedRuleset } from "./helpers.js";
function response(status: number, raw = "null", headers: Record<string, string> = {}) {
  return {
    status,
    headers: { entries: () => Object.entries(headers)[Symbol.iterator]() },
    text: async () => raw
  };
}
describe("bounded HTTP operations", () => {
  it.each([400, 401, 403, 404, 422])(
    "does not retry permanent HTTP %s failures",
    async (status) => {
      const fetch = vi.fn(async () => response(status, "sensitive arbitrary response"));
      const client = new FetchGitHubTransport("dummy", fetch);
      await expect(client.request("GET", "/test")).rejects.toThrow(`HTTP ${String(status)}`);
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("retries transient GET failures within a bounded budget", async () => {
    const fetch = vi.fn(async () => response(503));
    const sleep = vi.fn(async () => {
      /* Intentional no-op mock: no network or delay. */
    });
    await expect(
      new FetchGitHubTransport("dummy", fetch, undefined, { sleep }).request("GET", "/test")
    ).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toHaveLength(2);
  });
  it("handles timeouts and network errors without logging causes", async () => {
    const fetch: FetchLike = () =>
      new Promise(() => {
        /* Deliberately pending to exercise timeout. */
      });
    const sleep = vi.fn(async () => {
      /* Intentional no-op mock: no network or delay. */
    });
    await expect(
      new FetchGitHubTransport("dummy", fetch, undefined, { timeoutMs: 1, sleep }).request(
        "GET",
        "/test"
      )
    ).rejects.toThrow(/timed out/);
    const failed = vi.fn(async () => {
      throw new Error("unknown-secret-value");
    });
    await expect(
      new FetchGitHubTransport("dummy", failed, undefined, { sleep }).request("POST", "/test", {})
    ).rejects.toThrow(/REDACTED/);
    expect(failed).toHaveBeenCalledTimes(1);
  });
  it.each(["POST", "PUT", "DELETE"])(
    "never blindly retries ambiguous %s writes",
    async (method) => {
      const fetch = vi.fn(async () => response(503));
      await expect(
        new FetchGitHubTransport("dummy", fetch).request(method, "/test", {})
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it.each([
    [{ "retry-after": "2" }, 2000],
    [{ "retry-after": "Thu, 01 Jan 1970 00:00:03 GMT" }, 3000],
    [{ "retry-after": "Thu, 01 Jan 1970 00:00:00 GMT" }, 0],
    [{ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "4" }, 4000]
  ])("honors valid retry headers", async (headers, delay) => {
    let calls = 0;
    const fetch = vi.fn(async () =>
      ++calls === 1
        ? response(403, "private", headers as Record<string, string>)
        : response(200, '{"ok":true}')
    );
    const sleep = vi.fn(async () => {
      /* Intentional no-op mock: no network or delay. */
    });
    const client = new FetchGitHubTransport("dummy", fetch, undefined, { sleep, now: () => 0 });
    await expect(client.request("GET", "/test")).resolves.toMatchObject({ body: { ok: true } });
    expect(sleep).toHaveBeenCalledWith(delay);
  });
  it.each(["invalid", "999999"])(
    "stops safely for invalid or excessive Retry-After %s",
    async (retry) => {
      const fetch = vi.fn(async () => response(429, "hidden", { "retry-after": retry }));
      await expect(
        new FetchGitHubTransport("dummy", fetch).request("GET", "/test")
      ).rejects.toThrow();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  );
  it("rejects malformed successful bodies, foreign origins, and unsafe paths", async () => {
    await expect(
      new FetchGitHubTransport("dummy", async () => response(200, "hidden text")).request(
        "GET",
        "/test"
      )
    ).rejects.toThrow(/malformed/);
    expect(() => new FetchGitHubTransport(" ")).toThrow(/empty/);
    expect(() => new FetchGitHubTransport("dummy", undefined, "https://example.com")).toThrow(
      /origin/
    );
    for (const path of ["bad", "//evil", "/bad\nheader"])
      await expect(new FetchGitHubTransport("dummy").request("GET", path)).rejects.toThrow(/path/);
    await expect(
      new FetchGitHubTransport("dummy", async () => response(204, "")).request("DELETE", "/test")
    ).resolves.toMatchObject({ body: null });
  });
});
describe("GitHub response boundaries", () => {
  it("hydrates paginated summaries and ignores unmanaged policy internals", async () => {
    const t = new RecordingTransport();
    t.queue([
      { id: 42, name: "agentbench/protected-main" },
      { id: 9, name: "manual/freeze" }
    ]);
    t.queue(expectedRuleset());
    const result = await new GitHubClient("octo", "repo", t).listRulesets("agentbench/");
    expect(result[0]).toEqual(expectedRuleset());
    expect(result[1]!.name).toBe("manual/freeze");
    expect(t.calls).toHaveLength(2);
  });
  it("bounds pagination and never follows an untrusted Link URL", async () => {
    const t = new RecordingTransport();
    for (let i = 0; i < 100; i++) t.queue([], 200, { link: '<https://evil.example>; rel="next"' });
    await expect(new GitHubClient("octo", "repo", t).listRulesets()).rejects.toThrow(/pagination/);
    expect(t.calls.every((c) => c.path.startsWith("/repos/octo/repo/"))).toBe(true);
  });
  it("validates repository, branch and ruleset identities", async () => {
    expect(() => new GitHubClient("bad/user", "repo", new RecordingTransport())).toThrow();
    const t = new RecordingTransport();
    const c = new GitHubClient("octo", "repo", t);
    t.queue(null);
    await expect(c.getDefaultBranch()).rejects.toThrow();
    t.queue({ commit: { sha: "bad" } });
    await expect(c.getBranchHead("main")).rejects.toThrow(/SHA/);
    t.queue(expectedRuleset(2));
    await expect(c.getRuleset(1)).rejects.toThrow(/identity/);
    t.queue(null, 403);
    await expect(c.deleteRuleset(1)).rejects.toThrow(/403/);
  });
  it.each([
    ["jobs:\n  test:\n    name: CI / test", ["CI / test"]],
    ["jobs:\n  test: {}", ["test"]],
    ["jobs: [", null],
    ["jobs:\n  test:\n    name: '${{ matrix.name }}'", null],
    ["jobs:\n  test:\n    strategy: {}", null],
    ["jobs:\n  test:\n    uses: other/reusable", null]
  ])(
    "reads static job configuration and fails closed for unsupported YAML",
    async (yaml, names) => {
      const t = new RecordingTransport();
      t.queue([{ name: "ci.yml" }]);
      t.queue({ encoding: "base64", content: Buffer.from(yaml).toString("base64") });
      const result = new GitHubClient("octo", "repo", t).listWorkflowCheckNames();
      if (names) await expect(result).resolves.toEqual(names);
      else await expect(result).rejects.toThrow();
    }
  );
  it("rejects malformed workflow content", async () => {
    const t = new RecordingTransport();
    t.queue([{ name: "ci.yml" }]);
    t.queue({ content: 0 });
    await expect(new GitHubClient("octo", "repo", t).listWorkflowCheckNames()).rejects.toThrow(
      /malformed/
    );
  });
});
