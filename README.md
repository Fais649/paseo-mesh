# paseo-mesh

A [Paseo](https://paseo.sh) plugin that lets agents talk to each other over MCP, on the same host or across hosts.

Every new agent gets a `mesh` MCP server. With it, an agent can find other agents on any connected host, message them, wait for their answers, and start new agents with a task. Messages arrive in the target agent's conversation tagged with the sender's address, so the target can reply.

```text
mac/817cfd3d ──send_message(expectReply)──▶ lab/2b41…   (via Paseo relay, E2EE)
            ◀────────── final response ─────────────┘
```

## Tools

| Tool | What it does |
| --- | --- |
| `whoami` | Your address (`host/agentId`) and the hosts you can reach |
| `list_hosts` | This host and its peers, with connection state |
| `list_agents` | Agents on a host (or `"*"` for all hosts): address, title, status, provider, cwd |
| `list_workspaces` | Workspace directories on a host, for choosing a `cwd` |
| `get_agent` | One agent's status and latest assistant message |
| `read_agent` | An agent's recent timeline (messages and tool calls) |
| `send_message` | Message an agent. If the agent is busy, the message waits until its turn ends. Set `expectReply` to get its final response back |
| `wait_for_reply` | Keep waiting on a reply that went `pending` |
| `wait_for_agent` | Wait for an agent's turn to finish |
| `create_agent` | Start an agent on any host with a task, optionally waiting for its first answer |
| `archive_agent` | Stop and hide an agent |

You can refer to an agent by `host/agentId`, by a bare ID on this host, by a unique ID prefix, or by its exact title.

### Communication patterns

- **Ask and wait:** `send_message({to, message, expectReply: true})` returns the target's final response from that turn. If the wait runs past `timeoutSec` (default 120 s), the call returns `status: "pending"`. Call `wait_for_reply(messageId)` later to keep waiting.
- **Fire and forget, with a reply later:** without `expectReply`, the call returns as soon as the message is delivered or queued. The target replies by calling `send_message` with your address, and the reply shows up in your conversation as a new prompt.
- **Delegate:** `create_agent({host: "lab", cwd, prompt, expectReply})` starts a worker on another machine. The worker knows your address, so it can report back.
- The plugin refuses an `expectReply` message to an agent that is already waiting on a reply from you, because both agents would wait forever.

## Install

Install the plugin on each host whose agents should use the mesh:

```bash
paseo plugin install github:Fais649/paseo-mesh
```

Plugins must be enabled on that daemon (**Settings → Plugins → Enable plugins**). For local development, run `npm install` and then `paseo plugin install /absolute/path/to/paseo-mesh`.

## Connect hosts

1. On host B, open **Settings → Plugins → paseo-mesh → Mesh** and press **Show** next to **Pairing link for this host**. You can also run `paseo daemon pair --json` on that host.
2. On host A, open the same screen and fill in **Add peer**: a name such as `lab`, plus B's pairing link. Press **Test**, then **Add**.
3. Do the same in the other direction if B's agents should be able to reach A.

A peer can be:

- a pairing link (`https://app.paseo.sh/#offer=…`), which connects through the Paseo relay with end-to-end encryption, or
- a direct daemon address such as `ws://lab.tailnet.ts.net:6767/ws` or `host:port`, with an optional password.

Use **Host name** to choose how other hosts and agents refer to this host. If you leave it empty, the machine's hostname is used.

## How it works

- The plugin's server runs a local HTTP service. It listens only on `127.0.0.1` and requires a per-start token.
- A `before("agent.create")` hook adds a stdio MCP server named `mesh` to every new agent. That server is a dependency-free shim written to `~/.paseo/paseo-mesh/mesh-mcp.cjs`. It forwards tool calls to the local service and includes the caller's `PASEO_AGENT_ID`, so recipients know who sent each message.
- The plugin talks to this daemon and to each peer through `@getpaseo/client`. Pairing links use the relay with end-to-end encryption, the same way the Paseo app connects.

## Security

A pairing link gives full control of that daemon. Anyone holding it, including agents on a host where it's saved as a peer, can start agents, read timelines and send prompts there. Only add peers you would trust to run code on your machine.

- Peer links and passwords are stored in this host's plugin settings as plain JSON. They are not kept in a credential vault.
- Turn off **Allow agents to create and archive agents** to stop agents on this host from starting or archiving agents.
- Turn off **Give new agents the mesh tools** to stop adding the MCP server to new agents.

## Limitations

- Only agents created after the plugin is installed get the tools.
- The sender's identity comes from `PASEO_AGENT_ID` in the MCP process's environment. Claude passes it through. Providers that strip the environment from MCP servers (Codex by default) can still use every tool, but their messages appear as coming from `unknown-agent`, so recipients can't reply directly.
- Queued messages and pending replies live in memory. Reloading the plugin or restarting the daemon drops them.
- A reply is the target's final response for that turn. Long-running targets can exceed the MCP client's tool timeout. Use a short `timeoutSec` and then `wait_for_reply`.

## Development

```bash
npm install
npm run typecheck
paseo plugin reload paseo-mesh
paseo plugin logs paseo-mesh
```

## License

MIT
