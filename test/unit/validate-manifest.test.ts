import { describe, test, expect } from "bun:test";
import {
  validateStrictManifest,
  toPascalCase,
  type StrictValidationInput,
} from "../../src/lib/validate-manifest.js";
import { toStrictName } from "../../src/lib/repo-name.js";
import { extractFrontmatterName } from "../../src/commands/validate.js";

/**
 * A manifest that passes every strict rule. Individual tests clone it and break
 * exactly one field so the resulting violation is unambiguous. The repo dir name
 * matches the §4.2 grammar (`metafactory-skill-code-review` → `code-review`).
 */
function validInput(): StrictValidationInput {
  return {
    repoDirName: "metafactory-skill-code-review",
    manifest: {
      schema: "arc/v1",
      name: "code-review",
      version: "0.1.0",
      type: "skill",
      tier: "official",
      description: "Multi-lens pull request review.",
      license: "Apache-2.0",
      author: { name: "Jane Doe", github: "janedoe" },
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets: [],
      },
    },
  };
}

/** Clone the valid input, applying a shallow patch to the manifest map. */
function withManifest(patch: Record<string, unknown>): StrictValidationInput {
  const base = validInput();
  return { ...base, manifest: { ...(base.manifest as object), ...patch } };
}

/** Do any violations mention this dotted field? */
function hasField(vs: { field: string }[], field: string): boolean {
  return vs.some((v) => v.field === field);
}

describe("validateStrictManifest — clean manifest", () => {
  test("a fully-conformant manifest yields zero violations", () => {
    expect(validateStrictManifest(validInput())).toEqual([]);
  });

  test("namespace is optional — absent is clean", () => {
    expect(validateStrictManifest(validInput())).toEqual([]);
  });
});

describe("schema rule", () => {
  test("pass: schema arc/v1", () => {
    expect(hasField(validateStrictManifest(validInput()), "schema")).toBe(false);
  });
  test("fail: pai/v1 alias is rejected and names arc#280", () => {
    const vs = validateStrictManifest(withManifest({ schema: "pai/v1" }));
    expect(hasField(vs, "schema")).toBe(true);
    expect(vs.find((v) => v.field === "schema")!.rule).toContain("280");
  });
  test("fail: absent schema is a violation", () => {
    const vs = validateStrictManifest(withManifest({ schema: undefined }));
    expect(hasField(vs, "schema")).toBe(true);
  });
});

describe("name rule + §4.2 derivation", () => {
  test("pass: lowercase-hyphenated name matching the derived repo name", () => {
    expect(hasField(validateStrictManifest(validInput()), "name")).toBe(false);
  });
  test("fail: non-lowercase-hyphenated name", () => {
    expect(hasField(validateStrictManifest(withManifest({ name: "Code_Review" })), "name")).toBe(true);
  });
  test("fail: name does not derive from the repo dir grammar", () => {
    const vs = validateStrictManifest(withManifest({ name: "something-else" }));
    const v = vs.find((x) => x.field === "name");
    expect(v?.rule).toContain("§4.2");
  });
  test("derivation is skipped when the dir does not match the grammar", () => {
    const input = { ...validInput(), repoDirName: "tmp.Xkcd91" };
    // name "code-review" is still a valid lowercase-hyphenated string; with no
    // grammar match there is no derivation constraint to violate.
    expect(hasField(validateStrictManifest(input), "name")).toBe(false);
  });
  test("missing name is a violation", () => {
    expect(hasField(validateStrictManifest(withManifest({ name: undefined })), "name")).toBe(true);
  });

  // arc#356: the derivation guard must fire for the cortex agent/adapter/renderer
  // classes exactly as it does for skill/bundle repos.
  test("pass: cortex-agent dir whose name matches the derived name", () => {
    const input = {
      ...validInput(),
      repoDirName: "metafactory-cortex-agent-luna-lite",
      manifest: { ...(validInput().manifest as object), name: "luna-lite", type: "agent" },
    };
    expect(hasField(validateStrictManifest(input), "name")).toBe(false);
  });
  test("fail: cortex-agent dir whose name does NOT derive (arc#356 blind spot)", () => {
    const input = {
      ...validInput(),
      repoDirName: "metafactory-cortex-agent-foo",
      manifest: { ...(validInput().manifest as object), name: "bar", type: "agent" },
    };
    const v = validateStrictManifest(input).find((x) => x.field === "name");
    expect(v?.rule).toContain("§4.2");
  });
});

