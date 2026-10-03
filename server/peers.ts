import { execFile } from "node:child_process";
import { connectTo, paseoHome } from "./hosts";
import { errorText } from "./tools";

export async function testPeer(url: string, password?: string) {
  let client: ReturnType<typeof connectTo> | null = null;
  try {
    client = connectTo(url, password);
    await client.connect();
    const list = await client.agents.list({});
    return { ok: true, agents: list.entries.length, error: null };
  } catch (err) {
    return { ok: false, agents: null, error: errorText(err) };
  } finally {
    await client?.close().catch(() => {});
  }
}

/** This host's pairing link, for adding it as a peer on other hosts. */
export function pairingUrl(): Promise<{ url: string | null; error: string | null }> {
  const cli = process.env.PASEO_CLI || "paseo";
  return new Promise((resolve) => {
    execFile(cli, ["daemon", "pair", "--json", "--home", paseoHome()], { timeout: 20_000 }, (err, stdout) => {
      if (err) return resolve({ url: null, error: errorText(err) });
      try {
        const url = JSON.parse(stdout).url;
        resolve(typeof url === "string" ? { url, error: null } : { url: null, error: "No url in output" });
      } catch (parseErr) {
        resolve({ url: null, error: errorText(parseErr) });
      }
    });
  });
}
