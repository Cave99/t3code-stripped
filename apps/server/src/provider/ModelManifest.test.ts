import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ModelManifest from "./ModelManifest.ts";

/**
 * Test policy: this file covers manifest machinery, not manifest contents.
 * Do not add assertions for real model slugs, names, status, aliases, or
 * profiles when editing model-manifest.json. Add tests only when
 * provider-neutral resolver semantics change, and use
 * synthetic models for resolver coverage.
 */

const CODEX = ProviderDriverKind.make("codex");
const model = (overrides: Partial<ServerProviderModel>): ServerProviderModel => ({
  slug: "gpt-test",
  name: "GPT Test",
  isCustom: false,
  capabilities: null,
  ...overrides,
});

describe("classifyModels", () => {
  it("classifies qualified Codex families without changing their wire ids", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: { codex: ["gpt-test"] },
      providers: {
        codex: {
          profiles: {},
          models: [{ slug: "gpt-old", name: "Old", status: "legacy" }],
        },
      },
    };
    const models = [
      model({ slug: "openai.gpt-test", isLegacy: true }),
      model({ slug: "openai.gpt-old" }),
    ];
    assert.deepStrictEqual(
      ModelManifest.classifyModels(models, manifest, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["openai.gpt-test", false],
        ["openai.gpt-old", true],
      ],
    );
  });
  it("flags only known legacy models, clears stale flags, and skips custom models", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: { codex: ["current-a", "current-b"] },
      providers: {
        codex: {
          profiles: {},
          models: [{ slug: "old-model", name: "Old", status: "legacy" }],
        },
      },
    };
    const models = [
      model({ slug: "current-a" }),
      // Stale flag from a previous classification pass must be cleared.
      model({ slug: "current-b", isLegacy: true }),
      model({ slug: "old-model" }),
      model({ slug: "new-release", isLegacy: true }),
      // Custom models are user-defined and never reclassified.
      model({ slug: "my-own-model", isCustom: true }),
    ];
    assert.deepStrictEqual(
      ModelManifest.classifyModels(models, manifest, CODEX).map((entry) => [
        entry.slug,
        entry.isLegacy ?? false,
      ]),
      [
        ["current-a", false],
        ["current-b", false],
        ["old-model", true],
        ["new-release", false],
        ["my-own-model", false],
      ],
    );
  });
  it.each(["codex", "claudeAgent"])(
    "keeps newly discovered %s models current when the manifest has no catalog",
    (driverKind) => {
      const models = [model({ slug: "new-release", isLegacy: true })];
      assert.deepStrictEqual(
        ModelManifest.classifyModels(
          models,
          { version: 1, currentModels: { [driverKind]: ["known-current"] } },
          ProviderDriverKind.make(driverKind),
        ),
        [model({ slug: "new-release" })],
      );
    },
  );
});

describe("applyManifestDefault", () => {
  it("resolves the manifest default to the qualified live model", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: { codex: { models: [], profiles: {}, defaults: { chat: "gpt-test" } } },
    };
    const models = [
      model({ slug: "openai.gpt-old", isDefault: true }),
      model({ slug: "openai.gpt-test" }),
    ];
    assert.strictEqual(
      ModelManifest.applyManifestDefault(models, manifest, CODEX).find((entry) => entry.isDefault)
        ?.slug,
      "openai.gpt-test",
    );
  });
  it("moves the default flag and its aliases to the manifest's chat default", () => {
    const driver = ProviderDriverKind.make("codex");
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        codex: {
          defaults: { chat: "gpt-new" },
          profiles: {},
          models: [{ slug: "gpt-new", name: "New", status: "current" }],
        },
      },
    };
    const models = [
      model({ slug: "gpt-old", isDefault: true, aliases: ["runtime-default"] }),
      model({ slug: "gpt-new" }),
    ];
    assert.deepStrictEqual(ModelManifest.applyManifestDefault(models, manifest, driver), [
      model({ slug: "gpt-old" }),
      model({ slug: "gpt-new", isDefault: true, aliases: ["runtime-default"] }),
    ]);
    // The account does not offer the manifest default: keep the runtime's choice.
    assert.deepStrictEqual(
      ModelManifest.applyManifestDefault(models.slice(0, 1), manifest, driver),
      models.slice(0, 1),
    );
  });
});

