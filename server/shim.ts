/**
 * Source of the stdio MCP server that each agent launches. It has no dependencies: it speaks MCP
 * JSON-RPC over stdio and forwards tool calls to the plugin's local HTTP service, adding the
 * calling agent's PASEO_AGENT_ID. The service address and token are re-read from the state file on
 * every request, so the shim survives plugin reloads.
 */
export const SHIM_SOURCE = String.raw`#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const http = require("node:http");
const STATE = process.argv[2];
const AGENT_ID = process.env.PASEO_AGENT_ID || null;
const VERSION = "0.1.0";

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return null; }
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const state = readState();
    if (!state) return reject(new Error("paseo-mesh is not running on this host (no service state file)."));
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: "127.0.0.1", port: state.port, path, method: "POST",
      headers: { "content-type": "application/json", "content-length": data.length, authorization: "Bearer " + state.token },
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(new Error("Bad response from paseo-mesh service (HTTP " + res.statusCode + ")")); }
      });
    });
    req.on("error", (e) => reject(new Error("paseo-mesh service unreachable: " + e.message)));
    req.end(data);
  });
}

function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === "initialize") {
      return send({ jsonrpc: "2.0", id, result: {
        protocolVersion: (params && params.protocolVersion) || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "paseo-mesh", version: VERSION },
        instructions: "paseo-mesh connects you to other agents on this and other Paseo hosts. Use whoami for your address, list_agents to find agents, send_message to talk to them, create_agent to start one on any host.",
      }});
    }
    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
    if (method === "tools/list") {
      const res = await post("/tools", {});
      return send({ jsonrpc: "2.0", id, result: { tools: res.tools || [] } });
    }
    if (method === "tools/call") {
      const res = await post("/call", { agentId: AGENT_ID, name: params.name, arguments: params.arguments || {} });
      const text = res.error ? "Error: " + res.error : JSON.stringify(res.result, null, 2);
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: !!res.error } });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
  } catch (e) {
    if (method === "tools/call") {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Error: " + e.message }], isError: true } });
    }
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (Array.isArray(msg)) msg.forEach(handle); else handle(msg);
  }
});
process.stdin.on("end", () => process.exit(0));
`;
