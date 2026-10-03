import { randomUUID } from "node:crypto";
import type { PaseoAgent, PaseoApi } from "@getpaseo/client";
import type { HostRegistry } from "./hosts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CallContext {
  /** PASEO_AGENT_ID of the calling agent, when the provider passed it to the MCP process. */
  agentId: string | null;
}

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const AGENT_REF =
  'Agent address: "<host>/<agentId>", a bare agent ID (this host), a unique ID prefix, or an exact agent title.';

export const TOOLS: ToolDef[] = [
  {
    name: "whoami",
    description:
      "Return your own mesh address (host/agentId) and the hosts you can reach. Share your address with other agents so they can message you.",
    inputSchema: obj({}),
  },
  {
    name: "list_hosts",
    description: "List Paseo hosts in the mesh (this host plus configured peers) and their connection state.",
    inputSchema: obj({}),
  },
  {
    name: "list_agents",
    description:
      "List agents on a host with their address, title, status (idle/running/...), provider and directory.",
    inputSchema: obj({
      host: str("Host name. Omit for this host. Use \"*\" for every reachable host."),
      query: str("Optional case-insensitive filter on title, directory or ID."),
    }),
  },
  {
    name: "list_workspaces",
    description: "List workspaces (directories) on a host, useful for picking a cwd for create_agent.",
    inputSchema: obj({ host: str("Host name. Omit for this host.") }),
  },
  {
    name: "get_agent",
    description: "Show one agent's status, title, directory and its latest assistant message.",
    inputSchema: obj({ agent: str(AGENT_REF) }, ["agent"]),
  },
  {
    name: "read_agent",
    description: "Read the most recent timeline items (messages, tool calls) of an agent on any host.",
    inputSchema: obj(
      {
        agent: str(AGENT_REF),
        limit: num("How many recent items to return (default 20, max 100)."),
      },
      ["agent"],
    ),
  },
  {
    name: "send_message",
    description: [
      "Send a message to another agent on any host. It arrives in that agent's conversation as a prompt,",
      "tagged with your address so it can reply. If the target is busy, the message is queued and delivered",
      "when its current turn ends.",
      "expectReply=true waits for the target's turn to finish and returns its final response as the reply.",
      "If the wait exceeds timeoutSec you get status \"pending\"; call wait_for_reply with the messageId later.",
      "Without expectReply the call returns immediately; the target may answer later by messaging you back,",
      "which arrives in your conversation as a new prompt.",
    ].join(" "),
    inputSchema: obj(
      {
        to: str(AGENT_REF),
        message: str("The message text. Make it self-contained."),
        expectReply: bool("Wait for the target's response (default false)."),
        timeoutSec: num("Max seconds to wait when expectReply is true (default 120)."),
      },
      ["to", "message"],
    ),
  },
  {
    name: "wait_for_reply",
    description: "Wait for the reply to a message sent with expectReply, or check its status.",
    inputSchema: obj(
      {
        messageId: str("ID returned by send_message or create_agent."),
        timeoutSec: num("Max seconds to wait (default 120; 0 checks without waiting)."),
      },
      ["messageId"],
    ),
  },
  {
    name: "wait_for_agent",
    description: "Wait until an agent finishes its current turn and return its final message.",
    inputSchema: obj(
      { agent: str(AGENT_REF), timeoutSec: num("Max seconds to wait (default 120).") },
      ["agent"],
    ),
  },
  {
    name: "create_agent",
    description: [
      "Start a new agent on any host with a task. The prompt is tagged with your address so the new agent",
      "can report back to you with send_message. expectReply=true waits for its first turn and returns the",
      "final response (status \"pending\" plus messageId if it takes longer than timeoutSec).",
    ].join(" "),
    inputSchema: obj(
      {
        host: str("Host name. Omit for this host."),
        cwd: str("Absolute working directory on that host."),
        prompt: str("Self-contained task for the new agent."),
        title: str("Optional agent title."),
        provider: str('Provider/model, e.g. "claude" or "codex/gpt-5.5". Defaults to your own provider.'),
        modeId: str('Optional provider mode, e.g. "bypassPermissions" or "acceptEdits".'),
        expectReply: bool("Wait for the first turn's final response (default false)."),
        timeoutSec: num("Max seconds to wait when expectReply is true (default 120)."),
      },
      ["cwd", "prompt"],
    ),
  },
  {
    name: "archive_agent",
    description: "Archive (stop and hide) an agent on any host.",
    inputSchema: obj({ agent: str(AGENT_REF) }, ["agent"]),
  },
];

