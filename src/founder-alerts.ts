import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import type { Agent, Issue } from "@paperclipai/shared";
import { STATE_KEYS } from "./constants.js";
import type { SlackConfig } from "./types.js";
import { postMessage } from "./slack-api.js";

type Payload = Record<string, unknown>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

export function normalizeRuntimeError(raw: string): string {
  const text = raw.trim();
  if (!text) return "Bilinmeyen calisma hatasi";

  if (/session limit/i.test(text)) {
    const pm = text.match(/\b(\d{1,2})\s*pm\b/i);
    let hour = 22;
    if (pm) {
      const h = Number(pm[1]);
      hour = h === 12 ? 12 : h + 12;
    }
    const hourLabel = String(hour).padStart(2, "0");
    return `Claude session limiti doldu. ${hourLabel}:00'de sifirlaniyor.`;
  }

  let simplified = text
    .replace(/^Claude run failed:\s*subtype=[^:]+:\s*/i, "")
    .replace(/^Agent run failed:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

  if (simplified.length > 140) {
    simplified = `${simplified.slice(0, 137)}...`;
  }
  return simplified || "Bilinmeyen calisma hatasi";
}

export type FounderAlertContext = {
  project: string;
  agent: string;
  issueIdentifier?: string;
};

export function formatFounderBlockedAlert(
  ctx: FounderAlertContext,
  reason: string,
): string {
  const issuePart = ctx.issueIdentifier ? ` . ${ctx.issueIdentifier}` : "";
  return `${ctx.project} . ${ctx.agent}${issuePart} -- Ilerleyemiyor. Mudahale gerekiyor: ${reason}`;
}

export function formatFounderApprovalAlert(
  ctx: FounderAlertContext,
  subject: string,
): string {
  return `${ctx.project} . ${ctx.agent} -- Onay bekliyor: ${subject}`;
}

export function formatFounderRunErrorAlert(
  ctx: FounderAlertContext,
  normalizedError: string,
): string {
  const issuePart = ctx.issueIdentifier ? ` . ${ctx.issueIdentifier}` : "";
  return `${ctx.project} . ${ctx.agent}${issuePart} -- ${normalizedError}`;
}

export function formatFounderParentCompleteAlert(ctx: FounderAlertContext): string {
  const issuePart = ctx.issueIdentifier ?? "Issue";
  return `${ctx.project} . ${ctx.agent} . ${issuePart} -- Parent tamamlandi. Founder acceptance bekliyor.`;
}

export function founderAlertDedupKey(kind: string, stableId: string): string {
  return STATE_KEYS.founderAlertDedup(`${kind}:${stableId}`);
}

export function shouldEmitParentCompleteAlert(
  issue: Pick<Issue, "parentId"> | null,
  payload?: Payload,
): boolean {
  // Fail-safe: without a loaded issue record we cannot prove this is not a child DONE.
  if (!issue) return false;
  if (issue.parentId) return false;
  if (payload?.parentId != null && String(payload.parentId).trim()) return false;
  return true;
}

type ResolverCache = {
  agents?: Agent[];
  projects?: Map<string, string>;
};

async function loadAgents(
  ctx: PluginContext,
  companyId: string,
  cache: ResolverCache,
): Promise<Agent[]> {
  if (cache.agents) return cache.agents;
  cache.agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
  return cache.agents;
}

async function resolveAgentName(
  ctx: PluginContext,
  companyId: string,
  raw: string | undefined,
  cache: ResolverCache,
): Promise<string> {
  if (!raw) return "Ajan";
  if (!looksLikeUuid(raw)) return raw;
  const agents = await loadAgents(ctx, companyId, cache);
  const hit = agents.find((a) => a.id === raw);
  return hit?.name ?? raw;
}

async function resolveProjectName(
  ctx: PluginContext,
  companyId: string,
  payload: Payload,
  issue: Issue | null,
  cache: ResolverCache,
): Promise<string> {
  const fromPayload = payload.projectName != null ? String(payload.projectName) : "";
  if (fromPayload && !looksLikeUuid(fromPayload)) return fromPayload;

  const projectId =
    issue?.projectId ??
    (payload.projectId != null ? String(payload.projectId) : "");
  if (!projectId) return "Paperclip";

  if (!cache.projects) cache.projects = new Map();
  const cached = cache.projects.get(projectId);
  if (cached) return cached;

  try {
    const project = await ctx.projects.get(projectId, companyId);
    if (project?.name) {
      cache.projects.set(projectId, project.name);
      return project.name;
    }
  } catch {
    // fall through
  }

  if (!looksLikeUuid(projectId)) return projectId;
  return projectId;
}

async function resolveIssueIdentifier(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  payload: Payload,
): Promise<{ identifier?: string; issue: Issue | null }> {
  const fromPayload = payload.identifier != null ? String(payload.identifier) : "";
  if (fromPayload && !looksLikeUuid(fromPayload)) {
    return { identifier: fromPayload, issue: null };
  }

  if (!issueId) return { issue: null };
  try {
    const issue = await ctx.issues.get(issueId, companyId);
    if (!issue) return { issue: null };
    return { identifier: issue.identifier ?? undefined, issue };
  } catch {
    return { issue: null };
  }
}

export async function resolveFounderAlertContext(
  ctx: PluginContext,
  companyId: string,
  payload: Payload,
  issueId: string | undefined,
  cache: ResolverCache,
): Promise<FounderAlertContext & { issue: Issue | null }> {
  const agentRaw =
    payload.agentName != null
      ? String(payload.agentName)
      : payload.assigneeAgentId != null
        ? String(payload.assigneeAgentId)
        : payload.agentId != null
          ? String(payload.agentId)
          : payload.executionAgentNameKey != null
            ? String(payload.executionAgentNameKey)
            : undefined;

  const { identifier, issue } = issueId
    ? await resolveIssueIdentifier(ctx, companyId, issueId, payload)
    : { identifier: undefined, issue: null as Issue | null };

  const enrichedIssue =
    issue ??
    (issueId
      ? await ctx.issues.get(issueId, companyId).catch(() => null)
      : null);

  const agentFromIssue = enrichedIssue?.executionAgentNameKey
    ? enrichedIssue.executionAgentNameKey
    : enrichedIssue?.assigneeAgentId ?? undefined;

  const project = await resolveProjectName(
    ctx,
    companyId,
    payload,
    enrichedIssue,
    cache,
  );
  const agent = await resolveAgentName(
    ctx,
    companyId,
    agentRaw ?? agentFromIssue,
    cache,
  );

  return { project, agent, issueIdentifier: identifier, issue: enrichedIssue };
}

function shortReason(payload: Payload, fallback: string): string {
  const candidates = [
    payload.blockedReason,
    payload.reason,
    payload.monitorNotes,
    payload.title,
  ];
  for (const c of candidates) {
    if (c == null) continue;
    const s = String(c).trim();
    if (s) return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  }
  return fallback;
}

export type FounderAlertsDeps = {
  getConfig: () => Promise<SlackConfig>;
  token: string;
};

export function registerFounderAlerts(ctx: PluginContext, deps: FounderAlertsDeps): void {
  const cache: ResolverCache = {};

  const sendFounderAlert = async (
    event: PluginEvent,
    kind: string,
    dedupeId: string,
    text: string,
  ): Promise<void> => {
    const cfg = await deps.getConfig();
    if (!cfg.enableFounderAlerts) return;
    const channelId = cfg.founderAlertsChannelId?.trim();
    if (!channelId) return;

    const dedupeKey = founderAlertDedupKey(kind, dedupeId);
    const already = await ctx.state.get({
      scopeKind: "company",
      scopeId: event.companyId,
      stateKey: dedupeKey,
    });
    if (already) return;

    const result = await postMessage(ctx, deps.token, channelId, { text });
    if (!result.ok) return;

    await ctx.state.set(
      { scopeKind: "company", scopeId: event.companyId, stateKey: dedupeKey },
      true,
    );
    await ctx.metrics.write("slack.founder_alerts.sent", 1, { kind });
  };

  ctx.events.on("issue.updated", async (event: PluginEvent) => {
    const payload = event.payload as Payload;
    const status = payload.status != null ? String(payload.status) : "";
    const issueId = event.entityId ?? String(payload.issueId ?? "");

    if (status === "blocked" && issueId) {
      const alertCtx = await resolveFounderAlertContext(
        ctx,
        event.companyId,
        payload,
        issueId,
        cache,
      );
      const reason = shortReason(payload, "Sebep belirtilmedi");
      const text = formatFounderBlockedAlert(alertCtx, reason);
      await sendFounderAlert(event, "blocked", issueId, text);
      return;
    }

    if (status === "done" && issueId) {
      const alertCtx = await resolveFounderAlertContext(
        ctx,
        event.companyId,
        payload,
        issueId,
        cache,
      );
      if (!shouldEmitParentCompleteAlert(alertCtx.issue, payload)) {
        return;
      }
      const text = formatFounderParentCompleteAlert(alertCtx);
      await sendFounderAlert(event, "parent_complete", issueId, text);
    }
  });

  ctx.events.on("approval.created", async (event: PluginEvent) => {
    const payload = event.payload as Payload;
    const approvalId = String(payload.approvalId ?? event.entityId ?? "");
    const issueIds = Array.isArray(payload.issueIds) ? payload.issueIds : [];
    const issueId = issueIds[0] != null ? String(issueIds[0]) : undefined;

    const alertCtx = await resolveFounderAlertContext(
      ctx,
      event.companyId,
      payload,
      issueId,
      cache,
    );
    const subject =
      payload.title != null
        ? String(payload.title)
        : payload.description != null
          ? String(payload.description).slice(0, 120)
          : "Onay";
    const text = formatFounderApprovalAlert(alertCtx, subject);
    await sendFounderAlert(event, "approval", approvalId || subject, text);
  });

  ctx.events.on("agent.run.failed", async (event: PluginEvent) => {
    const payload = event.payload as Payload;
    const runId = event.entityId ?? String(payload.runId ?? "");
    const issueId =
      payload.issueId != null
        ? String(payload.issueId)
        : payload.taskId != null
          ? String(payload.taskId)
          : undefined;

    const alertCtx = await resolveFounderAlertContext(
      ctx,
      event.companyId,
      payload,
      issueId,
      cache,
    );
    const rawError = String(payload.error ?? payload.message ?? "Unknown error");
    const normalized = normalizeRuntimeError(rawError);
    const text = formatFounderRunErrorAlert(alertCtx, normalized);
    const dedupeId = issueId ? `${issueId}:${runId}` : runId || normalized;
    await sendFounderAlert(event, "run_failed", dedupeId, text);
  });
}