describe("version rule", () => {
  test("pass: semver 0.1.0", () => {
    expect(hasField(validateStrictManifest(validInput()), "version")).toBe(false);
  });
  test("fail: non-semver version", () => {
    expect(hasField(validateStrictManifest(withManifest({ version: "v1" })), "version")).toBe(true);
  });
});

describe("type rule (arc#95: 'action' is valid)", () => {
  test("pass: type skill", () => {
    expect(hasField(validateStrictManifest(validInput()), "type")).toBe(false);
  });
  test("pass: type action (arc#95)", () => {
    expect(hasField(validateStrictManifest(withManifest({ type: "action" })), "type")).toBe(false);
  });
  test("pass: type bundle (arc#399 / D7.2 — the reference-composition MANIFEST type; arc#334's rejection is superseded now that planArtifactSymlinks has a case for it)", () => {
    expect(hasField(validateStrictManifest(withManifest({ type: "bundle" })), "type")).toBe(false);
  });
  test("pass: type factory (arc#399 / D7.2)", () => {
    expect(hasField(validateStrictManifest(withManifest({ type: "factory" })), "type")).toBe(false);
  });
  test("fail: unknown type", () => {
    expect(hasField(validateStrictManifest(withManifest({ type: "widget" })), "type")).toBe(true);
  });
  test("fail: governance-overlay is still out of the enum (design-factory-type.md E10)", () => {
    expect(hasField(validateStrictManifest(withManifest({ type: "governance-overlay" })), "type")).toBe(true);
  });
});

describe("tier rule (official|community|custom|core)", () => {
  test("pass: tier core (issue #317 extends spec)", () => {
    expect(hasField(validateStrictManifest(withManifest({ tier: "core" })), "tier")).toBe(false);
  });
  test("pass: tier community", () => {
    expect(hasField(validateStrictManifest(withManifest({ tier: "community" })), "tier")).toBe(false);
  });
  test("fail: unknown tier", () => {
    expect(hasField(validateStrictManifest(withManifest({ tier: "trusted" })), "tier")).toBe(true);
  });
  test("fail: missing tier", () => {
    expect(hasField(validateStrictManifest(withManifest({ tier: undefined })), "tier")).toBe(true);
  });
});

describe("description + license rules", () => {
  test("pass: both present", () => {
    const vs = validateStrictManifest(validInput());
    expect(hasField(vs, "description")).toBe(false);
    expect(hasField(vs, "license")).toBe(false);
  });
  test("fail: missing description", () => {
    expect(hasField(validateStrictManifest(withManifest({ description: undefined })), "description")).toBe(true);
  });
  test("fail: missing license", () => {
    expect(hasField(validateStrictManifest(withManifest({ license: undefined })), "license")).toBe(true);
  });
});

describe("author rule (singular map; authors: list rejected)", () => {
  test("pass: singular author {name, github}", () => {
    expect(hasField(validateStrictManifest(validInput()), "author")).toBe(false);
  });
  test("fail: authors: list shape is rejected at the source (arc#278)", () => {
    const vs = validateStrictManifest(
      withManifest({ authors: [{ name: "Jane", github: "jane" }] }),
    );
    expect(hasField(vs, "authors")).toBe(true);
    expect(vs.find((v) => v.field === "authors")!.rule).toContain("278");
  });
  test("fail: author missing github", () => {
    const vs = validateStrictManifest(withManifest({ author: { name: "Jane" } }));
    expect(hasField(vs, "author.github")).toBe(true);
  });
  test("fail: author missing entirely", () => {
    expect(hasField(validateStrictManifest(withManifest({ author: undefined })), "author")).toBe(true);
  });
});

describe("capabilities rule (required block, explicit empties — arc#240)", () => {
  test("pass: full explicit-empties block", () => {
    expect(hasField(validateStrictManifest(validInput()), "capabilities")).toBe(false);
  });
  test("fail: capabilities omitted (no silent 'low')", () => {
    const vs = validateStrictManifest(withManifest({ capabilities: undefined }));
    expect(hasField(vs, "capabilities")).toBe(true);
    expect(vs.find((v) => v.field === "capabilities")!.rule).toContain("240");
  });
  test("fail: filesystem sub-block omitted", () => {
    const vs = validateStrictManifest(
      withManifest({ capabilities: { network: [], bash: { allowed: false }, secrets: [] } }),
    );
    expect(hasField(vs, "capabilities.filesystem")).toBe(true);
  });
  test("fail: bash.allowed omitted", () => {
    const vs = validateStrictManifest(
      withManifest({
        capabilities: { filesystem: { read: [], write: [] }, network: [], bash: {}, secrets: [] },
      }),
    );
    expect(hasField(vs, "capabilities.bash.allowed")).toBe(true);
  });
});

