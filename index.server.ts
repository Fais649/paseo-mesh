import type { PluginServerContext } from "@getpaseo/plugin/server";
import { HostRegistry } from "./server/hosts";
import { pairingUrl, testPeer } from "./server/peers";
import { type ServiceInfo, startService } from "./server/service";
import { MeshTools } from "./server/tools";
import { pairingUrlRpc, statusRpc, testPeerRpc } from "./shared/rpc";
import { meshSettings } from "./shared/settings";

const MCP_NAME = "mesh";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(meshSettings);
  const hosts = new HostRegistry(meshSettings.schema.parse({}));
  const tools = new MeshTools(hosts);

  let stopService: (() => Promise<void>) | null = null;
  const started: Promise<ServiceInfo> = (async () => {
    const current = await settings.read();
    if (current.status === "ready") hosts.update(current.values);
    else {
      console.error("paseo-mesh settings are invalid; using defaults:", current.error);
      hosts.warm();
    }
    const { info, stop } = await startService(tools);
    stopService = stop;
    console.log(`paseo-mesh service on 127.0.0.1:${info.port} as host "${hosts.selfName}"`);
    return info;
  })();
  started.catch((err) => console.error("paseo-mesh failed to start:", err));

  const unsubscribe = settings.subscribe((next) => {
    if (next.status === "ready") hosts.update(next.values);
  });

  server.before("agent.create", async ({ request }) => {
    if (!hosts.config.injectIntoAgents) return undefined;
    const info = await started;
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [MCP_NAME]: {
            type: "stdio",
            command: process.execPath,
            args: [info.shimPath, info.statePath],
            // process.execPath can be Electron's helper binary; this makes it behave as plain Node.
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
        },
      },
    };
  });

  server.handle(statusRpc, async () => {
    const info = await started.catch(() => null);
    return { hostName: hosts.selfName, servicePort: info?.port ?? null, hosts: hosts.status() };
  });
  server.handle(testPeerRpc, ({ url, password }) => testPeer(url, password));
  server.handle(pairingUrlRpc, () => pairingUrl());

  return async () => {
    unsubscribe();
    await stopService?.();
    await hosts.close();
  };
}
