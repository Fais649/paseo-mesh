import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const hostStatus = z.object({
  name: z.string(),
  self: z.boolean(),
  state: z.enum(["connected", "connecting", "disconnected", "disabled", "error"]),
  error: z.string().nullable(),
});

export type HostStatus = z.infer<typeof hostStatus>;

export const statusRpc = defineRpc({
  name: "mesh.status",
  input: z.object({}),
  output: z.object({
    hostName: z.string(),
    servicePort: z.number().nullable(),
    hosts: z.array(hostStatus),
  }),
});

export const testPeerRpc = defineRpc({
  name: "mesh.test_peer",
  input: z.object({ url: z.string(), password: z.string().optional() }),
  output: z.object({ ok: z.boolean(), agents: z.number().nullable(), error: z.string().nullable() }),
});

export const pairingUrlRpc = defineRpc({
  name: "mesh.pairing_url",
  input: z.object({}),
  output: z.object({ url: z.string().nullable(), error: z.string().nullable() }),
});