describe("network entry shape ({host, reason} only)", () => {
  test("pass: {host, reason} entry", () => {
    const vs = validateStrictManifest(
      withManifest({
        capabilities: {
          filesystem: { read: [], write: [] },
          network: [{ host: "api.example.com", reason: "fetch data" }],
          bash: { allowed: false },
          secrets: [],
        },
      }),
    );
    expect(vs.some((v) => v.field.startsWith("capabilities.network"))).toBe(false);
  });
  test("fail: string shorthand entry is rejected", () => {
    const vs = validateStrictManifest(
      withManifest({
        capabilities: {
          filesystem: { read: [], write: [] },
          network: ["api.example.com"],
          bash: { allowed: false },
          secrets: [],
        },
      }),
    );
    expect(vs.some((v) => v.field === "capabilities.network[0]")).toBe(true);
  });
  test("fail: legacy {domain, reason} shape is rejected (no host)", () => {
    const vs = validateStrictManifest(
      withManifest({
        capabilities: {
          filesystem: { read: [], write: [] },
          network: [{ domain: "api.example.com", reason: "x" }],
          bash: { allowed: false },
          secrets: [],
        },
      }),
    );
    expect(vs.some((v) => v.field === "capabilities.network[0].host")).toBe(true);
  });
});

describe("secrets entry shape (bare NAME | { name, reason?, optional? } — arc#363)", () => {
  function withSecrets(secrets: unknown): StrictValidationInput {
    return withManifest({
      capabilities: {
        filesystem: { read: [], write: [] },
        network: [],
        bash: { allowed: false },
        secrets,
      },
    });
  }

  test("pass: bare NAME string form", () => {
    const vs = validateStrictManifest(withSecrets(["GITHUB_TOKEN", "APPROVER_GH_TOKEN"]));
    expect(vs.some((v) => v.field.startsWith("capabilities.secrets"))).toBe(false);
  });

  test("pass: object form { name, reason, optional } — the shape install crashed on", () => {
    const vs = validateStrictManifest(
      withSecrets([{ name: "LLAMA_CLOUD_API_KEY", reason: "LlamaParse-backed conversion", optional: true }]),
    );
    expect(vs.some((v) => v.field.startsWith("capabilities.secrets"))).toBe(false);
  });

  test("pass: mixed string + object entries", () => {
    const vs = validateStrictManifest(
      withSecrets(["GITHUB_TOKEN", { name: "LLAMA_CLOUD_API_KEY", optional: true }]),
    );
    expect(vs.some((v) => v.field.startsWith("capabilities.secrets"))).toBe(false);
  });

  test("fail: bare NAME not env-var-shaped", () => {
    const vs = validateStrictManifest(withSecrets(["not-a-var"]));
    expect(hasField(vs, "capabilities.secrets[0]")).toBe(true);
  });

  test("fail: object form missing name", () => {
    const vs = validateStrictManifest(withSecrets([{ reason: "why" }]));
    expect(hasField(vs, "capabilities.secrets[0].name")).toBe(true);
  });

  test("fail: object name not env-var-shaped", () => {
    const vs = validateStrictManifest(withSecrets([{ name: "bad-name" }]));
    expect(hasField(vs, "capabilities.secrets[0].name")).toBe(true);
  });

  test("fail: optional must be boolean", () => {
    const vs = validateStrictManifest(withSecrets([{ name: "TOKEN", optional: "yes" }]));
    expect(hasField(vs, "capabilities.secrets[0].optional")).toBe(true);
  });

  test("fail: reason must be a string", () => {
    const vs = validateStrictManifest(withSecrets([{ name: "TOKEN", reason: 5 }]));
    expect(hasField(vs, "capabilities.secrets[0].reason")).toBe(true);
  });

  test("fail: unexpected key on object form", () => {
    const vs = validateStrictManifest(withSecrets([{ name: "TOKEN", nope: 1 }]));
    expect(hasField(vs, "capabilities.secrets[0]")).toBe(true);
  });

  test("fail: entry is an array (neither string nor object)", () => {
    const vs = validateStrictManifest(withSecrets([["TOKEN"]]));
    expect(hasField(vs, "capabilities.secrets[0]")).toBe(true);
  });
});

