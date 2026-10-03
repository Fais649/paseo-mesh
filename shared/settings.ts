import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const peerSchema = z.object({
  name: z.string().min(1),
  // A pairing link (https://app.paseo.sh/#offer=...) or a direct daemon address (ws://host:6767/ws).
  url: z.string().min(1),
  password: z.string().optional(),
  enabled: z.boolean().default(true),
});

export type Peer = z.infer<typeof peerSchema>;

export const meshSettings = defineSettings({
  id: "mesh",
  scope: "host",
  version: 1,
  schema: z.object({
    // How other hosts and agents refer to this host. Empty means the machine's hostname.
    hostName: z.string().default(""),
    peers: z.array(peerSchema).default([]),
    // Add the mesh MCP server to every newly created agent.
    injectIntoAgents: z.boolean().default(true),
    // Allow agents to create and archive agents (locally and on peers).
    allowAgentManagement: z.boolean().default(true),
    // Override the local daemon WebSocket URL. Empty means read daemon.listen from config.json.
    localUrl: z.string().default(""),
    localPassword: z.string().default(""),
  }),
});

export type MeshSettings = z.infer<typeof meshSettings.schema>;