interface Resolved {
  host: string;
  api: PaseoApi;
  agent: PaseoAgent;
  address: string;
}

interface MessageRecord {
  id: string;
  from: string;
  to: string;
  expectReply: boolean;
  status: "queued" | "delivered" | "replied" | "failed";
  reply: string | null;
  error: string | null;
  done: Promise<void>;
}

const sleep = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
const DEFAULT_WAIT_SEC = 120;
const DELIVERY_TIMEOUT_MS = 60 * 60_000;

export class MeshTools {
  private messages = new Map<string, MessageRecord>();
  /** Per-target delivery chain so queued messages arrive in order. */
  private queues = new Map<string, Promise<unknown>>();
  /** Open expectReply waits as "from->to", to refuse obvious deadlocks. */
  private waits = new Set<string>();

  constructor(private hosts: HostRegistry) {}

  async call(name: string, args: Record<string, unknown>, ctx: CallContext): Promise<unknown> {
    switch (name) {
      case "whoami":
        return this.whoami(ctx);
      case "list_hosts":
        return this.listHosts();
      case "list_agents":
        return this.listAgents(opt(args.host), opt(args.query));
      case "list_workspaces":
        return this.listWorkspaces(opt(args.host));
      case "get_agent":
        return this.getAgent(req(args.agent, "agent"));
      case "read_agent":
        return this.readAgent(req(args.agent, "agent"), num0(args.limit) ?? 20);
      case "send_message":
        return this.sendMessage(ctx, {
          to: req(args.to, "to"),
          message: req(args.message, "message"),
          expectReply: args.expectReply === true,
          timeoutSec: num0(args.timeoutSec) ?? DEFAULT_WAIT_SEC,
        });
      case "wait_for_reply":
        return this.waitForReply(req(args.messageId, "messageId"), num0(args.timeoutSec) ?? DEFAULT_WAIT_SEC);
      case "wait_for_agent":
        return this.waitForAgent(req(args.agent, "agent"), num0(args.timeoutSec) ?? DEFAULT_WAIT_SEC);
      case "create_agent":
        return this.createAgent(ctx, args);
      case "archive_agent":
        return this.archiveAgent(req(args.agent, "agent"));
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private selfAddress(ctx: CallContext): string {
    return `${this.hosts.selfName}/${ctx.agentId ?? "unknown-agent"}`;
  }

  private async whoami(ctx: CallContext) {
    let agent: PaseoAgent | null = null;
    if (ctx.agentId) {
      agent = await this.findAgent(await this.hosts.get(), ctx.agentId).catch(() => null);
    }
    return {
      address: ctx.agentId ? this.selfAddress(ctx) : null,
      host: this.hosts.selfName,
      agentId: ctx.agentId,
      title: agent?.title ?? null,
      cwd: agent?.cwd ?? null,
      hosts: this.hosts.hostNames(),
      note: ctx.agentId
        ? undefined
        : "Your agent ID is unknown (the provider did not pass PASEO_AGENT_ID to MCP servers). Others cannot address replies to you; include your title in messages instead.",
    };
  }

  private listHosts() {
    return { hosts: this.hosts.status() };
  }

  private async agentsOn(host: string): Promise<PaseoAgent[]> {
    const api = await this.hosts.get(host);
    const result = await api.agents.list({});
    return result.entries.map((e) => e.agent as PaseoAgent);
  }

  private summarize(host: string, a: PaseoAgent) {
    return {
      address: `${host}/${a.id}`,
      title: a.title ?? null,
      status: a.status,
      provider: a.model ? `${a.provider}/${a.model}` : a.provider,
      cwd: a.cwd,
      needsAttention: a.requiresAttention ?? false,
      pendingPermissions: a.pendingPermissions?.length ?? 0,
    };
  }

  private async listAgents(host: string | undefined, query: string | undefined) {
    const hosts = host === "*" ? this.hosts.hostNames() : [this.hosts.canonical(host)];
    const out: unknown[] = [];
    const errors: Record<string, string> = {};
    await Promise.all(
      hosts.map(async (h) => {
        try {
          for (const a of await this.agentsOn(h)) {
            const s = this.summarize(h, a);
            const hay = `${s.title ?? ""} ${s.cwd} ${s.address}`.toLowerCase();
            if (!query || hay.includes(query.toLowerCase())) out.push(s);
          }
        } catch (err) {
          errors[h] = errorText(err);
        }
      }),
    );
    return Object.keys(errors).length ? { agents: out, errors } : { agents: out };
  }

  private async listWorkspaces(host: string | undefined) {
    const api = await this.hosts.get(host);
    const result = await api.workspaces.list({});
    return {
      host: this.hosts.canonical(host),
      workspaces: result.entries.map((w) => ({ id: w.id, name: w.name, directory: w.workspaceDirectory })),
    };
  }

  private async findAgent(api: PaseoApi, ref: string): Promise<PaseoAgent> {
    const result = await api.agents.list({});
    const agents = result.entries.map((e) => e.agent as PaseoAgent);
    const exact = agents.find((a) => a.id === ref);
    if (exact) return exact;
    const byPrefix = agents.filter((a) => a.id.startsWith(ref));
    if (byPrefix.length === 1) return byPrefix[0]!;
    const byTitle = agents.filter((a) => (a.title ?? "").toLowerCase() === ref.toLowerCase());
    if (byTitle.length === 1) return byTitle[0]!;
    if (byPrefix.length > 1 || byTitle.length > 1) {
      throw new Error(`"${ref}" matches several agents; use the full ID.`);
    }
    throw new Error(`No agent "${ref}" found.`);
  }

  private async resolve(ref: string): Promise<Resolved> {
    const slash = ref.indexOf("/");
    const hostPart = slash > 0 ? ref.slice(0, slash) : undefined;
    const agentPart = slash > 0 ? ref.slice(slash + 1) : ref;
    const host = this.hosts.canonical(hostPart);
    const api = await this.hosts.get(host);
    const agent = await this.findAgent(api, agentPart);
    return { host, api, agent, address: `${host}/${agent.id}` };
  }

  private async lastAssistantText(api: PaseoApi, agentId: string): Promise<string | null> {
    const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30 });
    for (let i = page.entries.length - 1; i >= 0; i--) {
      const item = page.entries[i]!.item as { type: string; text?: string };
      if (item.type === "assistant_message" && item.text) return item.text;
    }
    return null;
  }

