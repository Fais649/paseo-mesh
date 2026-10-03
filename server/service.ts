import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { paseoHome } from "./hosts";
import { SHIM_SOURCE } from "./shim";
import { errorText, type MeshTools, TOOLS } from "./tools";

export interface ServiceInfo {
  port: number;
  shimPath: string;
  statePath: string;
}

export function stateDir(): string {
  return join(paseoHome(), "paseo-mesh");
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Local HTTP endpoint for the MCP shims, bound to loopback and guarded by a per-start token. */
export async function startService(tools: MeshTools): Promise<{ info: ServiceInfo; stop: () => Promise<void> }> {
  const dir = stateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const shimPath = join(dir, "mesh-mcp.cjs");
  const statePath = join(dir, "service.json");
  writeFileSync(shimPath, SHIM_SOURCE, { mode: 0o755 });

  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);

  const server: Server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return reply(401, { error: "unauthorized" });
    }
    if (req.method !== "POST") return reply(405, { error: "method not allowed" });
    try {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (req.url === "/tools") return reply(200, { tools: TOOLS });
      if (req.url === "/call") {
        const agentId = typeof body.agentId === "string" ? body.agentId : null;
        try {
          const result = await tools.call(String(body.name), body.arguments ?? {}, { agentId });
          return reply(200, { result });
        } catch (err) {
          return reply(200, { error: errorText(err) });
        }
      }
      return reply(404, { error: "not found" });
    } catch (err) {
      return reply(400, { error: errorText(err) });
    }
  });
  // Tool calls can wait for replies for a long time.
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  writeFileSync(statePath, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  chmodSync(statePath, 0o600);

  return {
    info: { port, shimPath, statePath },
    stop: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      rmSync(statePath, { force: true });
    },
  };
}
