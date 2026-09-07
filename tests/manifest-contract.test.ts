import { describe, it, expect } from "vitest";
import manifest from "../src/manifest.js";

// The secret picker on current Paperclip hosts binds an OBJECT-shaped secret
// reference; older hosts persist a bare UUID string. A manifest that declares
// only "string" makes the two mutually unsatisfiable and the plugin becomes
// unconfigurable on one of them (the exact issue the sibling plugins hit).
describe("manifest secret-ref contract", () => {
  const props = manifest.instanceConfigSchema.properties as Record<string, any>;

  for (const key of ["slackTokenRef", "slackSigningSecretRef"]) {
    it(`declares ${key} as a string|object secret ref`, () => {
      expect(props[key].type).toEqual(["string", "object"]);
      expect(props[key].format).toBe("secret-ref");
    });
  }

  it("accepts additional properties so a delivered config with extra keys validates", () => {
    expect((manifest.instanceConfigSchema as any).additionalProperties).toBe(true);
  });

  it("requires the token, signing secret, and default channel", () => {
    expect(manifest.instanceConfigSchema.required).toEqual(
      expect.arrayContaining(["slackTokenRef", "slackSigningSecretRef", "defaultChannelId"]),
    );
  });

  it("declares no companyId config field (the company is host-authoritative)", () => {
    expect(props.companyId).toBeUndefined();
  });
});