  private async getAgent(ref: string) {
    const r = await this.resolve(ref);
    return {
      ...this.summarize(r.host, r.agent),
      lastError: r.agent.lastError ?? null,
      lastMessage: await this.lastAssistantText(r.api, r.agent.id).catch(() => null),
    };
  }

  private async readAgent(ref: string, limit: number) {
    const r = await this.resolve(ref);
    const page = await r.api.agents
      .ref(r.agent.id)
      .timeline.refetch({ direction: "tail", limit: Math.min(Math.max(limit, 1), 100) });
    return {
      address: r.address,
      status: r.agent.status,
      items: page.entries.map((e) => formatItem(e.item as Record<string, unknown>, e.timestamp)),
    };
  }

  private envelope(from: string, fromTitle: string | null, messageId: string, body: string, expectReply: boolean) {
    const who = fromTitle ? `${from} ("${fromTitle}")` : from;
    const how = expectReply
      ? "The sender is waiting for you: your final response in this turn is returned to them as the reply."
      : from.endsWith("/unknown-agent")
        ? "The sender's agent ID is unknown, so you cannot reply to them directly."
        : `To reply, use the mesh send_message tool with to="${from}".`;
    return `[paseo-mesh message ${messageId} from ${who}]\n\n${body}\n\n---\n${how}`;
  }