describe("namespace rule (optional; BARE scope ^[a-z0-9-]+$ — arc#369)", () => {
  test("pass: bare scope", () => {
    expect(hasField(validateStrictManifest(withManifest({ namespace: "metafactory" })), "namespace")).toBe(false);
  });
  // arc#369: the sigil belongs to the wire/display form, not the manifest field.
  // publish.ts prepends it (`@${scope}`), so a manifest carrying it publishes to
  // `%40%40scope`. Requiring it here made a valid manifest un-publishable.
  test("fail: @-prefixed scope (would double-prefix at publish)", () => {
    expect(hasField(validateStrictManifest(withManifest({ namespace: "@metafactory" })), "namespace")).toBe(true);
  });
  test("fail: uppercase in scope", () => {
    expect(hasField(validateStrictManifest(withManifest({ namespace: "Meta" })), "namespace")).toBe(true);
  });
});

describe("SKILL.md frontmatter name rule (§4.2 PascalCase)", () => {
  test("pass: PascalCase of derived name", () => {
    const input = { ...validInput(), skillFrontmatterName: "CodeReview" };
    expect(hasField(validateStrictManifest(input), "SKILL.md:name")).toBe(false);
  });
  test("fail: non-PascalCase frontmatter name", () => {
    const input = { ...validInput(), skillFrontmatterName: "code-review" };
    expect(hasField(validateStrictManifest(input), "SKILL.md:name")).toBe(true);
  });
  test("fail: SKILL.md present but no name (null)", () => {
    const input = { ...validInput(), skillFrontmatterName: null };
    expect(hasField(validateStrictManifest(input), "SKILL.md:name")).toBe(true);
  });
  test("skipped: no SKILL.md (undefined) → no violation", () => {
    expect(hasField(validateStrictManifest(validInput()), "SKILL.md:name")).toBe(false);
  });
});

describe("top-level shape guard", () => {
  test("fail: manifest is not a mapping", () => {
    const vs = validateStrictManifest({ manifest: "not a map", repoDirName: "x" });
    expect(hasField(vs, "manifest")).toBe(true);
  });
  test("fail: manifest is null", () => {
    const vs = validateStrictManifest({ manifest: null, repoDirName: "x" });
    expect(hasField(vs, "manifest")).toBe(true);
  });
});

describe("toStrictName (§4.2 derivation grammar)", () => {
  test("metafactory-skill-<name>", () => {
    expect(toStrictName("metafactory-skill-code-review")).toBe("code-review");
  });
  test("metafactory-bundle-<name>", () => {
    expect(toStrictName("metafactory-bundle-security")).toBe("security");
  });
  test("metafactory-<app>-skill-<name>", () => {
    expect(toStrictName("metafactory-forge-skill-onboard")).toBe("onboard");
  });
  test("metafactory-<app>-agent-<name> (cortex class, arc#356)", () => {
    expect(toStrictName("metafactory-cortex-agent-luna-lite")).toBe("luna-lite");
    expect(toStrictName("metafactory-cortex-agent-escort")).toBe("escort");
    expect(toStrictName("metafactory-cortex-agent-luna-stack")).toBe("luna-stack");
  });
  test("metafactory-<app>-adapter-<name> (cortex class, arc#356)", () => {
    expect(toStrictName("metafactory-cortex-adapter-slack")).toBe("slack");
  });
  test("metafactory-<app>-renderer-<name> (cortex class, arc#356)", () => {
    expect(toStrictName("metafactory-cortex-renderer-pagerduty")).toBe("pagerduty");
  });
  test("non-matching dir → null", () => {
    expect(toStrictName("release-manager")).toBeNull();
    expect(toStrictName("tmp.abc123")).toBeNull();
    // An unknown <type> segment does not match the app-scoped grammar.
    expect(toStrictName("metafactory-cortex-widget-foo")).toBeNull();
  });
});

describe("toPascalCase", () => {
  test("hyphenated → PascalCase", () => {
    expect(toPascalCase("code-review")).toBe("CodeReview");
  });
  test("single segment", () => {
    expect(toPascalCase("security")).toBe("Security");
  });
});

describe("extractFrontmatterName", () => {
  test("reads name from frontmatter", () => {
    expect(extractFrontmatterName("---\nname: CodeReview\ndescription: x\n---\n# body")).toBe("CodeReview");
  });
  test("null when no frontmatter block", () => {
    expect(extractFrontmatterName("# just a heading")).toBeNull();
  });
  test("null when frontmatter has no name", () => {
    expect(extractFrontmatterName("---\ndescription: x\n---\n")).toBeNull();
  });
});
