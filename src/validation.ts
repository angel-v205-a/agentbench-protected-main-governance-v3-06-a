import { ContractValidationError } from "./errors.js";
import { redactSensitive } from "./redaction.js";

export function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${path} must be an object`);
  return value as Record<string, unknown>;
}
export function fail(message: string): never {
  throw new ContractValidationError(message);
}
export function keys(value: Record<string, unknown>, allowed: string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${path}: unknown key ${redactSensitive(key)}`);
  }
}
export function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value !== value.trim() ||
    /\p{Cc}/u.test(value)
  )
    fail(`${path} must be a non-empty, trimmed string`);
  if (redactSensitive(value) !== value || value.startsWith("/") || value.includes("://"))
    fail(`${path} contains unsafe material`);
  return value;
}
export function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(`${path} must be an array`);
  return value as unknown[];
}
export function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(`${path} must be boolean`);
  return value;
}
export function integer(
  value: unknown,
  path: string,
  min = 0,
  max = Number.MAX_SAFE_INTEGER
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    fail(`${path} must be an integer between ${String(min)} and ${String(max)}`);
  return value;
}
export function choice<T extends string>(value: unknown, choices: readonly T[], path: string): T {
  if (!choices.includes(value as T)) fail(`${path} has an unsupported value`);
  return value as T;
}
export function unique(values: string[], path: string): string[] {
  if (new Set(values).size !== values.length) fail(`${path} contains duplicate values`);
  return values;
}
export function branch(value: unknown, path: string, selector = false): string {
  const name = text(value, path);
  if (selector && name === "~DEFAULT_BRANCH") return name;
  if (["*", "?", "[", "]"].some((char) => name.includes(char)) || name === "~ALL")
    fail(`${path}: unsafe wildcard target`);
  const ref = selector ? name.replace(/^refs\/heads\//, "") : name;
  if (
    (selector && !name.startsWith("refs/heads/")) ||
    /[ ~^:\\@]/.test(ref) ||
    ref.includes("..") ||
    ref.includes("//") ||
    ref.endsWith(".") ||
    ref.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  )
    fail(`${path}: malformed branch selector`);
  return name;
}
