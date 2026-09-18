import { describe, it, expect, vi } from "vitest";
import {
  normalizeRuntimeError,
  formatFounderBlockedAlert,
  formatFounderApprovalAlert,
  formatFounderRunErrorAlert,
  formatFounderParentCompleteAlert,
  looksLikeUuid,
  shouldEmitParentCompleteAlert,
  founderAlertDedupKey,
  resolveFounderAlertContext,
} from "../src/founder-alerts.js";
import { STATE_KEYS } from "../src/constants.js";

describe("normalizeRuntimeError", () => {
  it("maps Claude session limit errors to Turkish", () => {
    const raw =
      "Claude run failed: subtype=success: You have hit your session limit - resets 10pm";
    expect(normalizeRuntimeError(raw)).toBe(
      "Claude session limiti doldu. 22:00'de sifirlaniyor.",
    );
  });

  it("defaults session limit reset hour to 22:00 when time missing", () => {
    expect(normalizeRuntimeError("session limit reached")).toBe(
      "Claude session limiti doldu. 22:00'de sifirlaniyor.",
    );
  });
});

describe("founder alert formats", () => {
  const ctx = {
    project: "Ratel Systems",
    agent: "Hürkuş",
    issueIdentifier: "RAT-94",
  };

  it("formats blocked alerts", () => {
    expect(formatFounderBlockedAlert(ctx, "API yazimi basarisiz")).toBe(
      "Ratel Systems . Hürkuş . RAT-94 -- Ilerleyemiyor. Mudahale gerekiyor: API yazimi basarisiz",
    );
  });

  it("formats approval alerts", () => {
    expect(formatFounderApprovalAlert(ctx, "Plan revizyonu")).toBe(
      "Ratel Systems . Hürkuş -- Onay bekliyor: Plan revizyonu",
    );
  });

  it("formats run error alerts", () => {
    expect(
      formatFounderRunErrorAlert(ctx, "Claude session limiti doldu. 22:00'de sifirlaniyor."),
    ).toBe(
      "Ratel Systems . Hürkuş . RAT-94 -- Claude session limiti doldu. 22:00'de sifirlaniyor.",
    );
  });

  it("formats parent completion alerts", () => {
    expect(formatFounderParentCompleteAlert(ctx)).toBe(
      "Ratel Systems . Hürkuş . RAT-94 -- Parent tamamlandi. Founder acceptance bekliyor.",
    );
  });
});

describe("shouldEmitParentCompleteAlert", () => {
  it("allows parent issues without parentId", () => {
    expect(shouldEmitParentCompleteAlert({ parentId: null })).toBe(true);
  });

  it("blocks child issue done events", () => {
    expect(
      shouldEmitParentCompleteAlert({ parentId: "parent-uuid" }),
    ).toBe(false);
    expect(shouldEmitParentCompleteAlert(null, { parentId: "parent-uuid" })).toBe(
      false,
    );
  });

  it("does not emit when issue record is missing (fail-safe)", () => {
    expect(shouldEmitParentCompleteAlert(null)).toBe(false);
    expect(shouldEmitParentCompleteAlert(null, { status: "done" })).toBe(false);
  });
});

describe("name resolution", () => {
  it("detects UUID-like strings", () => {
    expect(looksLikeUuid("e31aa2e9-5995-4f68-bce3-751396d1acca")).toBe(true);
    expect(looksLikeUuid("Hürkuş")).toBe(false);
  });

  it("resolves agent and project names instead of UUIDs", async () => {
    const ctx = {
      agents: {
        list: vi.fn().mockResolvedValue([
          {
            id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            name: "Hürkuş",
          },
        ]),
      },
      projects: {
        get: vi.fn().mockResolvedValue({
          id: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
          name: "Ratel Systems",
        }),
      },
      issues: {
        get: vi.fn().mockResolvedValue({
          id: "iss-1",
          identifier: "RAT-94",
          parentId: null,
          projectId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
          assigneeAgentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          executionAgentNameKey: null,
        }),
      },
    };

    const result = await resolveFounderAlertContext(
      ctx as never,
      "co-1",
      {
        agentId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        projectId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
      },
      "iss-1",
      {},
    );

    expect(result.project).toBe("Ratel Systems");
    expect(result.agent).toBe("Hürkuş");
    expect(result.issueIdentifier).toBe("RAT-94");
  });

  it("falls back to raw UUID when resolution fails", async () => {
    const missing = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const ctx = {
      agents: { list: vi.fn().mockResolvedValue([]) },
      projects: { get: vi.fn().mockResolvedValue(null) },
      issues: { get: vi.fn().mockResolvedValue(null) },
    };

    const result = await resolveFounderAlertContext(
      ctx as never,
      "co-1",
      { agentId: missing, projectId: missing },
      undefined,
      {},
    );

    expect(result.agent).toBe(missing);
    expect(result.project).toBe(missing);
  });
});

