import type { PluginContext, PluginHealthDiagnostics } from "@paperclipai/plugin-sdk";
import { normalizeSecretRef, redactSecretRefs } from "./secret-ref-validation.js";

export type SlackRuntimeHealth = PluginHealthDiagnostics & {
  message?: string;
  details?: Record<string, unknown>;
};

export const SECRET_RESOLUTION_ISSUE_URL = "https://github.com/mvanhorn/paperclip-plugin-slack/issues/31";

/**
 * Resolve the Slack bot token secret for a company-scoped configuration
 * delivery.
 *
 * Called from `onConfigChanged`, never from `setup()` — an unscoped
 * `ctx.secrets.resolve()` throws "company context is required" on governed
 * hosts (paperclipai/paperclip#9557), so this must always run with the
 * companyId the delivery was attributed to.
 */
export async function resolveStartupSlackToken(
  ctx: PluginContext,
  tokenRef: unknown,
  setHealth: (health: SlackRuntimeHealth) => void,
  companyId?: string,
): Promise<string | undefined> {
  try {
    const normalizedRef = normalizeSecretRef(tokenRef) ?? tokenRef;
    const token = await ctx.secrets.resolve(normalizedRef as string, {
      companyId,
      configPath: "slackTokenRef",
    });
    setHealth({ status: "ok" });
    return token;
  } catch (err) {
    const error = redactSecretRefs(String(err), tokenRef);
    setHealth({
      status: "degraded",
      message: `Slack bot token secret resolution failed: ${error}`,
      details: {
        issue: "slack-bot-token-resolution-failed",
        reference: SECRET_RESOLUTION_ISSUE_URL,
        error,
      },
    });
    ctx.logger.error("Slack plugin cannot resolve Slack token secret; runtime features are disabled", {
      error,
      reference: SECRET_RESOLUTION_ISSUE_URL,
    });
    return undefined;
  }
}