describe("applyModelManifest", () => {
  const manifest: ModelManifest.ModelManifestData = {
    version: 1,
    currentModels: {},
    providers: {
      codex: {
        profiles: {},
        models: [
          {
            slug: "gpt-next",
            name: "GPT Next",
            status: "current",
            badge: "new",
            adapter: { codex: { minVersion: "1.2.0" } },
          },
          { slug: "gpt-unversioned", name: "GPT Unversioned", status: "current" },
          {
            slug: "gpt-retired",
            name: "GPT Retired",
            status: "legacy",
            adapter: { codex: { minVersion: "1.2.0" } },
          },
        ],
      },
    },
  };
  const draft = (version: string | null, models: ReadonlyArray<ServerProviderModel> = []) => ({
    enabled: true,
    installed: true,
    version,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  });

  it("names current Codex models that need a newer CLI and are missing from discovery", () => {
    assert.deepStrictEqual(
      ModelManifest.applyModelManifest(draft("1.1.9"), manifest, CODEX).updateRequiredModels,
      [{ slug: "gpt-next", name: "GPT Next", badge: "new", minVersion: "1.2.0" }],
    );
    for (const result of [
      // The CLI is new enough.
      ModelManifest.applyModelManifest(draft("1.2.0"), manifest, CODEX),
      // The CLI already lists the model, even under a qualified slug.
      ModelManifest.applyModelManifest(
        draft("1.1.9", [model({ slug: "openai.gpt-next" })]),
        manifest,
        CODEX,
      ),
      // An unknown version cannot be compared.
      ModelManifest.applyModelManifest(draft(null), manifest, CODEX),
      // A qualified manifest slug still matches the discovered family.
      ModelManifest.applyModelManifest(
        draft("1.1.9", [model({ slug: "gpt-next" })]),
        {
          ...manifest,
          providers: {
            codex: {
              profiles: {},
              models: [{ ...manifest.providers!.codex!.models[0]!, slug: "openai.gpt-next" }],
            },
          },
        },
        CODEX,
      ),
    ]) {
      assert.isUndefined(result.updateRequiredModels);
    }
  });
});

describe("resolveProviderCatalog", () => {
  it("resolves generic model presentation through a reusable profile", () => {
    const manifest: ModelManifest.ModelManifestData = {
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          defaults: { chat: "model-next" },
          profiles: {
            standard: {
              capabilities: {
                optionDescriptors: [
                  {
                    id: "mode",
                    label: "Mode",
                    type: "select",
                    options: [{ id: "fast", label: "Fast", isDefault: true }],
                  },
                ],
              },
              adapter: { opaque: true },
            },
          },
          models: [
            {
              slug: "model-next",
              name: "Model Next",
              aliases: ["next"],
              status: "current",
              badge: "new",
              profile: "standard",
            },
          ],
        },
      },
    };

    const catalog = ModelManifest.resolveProviderCatalog(
      manifest,
      ProviderDriverKind.make("synthetic"),
    );
    assert.deepStrictEqual(catalog?.models[0], {
      model: {
        slug: "model-next",
        name: "Model Next",
        aliases: ["next"],
        badge: "new",
        isCustom: false,
        isDefault: true,
        capabilities: manifest.providers!.synthetic!.profiles.standard!.capabilities!,
      },
      adapter: undefined,
      profileAdapter: { opaque: true },
    });
  });

  it("rejects invalid catalog references", () => {
    const invalidCatalog = (input: {
      readonly models: NonNullable<ModelManifest.ModelManifestData["providers"]>[string]["models"];
      readonly defaultChat?: string;
    }): ModelManifest.ModelManifestData => ({
      version: 1,
      currentModels: {},
      providers: {
        synthetic: {
          ...(input.defaultChat ? { defaults: { chat: input.defaultChat } } : {}),
          profiles: {},
          models: input.models,
        },
      },
    });

    for (const invalid of [
      invalidCatalog({
        models: [
          { slug: "duplicate", name: "First", status: "current" },
          { slug: "duplicate", name: "Second", status: "current" },
        ],
      }),
      invalidCatalog({
        models: [
          {
            slug: "missing-profile",
            name: "Missing Profile",
            status: "current",
            profile: "missing",
          },
        ],
      }),
      invalidCatalog({
        models: [{ slug: "present", name: "Present", status: "current" }],
        defaultChat: "absent",
      }),
    ]) {
      assert.isNull(
        ModelManifest.resolveProviderCatalog(invalid, ProviderDriverKind.make("synthetic")),
      );
    }
  });
});

// Remote fixtures date after the bundle so a fetch still outranks it.
it.effect("uses bundled metadata without external dependencies", () =>
  Effect.gen(function* () {
    const service = yield* ModelManifest.ModelManifest;
    assert.strictEqual(yield* service.current, ModelManifest.BUNDLED_MODEL_MANIFEST);
  }).pipe(Effect.provide(ModelManifest.layer)),
);
