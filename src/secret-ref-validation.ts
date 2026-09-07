export type SecretRefConfig = {
  slackTokenRef?: unknown;
  slackSigningSecretRef?: unknown;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FIELDS = [
  { key: "slackTokenRef", required: true },
  { key: "slackSigningSecretRef", required: true },
] as const;

/**
 * A secret reference, in either shape a Paperclip host may use.
 *
 * Older hosts take a bare secret UUID string. Current hosts require an object
 * `{ type: "secret_ref", secretId, version? }` and reject the bare string, so
 * both must be accepted or the plugin is unconfigurable on one of them.
 */
export type SecretRef = string | { type: "secret_ref"; secretId: string; version?: number };

export function isValidSecretRef(value: unknown): value is SecretRef {
  if (typeof value === "string") return UUID_RE.test(value.trim());
  if (typeof value === "object" && value !== null) {
    const record = value as { type?: unknown; secretId?: unknown };
    return (
      record.type === "secret_ref" &&
      typeof record.secretId === "string" &&
      UUID_RE.test(record.secretId.trim())
    );
  }
  return false;
}

/**
 * Coerce a secret ref into the shape THIS host accepts before calling
 * ctx.secrets.resolve().
 *
 * Refs reach us in both shapes: config validated by a current host holds
 * `{ type: "secret_ref", secretId }`, while refs persisted by an older host
 * hold a bare UUID string. Hosts that require the object form reject the bare
 * string with "Invalid secret reference for plugin: <uuid>. Use
 * { type: "secret_ref" ... }", which surfaces to the user as an unexplained
 * 403 from whatever the token was needed for.
 *
 * Passing the object through unchanged keeps older hosts working, since they
 * accept it as an opaque ref.
 */
export function normalizeSecretRef(value: unknown): SecretRef | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return UUID_RE.test(trimmed) ? { type: "secret_ref", secretId: trimmed } : null;
  }
  return isValidSecretRef(value) ? value : null;
}

/** The bare secret UUID a ref points at, in either shape, or null. */
export function normalizeSecretRefId(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return UUID_RE.test(trimmed) ? trimmed : null;
  }
  if (typeof value === "object" && value !== null) {
    const record = value as { type?: unknown; secretId?: unknown };
    if (record.type === "secret_ref" && typeof record.secretId === "string") {
      const trimmed = record.secretId.trim();
      return UUID_RE.test(trimmed) ? trimmed : null;
    }
  }
  return null;
}

/** True when the config value can actually be handed to ctx.secrets.resolve. */
export function isUsableSecretRef(value: unknown): boolean {
  return normalizeSecretRef(value) !== null;
}

function describeBadValue(value: unknown): string {
  if (value === undefined || value === null) return "<empty>";
  if (typeof value === "object") return "<object>";
  if (typeof value !== "string") return `<${typeof value}>`;
  const trimmed = value.trim();
  if (trimmed.length === 0) return "<empty string>";
  // Never echo any characters of the supplied value: an operator may paste a
  // raw Slack token here, and even a prefix in an error log is a leak.
  return `<non-UUID string, length ${trimmed.length}>`;
}

/**
 * Strip any occurrence of the given secret references out of a message before
 * it is logged or published to health. The governed host interpolates the ref
 * it rejected into its error text, so a resolver error can otherwise carry the
 * supplied secretId (or a raw pasted value) into durable diagnostics.
 */
export function redactSecretRefs(message: string, ...refs: unknown[]): string {
  let out = message;
  for (const ref of refs) {
    const id = normalizeSecretRefId(ref);
    if (id) out = out.split(id).join("[redacted]");
    if (ref && typeof ref === "object") {
      out = out.split(JSON.stringify(ref)).join("[redacted]");
    } else if (typeof ref === "string") {
      const trimmed = ref.trim();
      if (trimmed.length >= 6) out = out.split(trimmed).join("[redacted]");
    }
  }
  return out;
}

function fieldError(key: string, value: unknown): string {
  return [
    `${key} must be the UUID of a Paperclip secret`,
    `(format 8-4-4-4-12, e.g. "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1").`,
    `Got ${describeBadValue(value)}.`,
    `Create the secret first via Settings → Secrets and paste the returned "id" value here —`,
    `not the raw token, the whole JSON response, or any other identifier.`,
  ].join(" ");
}

export function validateSecretRefFields(config: SecretRefConfig): string[] {
  const errors: string[] = [];
  for (const { key, required } of FIELDS) {
    const value = config[key];
    const isMissing =
      value === undefined ||
      value === null ||
      (typeof value === "string" && value.trim().length === 0);

    if (isMissing) {
      if (required) errors.push(`${key} is required.`);
      continue;
    }

    if (!isValidSecretRef(value)) {
      errors.push(fieldError(key, value));
    }
  }
  return errors;
}
