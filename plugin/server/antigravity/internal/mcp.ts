import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderSessionConfig } from "@getpaseo/plugin/server/provider";
import { MCP_CHILD, MCP_ENV } from "./mcp-child.ts";
import { AntigravityError } from "./wire.ts";

export function mcpMapping(config: ProviderSessionConfig, namespace: string): Record<string, string> {
  return Object.fromEntries(Object.keys(config.mcpServers).sort().map((name, index) => [name, `slp-${namespace}-${index}`]));
}

export function mcpBinding(config: ProviderSessionConfig, namespace = ""): string {
  const names = Object.keys(config.mcpServers).sort();
  return createHash("sha256").update(JSON.stringify(names.length ? [mcpMapping(config, namespace), process.execPath, MCP_CHILD] : [])).digest("hex");
}

export function mcpEnvironment(config: ProviderSessionConfig): Record<string, string> {
  for (const server of Object.values(config.mcpServers)) {
    if (server.type === "sse") throw new AntigravityError("Antigravity SLP supports stdio and Streamable HTTP MCP; legacy SSE is unsupported", "UNSUPPORTED_MCP_TRANSPORT");
  }
  const bundle = JSON.stringify({ cwd: config.cwd, servers: config.mcpServers });
  if (Buffer.byteLength(bundle) > 64 * 1024) throw new AntigravityError("Antigravity session MCP configuration exceeds 64 KiB", "MCP_CONFIG_TOO_LARGE");
  return { [MCP_ENV]: bundle };
}

/** Native conversations cache MCP declarations. Keep those declarations free
 * of per-open credentials; their inline child reads the current environment.
 * The namespace, server-name set and relay ABI must remain stable across resume. */
export class McpFiles {
  private root: string | null = null;
  private name = `slp-${randomUUID()}`;

  private readonly namespace: string;
  constructor(namespace = randomUUID().replaceAll("-", "")) { this.namespace = namespace; }

  async open(config: ProviderSessionConfig): Promise<{ directory: string; name: string } | null> {
    if (Object.keys(config.mcpServers).length === 0) return null;
    if (this.root === null) {
      this.root = await mkdtemp(join(tmpdir(), "paseo-slp-antigravity-"));
      try {
        await chmod(this.root, 0o700);
        const directory = join(this.root, ".agents", "agents");
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const metadata = {
          name: this.name, description: "Paseo SLP session MCP transport", mainAgent: true, subagent: false,
          mcpServers: Object.entries(mcpMapping(config, this.namespace)).map(([logical, name]) => ({ name,
            command: process.execPath, args: ["--eval", MCP_CHILD, logical] })),
        };
        // JSON is valid YAML; values cannot escape the frontmatter carrier.
        const body = `---\n${JSON.stringify(metadata)}\n---\n# System Prompt\nFollow the current role instructions supplied with each user prompt.\n`;
        await writeFile(join(directory, `${this.name}.md`), body, { flag: "wx", mode: 0o600 });
      } catch (error) { await this.close(); throw error; }
    }
    return { directory: this.root, name: this.name };
  }

  async close(): Promise<void> {
    if (this.root !== null) { await rm(this.root, { recursive: true, force: true }); this.root = null; }
  }
}
