import { describe, it, expect, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  BUILTIN_WATCH_TEMPLATES,
  registerWatch,
  removeWatch,
  listWatches,
} from "../src/proactive-suggestions.js";
import { isMediaFile, isAudioFile } from "../src/media-pipeline.js";

function stateCtx(): PluginContext {
  const store = new Map<string, unknown>();
  const key = (k: any) => `${k.scopeKind}:${k.scopeId ?? ""}:${k.stateKey}`;
  return {
    state: {
      get: vi.fn(async (k: any) => store.get(key(k)) ?? null),
      set: vi.fn(async (k: any, v: unknown) => { store.set(key(k), v); }),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as PluginContext;
}

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";

describe("watch registry tenancy (F3)", () => {
  it("does not let one company delete another company's watch by id", async () => {
    const ctx = stateCtx();
    const watchA = await registerWatch(ctx, COMPANY_A, {
      companyId: COMPANY_A, channelId: "C1", threadTs: "", eventPattern: "issue.created",
      agentId: "agent", prompt: "p", createdBy: "tool",
    });

    // Company B tries to remove company A's watch by its id.
    const removed = await removeWatch(ctx, watchA.id, COMPANY_B);

    expect(removed).toBe(false);
    expect(await listWatches(ctx, COMPANY_A)).toHaveLength(1);
  });

  it("lets the owning company delete its own watch", async () => {
    const ctx = stateCtx();
    const watchA = await registerWatch(ctx, COMPANY_A, {
      companyId: COMPANY_A, channelId: "C1", threadTs: "", eventPattern: "issue.created",
      agentId: "agent", prompt: "p", createdBy: "tool",
    });

    const removed = await removeWatch(ctx, watchA.id, COMPANY_A);

    expect(removed).toBe(true);
    expect(await listWatches(ctx, COMPANY_A)).toHaveLength(0);
  });
});

describe("BUILTIN_WATCH_TEMPLATES", () => {
  it("has 5 built-in templates", () => {
    expect(BUILTIN_WATCH_TEMPLATES.length).toBe(5);
  });

  it("each template has required fields", () => {
    for (const t of BUILTIN_WATCH_TEMPLATES) {
      expect(t.name).toBeTruthy();
      expect(t.eventPattern).toBeTruthy();
      expect(t.prompt).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });

  it("includes sales-related templates", () => {
    const names = BUILTIN_WATCH_TEMPLATES.map((t) => t.name);
    expect(names).toContain("new-lead-follow-up");
    expect(names).toContain("deal-stalled");
  });

  it("includes ops templates", () => {
    const names = BUILTIN_WATCH_TEMPLATES.map((t) => t.name);
    expect(names).toContain("agent-error-diagnosis");
    expect(names).toContain("budget-warning");
  });
});

describe("media type detection", () => {
  it("detects audio files", () => {
    expect(isMediaFile("audio/mpeg")).toBe(true);
    expect(isMediaFile("audio/wav")).toBe(true);
    expect(isMediaFile("audio/ogg")).toBe(true);
    expect(isAudioFile("audio/mpeg")).toBe(true);
  });

  it("detects video files", () => {
    expect(isMediaFile("video/mp4")).toBe(true);
    expect(isMediaFile("video/webm")).toBe(true);
  });

  it("rejects non-media files", () => {
    expect(isMediaFile("text/plain")).toBe(false);
    expect(isMediaFile("application/json")).toBe(false);
    expect(isMediaFile("image/png")).toBe(false);
  });

  it("distinguishes audio from video", () => {
    expect(isAudioFile("audio/mpeg")).toBe(true);
    expect(isAudioFile("video/mp4")).toBe(false);
  });
});
