import * as v from "./validation.js";
import { stableJson } from "./stable-json.js";
import type { GitHubRuleset } from "./types.js";

// Only writable, supported policy fields survive the API boundary.
export function parseRuleset(input: unknown, strict = false): GitHubRuleset {
  const value = v.record(input, "ruleset");
  if (strict)
    v.keys(
      value,
      ["id", "name", "target", "enforcement", "conditions", "rules", "bypass_actors"],
      "ruleset"
    );
  const conditions = v.record(value.conditions, "conditions");
  v.keys(conditions, ["ref_name"], "conditions");
  const refs = v.record(conditions.ref_name, "ref_name");
  v.keys(refs, ["include", "exclude"], "ref_name");
  const rules = v.list(value.rules, "rules").map((input) => {
    const rule = v.record(input, "rule");
    v.keys(rule, ["type", "parameters"], "rule");
    const type = v.choice(
      rule.type,
      [
        "deletion",
        "non_fast_forward",
        "required_linear_history",
        "pull_request",
        "required_status_checks"
      ],
      "rule type"
    );
    if (type !== "pull_request" && type !== "required_status_checks") {
      if (rule.parameters !== undefined) v.fail("unexpected rule parameters");
      return { type };
    }
    const p = v.record(rule.parameters, "rule parameters");
    if (type === "pull_request") {
      v.keys(
        p,
        [
          "required_approving_review_count",
          "dismiss_stale_reviews_on_push",
          "require_code_owner_review",
          "require_last_push_approval",
          "required_review_thread_resolution",
          "allowed_merge_methods",
          "required_reviewers",
          "require_extra_approval_for_unattributed_changes"
        ],
        "pull_request parameters"
      );
      if (
        p.required_reviewers !== undefined &&
        v.list(p.required_reviewers, "required_reviewers").length !== 0
      )
        v.fail("non-empty required_reviewers is not supported");
      if (p.require_extra_approval_for_unattributed_changes !== undefined)
        v.boolean(
          p.require_extra_approval_for_unattributed_changes,
          "require_extra_approval_for_unattributed_changes"
        );
      v.integer(p.required_approving_review_count, "required approvals", 0, 6);
      for (const key of [
        "dismiss_stale_reviews_on_push",
        "require_code_owner_review",
        "require_last_push_approval",
        "required_review_thread_resolution"
      ])
        v.boolean(p[key], key);
      if (p.allowed_merge_methods !== undefined)
        v.list(p.allowed_merge_methods, "allowed_merge_methods").forEach((m) =>
          v.choice(m, ["merge", "squash", "rebase"], "merge method")
        );
    } else {
      v.keys(
        p,
        [
          "strict_required_status_checks_policy",
          "required_status_checks",
          "do_not_enforce_on_create"
        ],
        "status check parameters"
      );
      v.boolean(p.strict_required_status_checks_policy, "strict status checks");
      if (p.do_not_enforce_on_create !== undefined)
        v.boolean(p.do_not_enforce_on_create, "do_not_enforce_on_create");
      v.list(p.required_status_checks, "required status checks").forEach((input) => {
        const check = v.record(input, "status check");
        v.keys(check, ["context", "integration_id"], "status check");
        v.text(check.context, "status check context");
        if (check.integration_id != null) v.integer(check.integration_id, "integration_id", 1);
      });
    }
    return { type, parameters: p };
  });
  v.unique(
    rules.map((rule) => rule.type),
    "rule types"
  );
  return {
    id: v.integer(value.id, "ruleset id", 1),
    name: v.text(value.name, "ruleset name"),
    target: v.choice(value.target, ["branch"], "ruleset target"),
    enforcement: v.choice(value.enforcement, ["active", "disabled", "evaluate"], "enforcement"),
    conditions: {
      ref_name: {
        include: v.list(refs.include, "include").map((b) => v.branch(b, "include", true)),
        exclude: v.list(refs.exclude, "exclude").map((b) => v.branch(b, "exclude", true))
      }
    },
    rules,
    bypass_actors: v.list(value.bypass_actors, "bypass_actors").map((input) => {
      const actor = v.record(input, "bypass actor");
      v.keys(actor, ["actor_id", "actor_type", "bypass_mode"], "bypass actor");
      v.integer(actor.actor_id, "actor_id", 1);
      v.choice(
        actor.actor_type,
        ["RepositoryRole", "Team", "Integration", "OrganizationAdmin"],
        "actor_type"
      );
      v.choice(actor.bypass_mode, ["always", "pull_request"], "bypass_mode");
      return actor;
    })
  };
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical).sort((a, b) => stableJson(a).localeCompare(stableJson(b)));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, v]) =>
            !(key === "integration_id" && v === null) &&
            !(key === "do_not_enforce_on_create" && v === false) &&
            !(key === "required_reviewers" && Array.isArray(v) && v.length === 0) &&
            !(
              key === "allowed_merge_methods" &&
              Array.isArray(v) &&
              v.length === 3 &&
              ["merge", "squash", "rebase"].every((m) => v.includes(m))
            )
        )
        .map(([k, v]) => [k, canonical(v)])
    );
  }
  return value;
}
export function rulesetBody(value: GitHubRuleset): Omit<GitHubRuleset, "id"> {
  return {
    name: value.name,
    target: value.target,
    enforcement: value.enforcement,
    conditions: value.conditions,
    rules: value.rules,
    bypass_actors: value.bypass_actors
  };
}
export function equivalent(a: GitHubRuleset, b: GitHubRuleset): boolean {
  return stableJson(canonical(rulesetBody(a))) === stableJson(canonical(rulesetBody(b)));
}
