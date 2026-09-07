import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Company-scoped config bootstrap — issue #31.
//
// Since paperclipai/paperclip#9557 (first stable in v2026.720.0) the SDK's
// governed-access gate requires a company scope for `config.get` and
// `secrets.resolve`; only `companies.list` is exempt. setup() runs outside any
// invocation, so a bare `ctx.config.get()` there throws and the worker dies on
// activation — which is exactly what the Slack plugin used to do.
//
// The plugin now registers every handler in setup() unconditionally and builds
// its runtime only from an `onConfigChanged` delivery, resolving secrets under
// the company the host attributed the delivery to. These tests pin that on the
// host generations the plugin must survive. The mocks copy the real host where
// it bites:
//   - an unscoped `config.get()` THROWS, it never returns `{}`;
//   - `secrets.resolve` REJECTS every string secretRef and interpolates the
//     rejected value into its error (plugin-secrets-handler.ts);
//   - with `enforceInvocationScope`, a scoped read succeeds only for the company
//     the current host->worker invocation is bound to (720/722 semantics).
// ---------------------------------------------------------------------------

const { capturedDefinitions } = vi.hoisted(() => {
  const capturedDefinitions: any[] = [];
  return { capturedDefinitions };
});

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (def: any) => {
    if (def.setup) capturedDefinitions.push(def);
    return Object.freeze({ definition: def });
  },
  runWorker: vi.fn(),
}));

import { _resetRuntimeForTests, _getRuntimeForTests } from "../src/worker.js";

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "33333333-3333-3333-3333-333333333333";
const SIGNING_SECRET_ID = "55555555-5555-5555-5555-555555555555";

const UNSCOPED_CONFIG_ERROR =
  'not allowed to perform "config.get": company context is required';

/** The stored config row the settings picker produces. */
function storedConfig(overrides: Record<string, unknown> = {}) {
  return {
    slackTokenRef: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
    slackSigningSecretRef: { type: "secret_ref", secretId: SIGNING_SECRET_ID, version: "latest" },
    defaultChannelId: "C01ABC2DEF3",
    enableDailyDigest: false,
    ...overrides,
  };
}

type HostOptions = {
  companies?: string[];
  rows?: Record<string, Record<string, unknown>>;
  denyScopedConfig?: boolean;
  enforceInvocationScope?: boolean;
};

