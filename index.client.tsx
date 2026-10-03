import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MeshSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "mesh",
    title: "Mesh",
    icon: "Network",
    Component: MeshSettingsScreen,
  });
  client.addCommandCenterItem({
    id: "open-mesh-settings",
    title: "Paseo mesh: manage peers",
    icon: "Network",
    context: "global",
    onSelect({ openSettings }) {
      openSettings("mesh");
    },
  });
  return () => {};
}
