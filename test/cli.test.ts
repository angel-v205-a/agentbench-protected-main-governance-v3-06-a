import { describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";

describe("CLI", () => {
  it("returns usage status for an unknown command", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    await expect(main(["destroy"], output)).resolves.toBe(2);
    expect(output.error).toHaveBeenCalledWith(
      "usage: repository-policy <plan|apply|verify|restore>"
    );
  });

  it("returns usage status when extra positional arguments are supplied", async () => {
    const output = { log: vi.fn(), error: vi.fn() };
    await expect(main(["plan", "extra"], output)).resolves.toBe(2);
  });
});

vi.mock("../src/runtime.js", () => ({
  plan: vi.fn(async () => ({ actions: [] })),
  apply: vi.fn(async () => {
    /* Intentional no-op mock: no network or delay. */
  }),
  verify: vi.fn(async () => {
    /* Intentional no-op mock: no network or delay. */
  }),
  restore: vi.fn(async () => {
    /* Intentional no-op mock: no network or delay. */
  })
}));
describe("CLI results", () => {
  it.each(["plan", "apply", "verify", "restore"])("returns success for %s", async (command) => {
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await main([command], output)).toBe(0);
    expect(output.log).toHaveBeenCalled();
  });
  it("returns failure with a redacted message and no stack", async () => {
    const runtime = await import("../src/runtime.js");
    vi.mocked(runtime.verify).mockRejectedValueOnce(new Error("Bearer test-secret"));
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await main(["verify"], output)).toBe(1);
    expect(output.error).toHaveBeenCalledWith("Bearer [REDACTED]");
  });
});
