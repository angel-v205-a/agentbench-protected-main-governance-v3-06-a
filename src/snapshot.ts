import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { PolicyError } from "./errors.js";
import { stableJson } from "./stable-json.js";
import { parseRuleset } from "./ruleset.js";
import * as v from "./validation.js";
import type { RecoverySnapshot } from "./types.js";

export function validateSnapshot(input: unknown): RecoverySnapshot {
  const value = v.record(input, "snapshot");
  v.keys(
    value,
    ["schemaVersion", "repository", "defaultBranch", "managedNamePrefix", "managedRulesets"],
    "snapshot"
  );
  if (!Array.isArray(value.managedRulesets)) v.fail("invalid snapshot managedRulesets");
  if (value.schemaVersion !== 1) v.fail("invalid snapshot schemaVersion");
  const repository = v.text(value.repository, "snapshot repository");
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository)) v.fail("invalid snapshot repository");
  const managedNamePrefix = v.text(value.managedNamePrefix, "snapshot managedNamePrefix");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\/$/.test(managedNamePrefix))
    v.fail("invalid snapshot managedNamePrefix");
  const managedRulesets = (value.managedRulesets as unknown[]).map((r) => parseRuleset(r, true));
  if (managedRulesets.some((r) => !r.name.startsWith(managedNamePrefix)))
    v.fail("snapshot contains unmanaged ruleset");
  v.unique(
    managedRulesets.map((r) => String(r.id)),
    "snapshot ruleset ids"
  );
  return {
    schemaVersion: 1,
    repository,
    defaultBranch: v.branch(value.defaultBranch, "snapshot defaultBranch"),
    managedNamePrefix,
    managedRulesets
  };
}
export async function writeSnapshot(path: string, snapshot: RecoverySnapshot): Promise<void> {
  const safe = validateSnapshot(snapshot);
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, stableJson(safe), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PolicyError(
      code === "EEXIST" ? "recovery snapshot already exists" : "unable to write recovery snapshot",
      code === "EEXIST" ? "SNAPSHOT_EXISTS" : "SNAPSHOT_WRITE_FAILED"
    );
  }
}
export async function readSnapshot(path: string): Promise<RecoverySnapshot> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new PolicyError("recovery snapshot is missing or unreadable", "SNAPSHOT_MISSING");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PolicyError("recovery snapshot is not valid JSON", "SNAPSHOT_INVALID");
  }
  return validateSnapshot(value);
}
