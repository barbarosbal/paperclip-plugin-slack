import { describe, it, expect } from "vitest";
import {
  isValidSecretRef,
  normalizeSecretRef,
  normalizeSecretRefId,
  isUsableSecretRef,
  redactSecretRefs,
  validateSecretRefFields,
} from "../src/secret-ref-validation.js";

const UUID = "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1";
const OTHER_UUID = "99999999-9999-4999-8999-999999999999";

describe("isValidSecretRef", () => {
  it("accepts a bare UUID string and an object ref", () => {
    expect(isValidSecretRef(UUID)).toBe(true);
    expect(isValidSecretRef({ type: "secret_ref", secretId: UUID })).toBe(true);
    expect(isValidSecretRef({ type: "secret_ref", secretId: UUID, version: 2 })).toBe(true);
  });

  it("rejects a raw token, an empty value, and a malformed object", () => {
    expect(isValidSecretRef("xoxb-not-a-uuid")).toBe(false);
    expect(isValidSecretRef("")).toBe(false);
    expect(isValidSecretRef(undefined)).toBe(false);
    expect(isValidSecretRef({ type: "secret_ref", secretId: "nope" })).toBe(false);
    expect(isValidSecretRef({ secretId: UUID })).toBe(false);
  });
});

describe("normalizeSecretRef", () => {
  it("coerces a bare UUID string into the object binding the host requires", () => {
    expect(normalizeSecretRef(UUID)).toEqual({ type: "secret_ref", secretId: UUID });
  });

  it("passes a valid object ref through unchanged", () => {
    const ref = { type: "secret_ref", secretId: UUID, version: 3 };
    expect(normalizeSecretRef(ref)).toBe(ref);
  });

  it("returns null for anything unusable", () => {
    expect(normalizeSecretRef("raw-token")).toBeNull();
    expect(normalizeSecretRef(undefined)).toBeNull();
    expect(normalizeSecretRef({ secretId: UUID })).toBeNull();
  });
});

describe("normalizeSecretRefId", () => {
  it("extracts the bare UUID from either shape", () => {
    expect(normalizeSecretRefId(UUID)).toBe(UUID);
    expect(normalizeSecretRefId({ type: "secret_ref", secretId: UUID })).toBe(UUID);
    expect(normalizeSecretRefId("not-a-uuid")).toBeNull();
    expect(normalizeSecretRefId(null)).toBeNull();
  });
});

describe("isUsableSecretRef", () => {
  it("is true only for a resolvable ref", () => {
    expect(isUsableSecretRef(UUID)).toBe(true);
    expect(isUsableSecretRef({ type: "secret_ref", secretId: UUID })).toBe(true);
    expect(isUsableSecretRef("")).toBe(false);
    expect(isUsableSecretRef(undefined)).toBe(false);
  });
});

describe("validateSecretRefFields", () => {
  it("passes when both required refs are valid", () => {
    expect(
      validateSecretRefFields({
        slackTokenRef: UUID,
        slackSigningSecretRef: { type: "secret_ref", secretId: OTHER_UUID },
      }),
    ).toEqual([]);
  });

  it("flags a missing required ref", () => {
    const errors = validateSecretRefFields({ slackSigningSecretRef: UUID });
    expect(errors).toContain("slackTokenRef is required.");
  });

  it("flags a malformed ref without echoing the raw value", () => {
    const errors = validateSecretRefFields({
      slackTokenRef: "xoxb-raw-token-do-not-leak-xxxxxxxx",
      slackSigningSecretRef: UUID,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/slackTokenRef must be the UUID/);
    // Not even a prefix of the pasted value may appear.
    expect(errors[0]).not.toContain("xoxb");
  });
});

describe("redactSecretRefs", () => {
  it("strips an object ref's secretId, its JSON form, and a raw string ref", () => {
    const objMsg = `host rejected ${JSON.stringify({ type: "secret_ref", secretId: UUID })} secretId=${UUID}`;
    const redactedObj = redactSecretRefs(objMsg, { type: "secret_ref", secretId: UUID });
    expect(redactedObj).not.toContain(UUID);
    expect(redactedObj).toContain("[redacted]");

    const strMsg = `Invalid secret reference for plugin: raw-token-value-123456`;
    const redactedStr = redactSecretRefs(strMsg, "raw-token-value-123456");
    expect(redactedStr).not.toContain("raw-token-value-123456");
    expect(redactedStr).toContain("[redacted]");
  });

  it("leaves an unrelated message untouched", () => {
    expect(redactSecretRefs("company context is required", UUID)).toBe(
      "company context is required",
    );
  });
});
