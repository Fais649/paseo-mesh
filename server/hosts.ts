import { readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { join } from "node:path";
import { createPaseoClient, type PaseoApi, type PaseoClient } from "@getpaseo/client";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import {
  buildDaemonWebSocketUrl,
  buildRelayWebSocketUrl,
  shouldUseTlsForDefaultHostedRelay,
} from "@getpaseo/protocol/daemon-endpoints";
import type { HostStatus } from "../shared/rpc";
import type { MeshSettings, Peer } from "../shared/settings";

export function paseoHome(): string {
  return process.env.PASEO_HOME || join(homedir(), ".paseo");
}

function localDaemonUrl(settings: MeshSettings): string {
  if (settings.localUrl) return toWebSocketUrl(settings.localUrl).url;
  let listen = "127.0.0.1:6767";
  try {
    const config = JSON.parse(readFileSync(join(paseoHome(), "config.json"), "utf8"));
    if (typeof config?.daemon?.listen === "string") listen = config.daemon.listen;
  } catch {
    // Missing config means the daemon default.
  }
  return buildDaemonWebSocketUrl(listen.replace(/^0\.0\.0\.0/, "127.0.0.1"), { useTls: false });
}

/** Turn a pairing link, ws:// URL, or host:port into a client URL plus E2EE settings. */
export function toWebSocketUrl(input: string): { url: string; daemonPublicKeyB64?: string } {
  const trimmed = input.trim();
  const offer = parseConnectionOfferFromUrl(trimmed);
  if (offer) {
    const endpoint = offer.relay.endpoint;
    return {
      url: buildRelayWebSocketUrl({
        endpoint,
        useTls: offer.relay.useTls ?? shouldUseTlsForDefaultHostedRelay(endpoint),
        serverId: offer.serverId,
        role: "client",
      }),
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
    };
  }
  if (/^wss?:\/\//.test(trimmed)) return { url: trimmed };
  if (/^https?:\/\//.test(trimmed)) {
    const u = new URL(trimmed);
    return { url: buildDaemonWebSocketUrl(u.host, { useTls: u.protocol === "https:" }) };
  }
  return { url: buildDaemonWebSocketUrl(trimmed, { useTls: false }) };
}

export function connectTo(input: string, password?: string): PaseoClient {
  const target = toWebSocketUrl(input);
  return createPaseoClient({
    url: target.url,
    password: password || undefined,
    clientId: `paseo-mesh-${hostname()}`,
    connectTimeoutMs: 15_000,
    reconnect: { enabled: true, baseDelayMs: 1_000, maxDelayMs: 30_000 },
    e2ee: target.daemonPublicKeyB64
      ? { enabled: true, daemonPublicKeyB64: target.daemonPublicKeyB64 }
      : undefined,
  });
}

interface Connection {
  key: string;
  client: PaseoClient;
  ready: Promise<void> | null;
  error: string | null;
}

/** Connected clients for this host and every configured peer, reconnecting on demand. */
export class HostRegistry {
  private settings: MeshSettings;
  private connections = new Map<string, Connection>();

  constructor(settings: MeshSettings) {
    this.settings = settings;
  }

  get selfName(): string {
    return this.settings.hostName.trim() || hostname().split(".")[0]!;
  }

  get config(): MeshSettings {
    return this.settings;
  }

  update(settings: MeshSettings) {
    this.settings = settings;
    // Drop connections whose target changed, then reconnect everything in the background.
    const wanted = new Map<string, string>([[this.selfName, this.selfKey()]]);
    for (const peer of this.activePeers()) wanted.set(peer.name, this.peerKey(peer));
    for (const [name, conn] of this.connections) {
      if (wanted.get(name) !== conn.key) {
        void conn.client.close().catch(() => {});
        this.connections.delete(name);
      }
    }
    this.warm();
  }

  /** Open every connection in the background so status reflects reality before first use. */
  warm() {
    for (const name of this.hostNames()) void this.get(name).catch(() => {});
  }

  private selfKey() {
    return `self|${localDaemonUrl(this.settings)}|${this.settings.localPassword}`;
  }

  private peerKey(peer: Peer) {
    return `peer|${peer.url}|${peer.password ?? ""}`;
  }

  private activePeers(): Peer[] {
    return this.settings.peers.filter((p) => p.enabled && p.name !== this.selfName);
  }

  hostNames(): string[] {
    return [this.selfName, ...this.activePeers().map((p) => p.name)];
  }

  isSelf(name: string | undefined): boolean {
    return !name || name === this.selfName || name === "self" || name === "local";
  }

  canonical(name: string | undefined): string {
    if (this.isSelf(name)) return this.selfName;
    const peer = this.findPeer(name!);
    return peer.name;
  }

  private findPeer(name: string): Peer {
    const lower = name.toLowerCase();
    const peer = this.settings.peers.find((p) => p.name.toLowerCase() === lower);
    if (!peer) {
      throw new Error(`Unknown host "${name}". Known hosts: ${this.hostNames().join(", ")}`);
    }
    if (!peer.enabled) throw new Error(`Host "${peer.name}" is disabled in paseo-mesh settings.`);
    return peer;
  }

  /** Connected Paseo API for a host name (empty or "self" means this host). */
  async get(name?: string): Promise<PaseoApi> {
    const canonical = this.canonical(name);
    let conn = this.connections.get(canonical);
    if (!conn) {
      const self = canonical === this.selfName;
      const client = self
        ? createPaseoClient({
            url: localDaemonUrl(this.settings),
            password: this.settings.localPassword || undefined,
            clientId: "paseo-mesh-local",
            reconnect: { enabled: true, baseDelayMs: 500, maxDelayMs: 10_000 },
          })
        : (() => {
            const peer = this.findPeer(canonical);
            return connectTo(peer.url, peer.password);
          })();
      conn = {
        key: self ? this.selfKey() : this.peerKey(this.findPeer(canonical)),
        client,
        ready: null,
        error: null,
      };
      this.connections.set(canonical, conn);
    }
    const state = conn.client.getConnectionState().status;
    if (state !== "connected") {
      if (state === "disposed") {
        this.connections.delete(canonical);
        return this.get(canonical);
      }
      const current = conn;
      current.ready ??= current.client.connect().then(
        () => {
          current.error = null;
          current.ready = null;
        },
        (err: unknown) => {
          current.error = err instanceof Error ? err.message : String(err);
          current.ready = null;
          throw new Error(`Cannot reach host "${canonical}": ${current.error}`);
        },
      );
      await current.ready;
    }
    return conn.client;
  }

  status(): HostStatus[] {
    const result: HostStatus[] = [];
    const names = [this.selfName, ...this.settings.peers.map((p) => p.name)];
    for (const name of new Set(names)) {
      const peer = this.settings.peers.find((p) => p.name === name);
      if (peer && !peer.enabled && name !== this.selfName) {
        result.push({ name, self: false, state: "disabled", error: null });
        continue;
      }
      const conn = this.connections.get(name);
      const raw = conn?.client.getConnectionState().status;
      const state: HostStatus["state"] = conn?.error
        ? "error"
        : raw === "connected"
          ? "connected"
          : raw === "connecting"
            ? "connecting"
            : "disconnected";
      result.push({ name, self: name === this.selfName, state, error: conn?.error ?? null });
    }
    return result;
  }

  async close() {
    await Promise.all([...this.connections.values()].map((c) => c.client.close().catch(() => {})));
    this.connections.clear();
  }
}