function buildHost(options: HostOptions = {}) {
  const {
    companies = [COMPANY_A],
    rows = { [COMPANY_A]: storedConfig() },
    denyScopedConfig = false,
    enforceInvocationScope = false,
  } = options;

  const stateStore = new Map<string, unknown>();
  const eventHandlers = new Map<string, any[]>();
  let invocationScope: string | null = null;

  const ctx = {
    config: {
      get: vi.fn(async (companyId?: string) => {
        if (!companyId) throw new Error(UNSCOPED_CONFIG_ERROR);
        if (enforceInvocationScope) {
          if (!invocationScope) throw new Error(UNSCOPED_CONFIG_ERROR);
          if (companyId !== invocationScope) {
            throw new Error(
              `requested company "${companyId}" but the current invocation is scoped to company "${invocationScope}"`,
            );
          }
        }
        if (denyScopedConfig) throw new Error(UNSCOPED_CONFIG_ERROR);
        return rows[companyId] ?? {};
      }),
    },
    secrets: {
      resolve: vi.fn(async (secretRef: unknown, opts?: { configPath?: string }) => {
        if (typeof secretRef === "string") {
          throw new Error(
            `Invalid secret reference for plugin: ${secretRef}. Use { type: "secret_ref", secretId, version? }`,
          );
        }
        return opts?.configPath === "slackSigningSecretRef" ? "signing-secret" : "xoxb-token";
      }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    state: {
      get: vi.fn(async (key: any) => stateStore.get(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`) ?? null),
      set: vi.fn(async (key: any, value: unknown) => {
        stateStore.set(`${key.scopeKind}:${key.scopeId ?? ""}:${key.stateKey}`, value);
      }),
      delete: vi.fn(async () => {}),
    },
    metrics: { write: vi.fn() },
    activity: { log: vi.fn() },
    jobs: { register: vi.fn() },
    tools: { register: vi.fn() },
    data: { register: vi.fn() },
    actions: { register: vi.fn() },
    events: {
      on: vi.fn((name: string, handler: any) => {
        const list = eventHandlers.get(name) ?? [];
        list.push(handler);
        eventHandlers.set(name, list);
      }),
      emit: vi.fn(),
      subscribe: vi.fn(),
    },
    companies: {
      list: vi.fn(async (input?: { limit?: number; offset?: number }) => {
        const all = companies.map((id) => ({ id, name: `Company ${id.slice(0, 4)}` }));
        if (!input?.limit) return all;
        const offset = input.offset ?? 0;
        return all.slice(offset, offset + input.limit);
      }),
    },
    agents: { list: vi.fn(async () => []), sessions: { sendMessage: vi.fn() } },
    issues: { list: vi.fn(async () => []) },
    http: { fetch: vi.fn(async () => ({ ok: true, json: async () => ({}), text: async () => "" })) },
  } as any;

  return {
    ctx,
    async deliver(companyId: string | null, config: Record<string, unknown>, opts?: { withContext?: boolean }) {
      if (companyId) invocationScope = companyId;
      try {
        if (opts?.withContext === false) {
          await definition().onConfigChanged(config);
        } else {
          await definition().onConfigChanged(config, { companyId });
        }
      } finally {
        invocationScope = null;
      }
    },
    setInvocationScope(companyId: string | null) {
      invocationScope = companyId;
    },
    everythingSaid(diagnostics: unknown) {
      return JSON.stringify([
        diagnostics,
        ctx.logger.warn.mock.calls,
        ctx.logger.error.mock.calls,
        ctx.logger.info.mock.calls,
        ctx.logger.debug.mock.calls,
      ]);
    },
  };
}

function definition(): any {
  return capturedDefinitions[capturedDefinitions.length - 1];
}

function toolHandler(ctx: any, name: string) {
  return ctx.tools.register.mock.calls.find((call: any[]) => call[0] === name)![2];
}

beforeEach(() => {
  _resetRuntimeForTests();
  vi.clearAllMocks();
});

describe("registration contract", () => {
  it("registers every handler during setup(), before any config is readable", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });

    await definition().setup(ctx);

    const jobKeys = ctx.jobs.register.mock.calls.map((call: any[]) => call[0]);
    expect(jobKeys).toEqual(
      expect.arrayContaining(["daily-digest", "check-escalation-timeouts", "check-watches"]),
    );

    const toolNames = ctx.tools.register.mock.calls.map((call: any[]) => call[0]);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "escalate_to_human",
        "handoff_to_agent",
        "discuss_with_agent",
        "process_media",
        "register_command",
        "register_watch",
      ]),
    );

    const actionNames = ctx.actions.register.mock.calls.map((call: any[]) => call[0]);
    expect(actionNames).toEqual(expect.arrayContaining(["set-channel"]));
  });

  it("reads nothing at setup(): no unscoped config.get, no secrets.resolve", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });

    await expect(definition().setup(ctx)).resolves.toBeUndefined();

    expect(ctx.config.get).not.toHaveBeenCalled();
    expect(ctx.secrets.resolve).not.toHaveBeenCalled();
    expect(_getRuntimeForTests()).toBeNull();
    expect((await definition().onHealth()).status).toBe("degraded");
  });

  it("tools answer with a clear not-configured error until the runtime exists", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);

    const escalate = toolHandler(ctx, "escalate_to_human");
    const result = await escalate({ reason: "why" }, { companyId: COMPANY_A });

    expect(result.error).toMatch(/not configured yet/);
  });
});

describe("bootstrap from a config delivery", () => {
  it("builds the runtime and reports healthy", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    expect(_getRuntimeForTests()).toBeNull();

    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.token).toBe("xoxb-token");
    expect(_getRuntimeForTests()?.signingSecret).toBe("signing-secret");
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("resolves the bot token with the company scope and the config path", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });

    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
      { companyId: COMPANY_A, configPath: "slackTokenRef" },
    );
    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SIGNING_SECRET_ID, version: "latest" },
      { companyId: COMPANY_A, configPath: "slackSigningSecretRef" },
    );
  });

  it("canonicalizes a legacy bare-UUID token reference into the object binding", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);
    await definition().onConfigChanged(storedConfig({ slackTokenRef: SECRET_ID }), { companyId: COMPANY_A });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SECRET_ID },
      { companyId: COMPANY_A, configPath: "slackTokenRef" },
    );
  });

  it("refuses a non-UUID token string without echoing the supplied value anywhere", async () => {
    const RAW = "RAW_SECRET_SENTINEL_do_not_leak";
    const host = buildHost({ denyScopedConfig: true });
    await definition().setup(host.ctx);
    await definition().onConfigChanged(storedConfig({ slackTokenRef: RAW }), { companyId: COMPANY_A });

    expect(_getRuntimeForTests()).toBeNull();
    expect(host.ctx.secrets.resolve).not.toHaveBeenCalledWith(RAW, expect.anything());
    const diagnostics = await definition().onHealth();
    expect(diagnostics.status).toBe("degraded");
    expect(diagnostics.message).toMatch(/slackTokenRef/);
    expect(host.everythingSaid(diagnostics)).not.toContain(RAW);
  });

  it("identifies a context-less delivery by scoped probe, not by list order (720/722)", async () => {
    const host = buildHost({
      companies: [COMPANY_A, COMPANY_B],
      rows: { [COMPANY_B]: storedConfig() },
      enforceInvocationScope: true,
    });
    await definition().setup(host.ctx);

    host.setInvocationScope(COMPANY_B);
    await definition().onConfigChanged(storedConfig()); // no context
    host.setInvocationScope(null);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
    expect(host.ctx.secrets.resolve).toHaveBeenCalledWith(expect.anything(), {
      companyId: COMPANY_B,
      configPath: "slackTokenRef",
    });
  });

  it("degrades with a clear message when no company scope can be identified", async () => {
    const { ctx } = buildHost({ companies: [COMPANY_A, COMPANY_B], denyScopedConfig: true });
    await definition().setup(ctx);

    await definition().onConfigChanged(storedConfig(), { companyId: null });

    expect(_getRuntimeForTests()).toBeNull();
    expect((await definition().onHealth()).message).toMatch(/company/i);
  });

  it("recovers the owner on its next valid save after a failed bootstrap", async () => {
    const host = buildHost({ denyScopedConfig: true });
    await definition().setup(host.ctx);

    await definition().onConfigChanged(storedConfig({ slackTokenRef: "" }), { companyId: COMPANY_A });
    expect(_getRuntimeForTests()).toBeNull();

    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("keeps the live runtime when the owner's re-save has a broken token", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    expect(_getRuntimeForTests()?.token).toBe("xoxb-token");

    // A re-saves with an unresolvable token: the plugin degrades but keeps
    // serving on the runtime it already has, rather than going fully dark.
    await host.deliver(COMPANY_A, storedConfig({ slackTokenRef: "" }));

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.token).toBe("xoxb-token");
    expect((await definition().onHealth()).status).toBe("degraded");
  });
});

describe("context-less delivery to a running install (720/722)", () => {
  it("refreshes in place when the running company re-saves without context", async () => {
    const host = buildHost({
      companies: [COMPANY_A],
      rows: { [COMPANY_A]: storedConfig() },
      enforceInvocationScope: true,
    });
    host.setInvocationScope(COMPANY_A);
    await definition().setup(host.ctx);
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);

    host.setInvocationScope(COMPANY_A);
    await definition().onConfigChanged(storedConfig({ defaultChannelId: "C77NEW7NEW7" })); // no context
    host.setInvocationScope(null);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.config.defaultChannelId).toBe("C77NEW7NEW7");
  });

  it("leaves the running company untouched when the delivery belongs to another", async () => {
    const host = buildHost({
      companies: [COMPANY_A, COMPANY_B],
      rows: { [COMPANY_A]: storedConfig(), [COMPANY_B]: storedConfig() },
      enforceInvocationScope: true,
    });
    host.setInvocationScope(COMPANY_A);
    await definition().setup(host.ctx);
    await definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);

    host.setInvocationScope(COMPANY_B);
    await definition().onConfigChanged(storedConfig({ defaultChannelId: "C99ZZZ9ZZZ9" })); // no context, B's invocation
    host.setInvocationScope(null);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.config.defaultChannelId).toBe("C01ABC2DEF3");
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_A}`),
      expect.objectContaining({ runningCompanyId: COMPANY_A, deliveredCompanyId: COMPANY_B }),
    );
  });
});

describe("single-tenant ownership", () => {
  it("keeps the first delivered company and refuses a different one", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);

    await host.deliver(COMPANY_A, storedConfig());
    await host.deliver(COMPANY_B, storedConfig({ defaultChannelId: "C99ZZZ9ZZZ9" }));

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.config.defaultChannelId).toBe("C01ABC2DEF3");
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_A}`),
      expect.objectContaining({ deliveredCompanyId: COMPANY_B }),
    );
  });

  it("advances the owner on an identical configuration, as the host's guard does", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);

    const duplicated = storedConfig();
    await host.deliver(COMPANY_A, duplicated);
    await host.deliver(COMPANY_B, { ...duplicated });

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_B);
    expect(host.ctx.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("owner advancing"),
      expect.objectContaining({ previousCompanyId: COMPANY_A, companyId: COMPANY_B }),
    );
  });

  it("re-applies config in place on the owner's own subsequent save", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());

    await host.deliver(COMPANY_A, storedConfig({ defaultChannelId: "C77NEW7NEW7" }));

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.config.defaultChannelId).toBe("C77NEW7NEW7");
  });

  it("serializes two back-to-back saves; the last one wins", async () => {
    const host = buildHost({ rows: {} });
    await definition().setup(host.ctx);

    const first = definition().onConfigChanged(storedConfig(), { companyId: COMPANY_A });
    const second = definition().onConfigChanged(
      storedConfig({ defaultChannelId: "C88LAST8LST" }),
      { companyId: COMPANY_A },
    );
    await Promise.all([first, second]);

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.config.defaultChannelId).toBe("C88LAST8LST");
  });
});

describe("host-authoritative company scoping", () => {
  it("refuses a tool invocation from a company that is not the owner", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_B, storedConfig());

    const escalate = toolHandler(host.ctx, "escalate_to_human");
    const result = await escalate({ reason: "why" }, { companyId: COMPANY_A });

    expect(result.error).toMatch(/not configured yet/);
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`this install serves ${COMPANY_B}`),
      expect.objectContaining({ invokingCompanyId: COMPANY_A }),
    );
  });
});

describe("webhook fails closed until configured", () => {
  it("rejects a non-verification webhook before bootstrap", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);

    await definition().onWebhook({
      endpointKey: "slash-command",
      headers: {},
      rawBody: "command=/clip&text=status",
      parsedBody: { command: "/clip" },
      requestId: "req-1",
    });

    expect(ctx.http.fetch).not.toHaveBeenCalled();
    expect(ctx.metrics.write).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not configured yet"),
    );
  });

  it("lets the Slack URL-verification handshake through without a runtime", async () => {
    const { ctx } = buildHost({ denyScopedConfig: true });
    await definition().setup(ctx);

    await expect(
      definition().onWebhook({
        endpointKey: "slack-events",
        headers: {},
        rawBody: JSON.stringify({ type: "url_verification", challenge: "abc" }),
        parsedBody: { type: "url_verification", challenge: "abc" },
        requestId: "req-2",
      }),
    ).resolves.toBeUndefined();

    expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("not configured yet"));
  });

  it("rejects an unsigned webhook after bootstrap (signature required)", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    host.ctx.logger.warn.mockClear();

    await definition().onWebhook({
      endpointKey: "slash-command",
      headers: {},
      rawBody: "command=/clip&text=status",
      parsedBody: { command: "/clip" },
      requestId: "req-3",
    });

    expect(host.ctx.http.fetch).not.toHaveBeenCalled();
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid Slack signature"),
    );
  });
});

describe("round-1 review fixes", () => {
  it("F1: rejects a slash-command whose parsed body claims type=url_verification", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    host.ctx.logger.warn.mockClear();

    // The url_verification exemption must be scoped to the Events endpoint; a
    // slash-command carrying that body must still be signature-verified.
    await definition().onWebhook({
      endpointKey: "slash-command",
      headers: {},
      rawBody: "command=/clip&text=status",
      parsedBody: { type: "url_verification", command: "/clip" },
      requestId: "req-f1",
    });

    expect(host.ctx.http.fetch).not.toHaveBeenCalled();
    expect(host.ctx.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid Slack signature"),
    );
  });

  it("F2: the daily digest processes only the owner across multiple visible companies", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig({ enableDailyDigest: true }));

    const digest = host.ctx.jobs.register.mock.calls.find((c: any[]) => c[0] === "daily-digest")![1];
    await digest();

    expect(host.ctx.issues.list).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_A }));
    expect(host.ctx.issues.list).not.toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_B }));
  });

  it("F3: refuses remove_watch from a non-owner company", async () => {
    const host = buildHost({ companies: [COMPANY_A, COMPANY_B] });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_B, storedConfig());

    const remove = toolHandler(host.ctx, "remove_watch");
    const result = await remove({ watchId: "watch-x" }, { companyId: COMPANY_A });

    expect(result.error).toMatch(/not configured yet/);
  });

  it("F4: normalizes a legacy bare-UUID signing-secret ref before resolving", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig({ slackSigningSecretRef: SIGNING_SECRET_ID }));

    expect(host.ctx.secrets.resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: SIGNING_SECRET_ID },
      { companyId: COMPANY_A, configPath: "slackSigningSecretRef" },
    );
    expect(_getRuntimeForTests()?.signingSecret).toBe("signing-secret");
    expect(await definition().onHealth()).toEqual({ status: "ok" });
  });

  it("F4: builds the runtime but degrades health when the signing secret cannot resolve", async () => {
    const host = buildHost();
    host.ctx.secrets.resolve.mockImplementation(async (ref: unknown, opts?: { configPath?: string }) => {
      if (opts?.configPath === "slackSigningSecretRef") throw new Error("signing resolution failed");
      if (typeof ref === "string") throw new Error("string refs rejected");
      return "xoxb-token";
    });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.signingSecret).toBeNull();
    const health = await definition().onHealth();
    expect(health.status).toBe("degraded");
    expect(health.message).toMatch(/signing secret/i);
  });

  it("F5: redacts a resolver error that embeds the supplied secret id", async () => {
    const host = buildHost();
    host.ctx.secrets.resolve.mockImplementation(async (ref: unknown) => {
      throw new Error(`host rejected ${JSON.stringify(ref)} secretId=${(ref as any)?.secretId ?? ref}`);
    });
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());

    const diagnostics = await definition().onHealth();
    expect(diagnostics.status).toBe("degraded");
    expect(host.everythingSaid(diagnostics)).not.toContain(SECRET_ID);
  });

  it("F6: a failed refresh that also changes the base URL leaves the retained runtime coherent", async () => {
    const host = buildHost();
    await definition().setup(host.ctx);
    await host.deliver(COMPANY_A, storedConfig());
    const baseBefore = _getRuntimeForTests()?.baseUrl;

    await host.deliver(COMPANY_A, storedConfig({ slackTokenRef: "", paperclipBaseUrl: "http://changed.invalid:9999" }));

    expect(_getRuntimeForTests()?.companyId).toBe(COMPANY_A);
    expect(_getRuntimeForTests()?.baseUrl).toBe(baseBefore);
  });
});
