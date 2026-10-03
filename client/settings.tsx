import { type PluginSurfaceProps, useRpc, useSettings } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  type SettingsInputHandle,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { pairingUrlRpc, statusRpc, testPeerRpc } from "../shared/rpc";
import { meshSettings, type MeshSettings, type Peer } from "../shared/settings";

export function MeshSettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(meshSettings);
  const getStatus = useRpc(statusRpc);
  const testPeer = useRpc(testPeerRpc);
  const getPairingUrl = useRpc(pairingUrlRpc);
  const status = useQuery({ queryKey: ["mesh-status"], queryFn: () => getStatus({}), refetchInterval: 5000 });

  const [draft, setDraft] = useState({ name: "", url: "", password: "" });
  const [addError, setAddError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [pairing, setPairing] = useState<string | null>(null);
  const [hostDraft, setHostDraft] = useState<string | null>(null);
  const nameRef = useRef<SettingsInputHandle>(null);
  const urlRef = useRef<SettingsInputHandle>(null);
  const passwordRef = useRef<SettingsInputHandle>(null);

  const styles = useMemo(
    () => ({
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 13 },
      mono: { color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" },
      pad: { paddingHorizontal: 16, paddingVertical: 12, gap: 6 },
    }),
    [theme],
  );

  if (settings.status === "loading") return <Text style={styles.muted}>Loading…</Text>;
  if (settings.status === "error") return <Text style={styles.body}>Error: {settings.error}</Text>;
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Settings are invalid">
        <SettingsCard>
          <SettingsAction label={settings.error} actionLabel="Reset" onPress={() => void settings.reset()} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const values = settings.values;
  const save = (patch: Partial<MeshSettings>) => void settings.save({ ...values, ...patch }, settings.revision);
  const setPeer = (index: number, patch: Partial<Peer>) =>
    save({ peers: values.peers.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  const hostState = (name: string) => status.data?.hosts.find((h) => h.name === name);

  const addPeer = () => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) return setAddError("Name and pairing link are required.");
    if (/[\s/]/.test(name)) return setAddError("Name cannot contain spaces or slashes.");
    if (values.peers.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return setAddError(`A peer named "${name}" already exists.`);
    }
    setAddError(null);
    save({ peers: [...values.peers, { name, url, password: draft.password || undefined, enabled: true }] });
    setDraft({ name: "", url: "", password: "" });
    nameRef.current?.replaceText("");
    urlRef.current?.replaceText("");
    passwordRef.current?.replaceText("");
  };

  const runTest = async (key: string, url: string, password?: string) => {
    setTestResults((r) => ({ ...r, [key]: "Testing…" }));
    const result = await testPeer({ url, password }).catch((e: Error) => ({ ok: false, agents: null, error: e.message }));
    setTestResults((r) => ({
      ...r,
      [key]: result.ok ? `Connected · ${result.agents} agents` : `Failed: ${result.error}`,
    }));
  };

  return (
    <View style={{ gap: 24 }}>
      <SettingsSection title="This host">
        <SettingsCard>
          <SettingsInput
            label="Host name"
            hint={`Agents address this host as "${status.data?.hostName ?? "…"}". Leave empty for the machine name.`}
            initialValue={values.hostName}
            placeholder="e.g. mac"
            onChangeText={setHostDraft}
          />
          {hostDraft !== null && hostDraft.trim() !== values.hostName ? (
            <SettingsAction
              label="Save host name"
              actionLabel="Save"
              onPress={() => {
                save({ hostName: hostDraft.trim() });
                setHostDraft(null);
              }}
            />
          ) : null}
          <SettingsSwitch
            label="Give new agents the mesh tools"
            hint="Adds the “mesh” MCP server to every agent created on this host."
            value={values.injectIntoAgents}
            onValueChange={(injectIntoAgents) => save({ injectIntoAgents })}
          />
          <SettingsSwitch
            label="Allow agents to create and archive agents"
            value={values.allowAgentManagement}
            onValueChange={(allowAgentManagement) => save({ allowAgentManagement })}
          />
          <SettingsAction
            label="Pairing link for this host"
            hint="Add this host as a peer on other hosts with this link."
            actionLabel="Show"
            onPress={async () => {
              const r = await getPairingUrl({});
              setPairing(r.url ?? `Error: ${r.error}`);
            }}
          />
          {pairing ? (
            <View style={styles.pad}>
              <Text selectable style={styles.mono}>
                {pairing}
              </Text>
            </View>
          ) : null}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Peers">
        <SettingsCard>
          {values.peers.length === 0 ? (
            <View style={styles.pad}>
              <Text style={styles.muted}>No peers yet. Add another host with its pairing link below.</Text>
            </View>
          ) : null}
          {values.peers.map((peer, index) => {
            const s = hostState(peer.name);
            const state = s ? (s.error ? `${s.state}: ${s.error}` : s.state) : "unknown";
            return (
              <View key={peer.name}>
                <SettingsSwitch
                  label={peer.name}
                  hint={`${state}${testResults[peer.name] ? ` · ${testResults[peer.name]}` : ""}`}
                  value={peer.enabled}
                  onValueChange={(enabled) => setPeer(index, { enabled })}
                />
                <SettingsRow label="Actions">
                  <View style={{ flexDirection: "row", gap: 12 }}>
                    <Text
                      accessibilityRole="button"
                      style={{ color: theme.colors.accent }}
                      onPress={() => void runTest(peer.name, peer.url, peer.password)}
                    >
                      Test
                    </Text>
                    <Text
                      accessibilityRole="button"
                      style={{ color: theme.colors.statusDanger }}
                      onPress={() => save({ peers: values.peers.filter((_, i) => i !== index) })}
                    >
                      Remove
                    </Text>
                  </View>
                </SettingsRow>
              </View>
            );
          })}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Add peer">
        <SettingsCard>
          <SettingsInput
            ref={nameRef}
            label="Name"
            placeholder="lab"
            onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
          />
          <SettingsInput
            ref={urlRef}
            label="Pairing link or address"
            hint="https://app.paseo.sh/#offer=… from `paseo daemon pair` on that host, or ws://host:6767/ws"
            placeholder="https://app.paseo.sh/#offer=…"
            onChangeText={(url) => setDraft((d) => ({ ...d, url }))}
          />
          <SettingsInput
            ref={passwordRef}
            label="Daemon password (optional)"
            secureTextEntry
            onChangeText={(password) => setDraft((d) => ({ ...d, password }))}
          />
          <SettingsAction
            label="Check the connection"
            hint={testResults.__draft}
            actionLabel="Test"
            disabled={!draft.url.trim()}
            onPress={() => void runTest("__draft", draft.url.trim(), draft.password || undefined)}
          />
          <SettingsAction label="Save peer" error={addError} actionLabel="Add" onPress={addPeer} />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