describe("founder alert dedup", () => {
  it("uses stable dedup keys per alert kind and id", () => {
    expect(founderAlertDedupKey("blocked", "iss-1")).toBe(
      STATE_KEYS.founderAlertDedup("blocked:iss-1"),
    );
    expect(founderAlertDedupKey("run_failed", "iss-1:run-1")).toBe(
      STATE_KEYS.founderAlertDedup("run_failed:iss-1:run-1"),
    );
  });

  it("dedupes repeated blocked alerts for the same issue", async () => {
    const store = new Map<string, unknown>();
    const postCalls: string[] = [];

    const trySend = async (dedupeId: string, text: string) => {
      const dedupeKey = founderAlertDedupKey("blocked", dedupeId);
      const already = store.get(dedupeKey);
      if (already) return;
      postCalls.push(text);
      store.set(dedupeKey, true);
    };

    const text =
      "Ratel Systems . Hürkuş . RAT-68 -- Ilerleyemiyor. Mudahale gerekiyor: Dedupe test";
    await trySend("iss-dedupe", text);
    await trySend("iss-dedupe", text);

    expect(postCalls).toHaveLength(1);
  });
});

vi.mock("../src/slack-api.js", () => ({
  postMessage: vi.fn(),
}));

describe("registerFounderAlerts state dedup", () => {
  it("posts blocked alert once through plugin state", async () => {
    const { postMessage } = await import("../src/slack-api.js");
    const { registerFounderAlerts } = await import("../src/founder-alerts.js");
    vi.mocked(postMessage).mockResolvedValue({ ok: true, ts: "1" });

    const store = new Map<string, unknown>();
    const handlers = new Map<string, (event: unknown) => Promise<void>>();

    const ctx = {
      state: {
        async get({
          stateKey,
        }: {
          scopeKind: string;
          scopeId: string;
          stateKey: string;
        }) {
          return store.get(stateKey) ?? null;
        },
        async set(
          { stateKey }: { scopeKind: string; scopeId: string; stateKey: string },
          value: unknown,
        ) {
          store.set(stateKey, value);
        },
      },
      metrics: { async write() {} },
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void>) {
          handlers.set(eventType, handler);
        },
      },
      agents: { list: vi.fn().mockResolvedValue([]) },
      projects: { get: vi.fn().mockResolvedValue(null) },
      issues: {
        get: vi.fn().mockResolvedValue({
          id: "iss-state",
          identifier: "RAT-68",
          parentId: null,
          projectId: null,
        }),
      },
    };

    registerFounderAlerts(ctx as never, {
      token: "token",
      getConfig: async () =>
        ({
          enableFounderAlerts: true,
          founderAlertsChannelId: "CFOUNDER",
        }) as never,
    });

    const handler = handlers.get("issue.updated")!;
    const event = {
      companyId: "co-1",
      entityId: "iss-state",
      payload: {
        status: "blocked",
        projectName: "Ratel Systems",
        agentName: "Hürkuş",
        blockedReason: "state dedup",
      },
    };

    await handler(event);
    await handler(event);

    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it("skips parent-complete when issue lookup fails (fail-closed)", async () => {
    const { postMessage } = await import("../src/slack-api.js");
    const { registerFounderAlerts } = await import("../src/founder-alerts.js");
    vi.mocked(postMessage).mockClear();
    vi.mocked(postMessage).mockResolvedValue({ ok: true, ts: "1" });

    const handlers = new Map<string, (event: unknown) => Promise<void>>();

    const ctx = {
      state: {
        async get() {
          return null;
        },
        async set() {},
      },
      metrics: { async write() {} },
      events: {
        on(eventType: string, handler: (event: unknown) => Promise<void>) {
          handlers.set(eventType, handler);
        },
      },
      agents: { list: vi.fn().mockResolvedValue([]) },
      projects: { get: vi.fn().mockResolvedValue(null) },
      issues: {
        get: vi.fn().mockRejectedValue(new Error("API unavailable")),
      },
    };

    registerFounderAlerts(ctx as never, {
      token: "token",
      getConfig: async () =>
        ({
          enableFounderAlerts: true,
          founderAlertsChannelId: "CFOUNDER",
        }) as never,
    });

    const handler = handlers.get("issue.updated")!;
    await handler({
      companyId: "co-1",
      entityId: "iss-missing",
      payload: { status: "done", projectName: "Ratel Systems", agentName: "Hürkuş" },
    });

    expect(postMessage).not.toHaveBeenCalled();
  });
});