  private async senderTitle(ctx: CallContext): Promise<string | null> {
    if (!ctx.agentId) return null;
    try {
      return (await this.findAgent(await this.hosts.get(), ctx.agentId)).title ?? null;
    } catch {
      return null;
    }
  }

  /** Wait until the agent is idle, then send. Resolves with the reply text when expectReply. */
  private deliver(target: Resolved, text: string, expectReply: boolean): Promise<string | null> {
    const key = target.address;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(async () => {
        const handle = target.api.agents.ref(target.agent.id);
        await handle.refresh();
        if (handle.status === "running" || handle.status === "initializing") {
          await handle.waitForFinish(DELIVERY_TIMEOUT_MS);
        }
        if (!expectReply) {
          await handle.send(text);
          return null;
        }
        const result = await handle.run(text, { timeoutMs: DELIVERY_TIMEOUT_MS });
        if (result.error) throw new Error(String(result.error));
        return result.lastMessage ?? "";
      });
    this.queues.set(key, run);
    void run.finally(() => {
      if (this.queues.get(key) === run) this.queues.delete(key);
    });
    return run;
  }

  private track(
    id: string,
    from: string,
    to: string,
    expectReply: boolean,
    work: Promise<string | null>,
    queued: boolean,
  ) {
    const record: MessageRecord = {
      id,
      from,
      to,
      expectReply,
      status: queued ? "queued" : "delivered",
      reply: null,
      error: null,
      done: Promise.resolve(),
    };
    const waitKey = `${from}->${to}`;
    if (expectReply) this.waits.add(waitKey);
    record.done = work.then(
      (reply) => {
        record.status = expectReply ? "replied" : "delivered";
        record.reply = reply;
      },
      (err) => {
        record.status = "failed";
        record.error = errorText(err);
      },
    );
    void record.done.finally(() => this.waits.delete(waitKey));
    this.messages.set(id, record);
    return record;
  }

  private async report(record: MessageRecord, timeoutSec: number) {
    if (timeoutSec > 0 && (record.status === "queued" || (record.expectReply && record.status === "delivered"))) {
      await Promise.race([record.done, sleep(timeoutSec * 1000)]);
    }
    const pending = record.status === "queued" || (record.expectReply && record.status === "delivered");
    return {
      messageId: record.id,
      to: record.to,
      status: pending ? (record.status === "queued" ? "queued" : "pending") : record.status,
      reply: record.reply ?? undefined,
      error: record.error ?? undefined,
      hint: pending && record.expectReply ? `Call wait_for_reply with messageId "${record.id}" to keep waiting.` : undefined,
    };
  }

  private async sendMessage(
    ctx: CallContext,
    input: { to: string; message: string; expectReply: boolean; timeoutSec: number },
  ) {
    const target = await this.resolve(input.to);
    const from = this.selfAddress(ctx);
    if (ctx.agentId && target.address === from) throw new Error("You cannot message yourself.");
    if (input.expectReply && this.waits.has(`${target.address}->${from}`)) {
      throw new Error(
        `${target.address} is already waiting for your reply. Answer it in your final response instead of waiting on it (deadlock).`,
      );
    }
    const busy = target.agent.status === "running" || target.agent.status === "initializing";
    const id = newMessageId();
    const text = this.envelope(from, await this.senderTitle(ctx), id, input.message, input.expectReply);
    const work = this.deliver(target, text, input.expectReply);
    const record = this.track(id, from, target.address, input.expectReply, work, busy);
    // Without expectReply, report as soon as the prompt is accepted (or queued behind a busy turn).
    return this.report(record, input.expectReply ? input.timeoutSec : busy ? 0 : 15);
  }

  private async waitForReply(messageId: string, timeoutSec: number) {
    const record = this.messages.get(messageId);
    if (!record) throw new Error(`Unknown messageId "${messageId}" (message IDs are lost when the plugin restarts).`);
    return this.report(record, timeoutSec);
  }

