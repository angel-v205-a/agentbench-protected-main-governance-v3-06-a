import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { defaultTokenPath, readToken } from "../src/auth.js";
import { safeErrorMessage } from "../src/redaction.js";
describe("runtime credential handling", () => {
  it("reads only explicit temporary dummy files and trims whitespace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "governance-auth-test-"));
    const path = join(dir, "dummy.txt");
    await writeFile(path, "  fake-test-value\n");
    expect(await readToken(path)).toBe("fake-test-value");
    vi.stubEnv("GITHUB_TOKEN_FILE", path);
    expect(await readToken()).toBe("fake-test-value");
    vi.unstubAllEnvs();
    await writeFile(path, " \n");
    await expect(readToken(path)).rejects.toThrow(/empty/);
    await expect(readToken(join(dir, "missing"))).rejects.toThrow(
      "unable to read the configured GitHub token file"
    );
    expect(defaultTokenPath()).toBe(
      join(homedir(), ".config", "agent-eval", "github-governance-token.txt")
    );
    expect(safeErrorMessage({ secret: "hidden" })).toContain("suppressed");
  });
});
