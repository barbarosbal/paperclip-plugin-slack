import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import {
  SECRET_RESOLUTION_ISSUE_URL,
  resolveStartupSlackToken,
  type SlackRuntimeHealth,
} from "../src/runtime-token.js";

const TOKEN_UUID = "12f7ed4a-1234-4d0c-9abc-bd58d44d15e1";

function makeContext(resolve: (...args: unknown[]) => Promise<string>): PluginContext {
  return {
    secrets: { resolve },
    logger: {
      error: vi.fn(),
    },
  } as unknown as PluginContext;
}

describe("resolveStartupSlackToken", () => {
  it("normalizes a bare UUID ref and resolves it under the delivered company scope", async () => {
    const health: SlackRuntimeHealth[] = [];
    const resolve = vi.fn(async () => "xoxb-token");
    const ctx = makeContext(resolve);

    const token = await resolveStartupSlackToken(ctx, TOKEN_UUID, (next) => health.push(next), "company-1");

    expect(token).toBe("xoxb-token");
    expect(health).toEqual([{ status: "ok" }]);
    expect(resolve).toHaveBeenCalledWith(
      { type: "secret_ref", secretId: TOKEN_UUID },
      { companyId: "company-1", configPath: "slackTokenRef" },
    );
  });

  it("degrades health and does not throw when Paperclip secret resolution fails", async () => {
    const health: SlackRuntimeHealth[] = [];
    const ctx = makeContext(async () => {
      throw new Error("boom");
    });

    const token = await resolveStartupSlackToken(ctx, TOKEN_UUID, (next) => health.push(next), "company-1");

    expect(token).toBeUndefined();
    expect(health).toEqual([{
      status: "degraded",
      message: "Slack bot token secret resolution failed: Error: boom",
      details: {
        issue: "slack-bot-token-resolution-failed",
        reference: SECRET_RESOLUTION_ISSUE_URL,
        error: "Error: boom",
      },
    }]);
    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Slack plugin cannot resolve Slack token secret; runtime features are disabled",
      {
        error: "Error: boom",
        reference: SECRET_RESOLUTION_ISSUE_URL,
      },
    );
  });
});