  private async waitForAgent(ref: string, timeoutSec: number) {
    const r = await this.resolve(ref);
    const handle = r.api.agents.ref(r.agent.id);
    if (r.agent.status === "running" || r.agent.status === "initializing") {
      const outcome = await Promise.race([handle.waitForFinish(timeoutSec * 1000), sleep(timeoutSec * 1000)]);
      if (outcome === "timeout") return { address: r.address, status: "running", timedOut: true };
    }
    await handle.refresh();
    return {
      address: r.address,
      status: handle.status,
      lastMessage: await this.lastAssistantText(r.api, r.agent.id).catch(() => null),
    };
  }

  /** Resolve "provider" or "provider/model" to a full selection valid on the target host. */
  private async providerSelection(api: PaseoApi, cwd: string, requested: string | undefined, ctx: CallContext) {
    let provider = requested;
    if (!provider && ctx.agentId) {
      const self = await this.findAgent(await this.hosts.get(), ctx.agentId).catch(() => null);
      if (self) provider = self.model ? `${self.provider}/${self.model}` : self.provider;
    }
    provider ??= "claude";
    if (provider.includes("/")) return provider;
    const models = (await api.providers.listModels(provider, { cwd })).models ?? [];
    const model = models.find((m) => m.isDefault) ?? models[0];
    if (!model) throw new Error(`Provider "${provider}" has no models on that host.`);
    return `${provider}/${model.id}`;
  }

  private async createAgent(ctx: CallContext, args: Record<string, unknown>) {
    if (!this.hosts.config.allowAgentManagement) {
      throw new Error("Agent management is disabled in paseo-mesh settings on this host.");
    }
    const host = this.hosts.canonical(opt(args.host));
    const api = await this.hosts.get(host);
    const from = this.selfAddress(ctx);
    const expectReply = args.expectReply === true;
    const timeoutSec = num0(args.timeoutSec) ?? DEFAULT_WAIT_SEC;
    const id = newMessageId();
    const prompt = this.envelope(from, await this.senderTitle(ctx), id, req(args.prompt, "prompt"), expectReply)
      .replace("[paseo-mesh message", "[paseo-mesh task");
    const cwd = req(args.cwd, "cwd");
    const handle = await api.agents.create({
      config: {
        provider: await this.providerSelection(api, cwd, opt(args.provider), ctx),
        ...(opt(args.modeId) ? { modeId: opt(args.modeId) } : {}),
      },
      cwd,
      title: opt(args.title),
      prompt,
    });
    const address = `${host}/${handle.id}`;
    const work = expectReply
      ? handle.waitForFinish(DELIVERY_TIMEOUT_MS).then((r) => {
          if (r.error) throw new Error(String(r.error));
          return r.lastMessage ?? "";
        })
      : Promise.resolve(null);
    const record = this.track(id, from, address, expectReply, work, false);
    const report = await this.report(record, expectReply ? timeoutSec : 0);
    return { address, ...report };
  }

  private async archiveAgent(ref: string) {
    if (!this.hosts.config.allowAgentManagement) {
      throw new Error("Agent management is disabled in paseo-mesh settings on this host.");
    }
    const r = await this.resolve(ref);
    const result = await r.api.agents.ref(r.agent.id).archive();
    return { address: r.address, archivedAt: result.archivedAt };
  }
}

function formatItem(item: Record<string, unknown>, timestamp: string) {
  const type = String(item.type);
  const base = { at: timestamp, type };
  if (typeof item.text === "string") return { ...base, text: clip(item.text, 4000) };
  if (type === "tool_call") {
    const detail = (item.detail ?? {}) as Record<string, unknown>;
    return {
      ...base,
      tool: item.name,
      status: item.status,
      summary: clip(String(detail.command ?? detail.path ?? detail.query ?? ""), 300),
    };
  }
  return base;
}

function newMessageId() {
  return `msg_${randomUUID().slice(0, 8)}`;
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function opt(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function req(v: unknown, name: string): string {
  const s = opt(v);
  if (!s) throw new Error(`Missing required argument "${name}".`);
  return s;
}

function num0(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
