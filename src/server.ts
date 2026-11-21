#!/usr/bin/env node
import { type ChildProcess, execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs, promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { Sandbox } from "./sandbox.ts";
import { DECISIONS_FILE, NOTES_FILE, registerTools } from "./tools.ts";

const execFileP = promisify(execFile);

const HELP = `chatgpt-local-connector — geef ChatGPT (web) toegang tot één lokale projectmap via MCP

Gebruik:
  node src/server.ts --root <map> [opties]

Opties:
  --root <map>         Projectmap die ChatGPT mag zien (standaard: huidige map)
  --port <n>           Lokale poort (standaard 8787)
  --funnel             Publiceer via Tailscale Funnel (vaste https-URL, aanbevolen)
  --cloudflared        Publiceer via een cloudflared quick tunnel (URL wisselt per start)
  --allow-commands     Laat ChatGPT shell-commando's uitvoeren (tests, builds, git)
  --read-only          Alleen lezen, geen wijzigingen
  --allow-secrets      Sta toegang toe tot .env, sleutels, ... (afgeraden)
  --rotate-token       Maak een nieuwe geheime token (oude connector-URL werkt niet meer)
  -h, --help           Deze hulp
`;

const { values: args } = parseArgs({
  options: {
    root: { type: "string", default: process.cwd() },
    port: { type: "string", default: "8787" },
    funnel: { type: "boolean", default: false },
    cloudflared: { type: "boolean", default: false },
    "allow-commands": { type: "boolean", default: false },
    "read-only": { type: "boolean", default: false },
    "allow-secrets": { type: "boolean", default: false },
    "rotate-token": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const port = Number(args.port);
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "chatgpt-local-connector");
const TOKEN_FILE = path.join(CONFIG_DIR, "token");

async function loadToken(rotate: boolean): Promise<string> {
  if (!rotate) {
    try {
      const t = (await fs.readFile(TOKEN_FILE, "utf8")).trim();
      if (t.length >= 32) return t;
    } catch {}
  }
  const token = crypto.randomBytes(32).toString("base64url");
  await fs.mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function log(tool: string, detail: string) {
  const ts = new Date().toLocaleTimeString("nl-BE", { hour12: false });
  console.log(`[${ts}] ${tool.padEnd(16)} ${detail}`);
}

const INSTRUCTIONS = `You are connected to the user's local development project folder.
Workflow:
1. Start every conversation with project_overview: it contains the file tree, git state and the persistent memory from earlier conversations.
2. Investigate with list_directory, search and read_file before changing code. Never guess file contents.
3. Change code with edit_file (exact find/replace) or write_file for new files. Make the change directly instead of pasting code for the user to copy.
4. Record non-trivial choices with log_decision (${DECISIONS_FILE}).
5. Before finishing a task, update ${NOTES_FILE} via update_notes with current status, next steps and open questions so a future conversation can continue autonomously.
All paths are relative to the project root.`;

function buildServer(sb: Sandbox, allowCommands: boolean): McpServer {
  const server = new McpServer(
    { name: "chatgpt-local-connector", title: `Lokaal project: ${path.basename(sb.root)}`, version: "0.1.0" },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, sb, { allowCommands, log });
  return server;
}

async function startFunnel(): Promise<{ url: string; child: ChildProcess }> {
  let dns: string;
  try {
    const { stdout } = await execFileP("tailscale", ["status", "--json"]);
    dns = String(JSON.parse(stdout).Self?.DNSName ?? "").replace(/\.$/, "");
  } catch {
    throw new Error("Tailscale niet gevonden of niet ingelogd. Installeer en run eerst: sudo tailscale up");
  }
  if (!dns) throw new Error("Kon de Tailscale DNS-naam niet bepalen (is MagicDNS/HTTPS aan in je tailnet?).");
  const child = spawn("tailscale", ["funnel", String(port)], { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr?.on("data", (d) => process.stderr.write(`[funnel] ${d}`));
  child.stdout?.on("data", (d) => {
    const s = String(d);
    if (/error|denied|not enabled|operator/i.test(s)) process.stderr.write(`[funnel] ${s}`);
  });
  child.on("exit", (code) => code && console.error(`[funnel] gestopt met code ${code}. Zie de README voor Funnel-setup.`));
  return { url: `https://${dns}`, child };
}

function startCloudflared(): Promise<{ url: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", () => reject(new Error("cloudflared niet gevonden. Installeer met: sudo pacman -S cloudflared")));
    const onData = (d: Buffer) => {
      const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) resolve({ url: m[0], child });
    };
    child.stderr?.on("data", onData);
    child.stdout?.on("data", onData);
    setTimeout(() => reject(new Error("cloudflared gaf binnen 30s geen URL.")), 30_000);
  });
}

async function main() {
  const sb = await Sandbox.create(args.root!, { allowSecrets: args["allow-secrets"]!, readOnly: args["read-only"]! });
  const allowCommands = args["allow-commands"]! && !args["read-only"];
  const token = await loadToken(args["rotate-token"]!);

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));

  app.get("/", (_req, res) => void res.type("text/plain").send("ok"));

  const handle = async (req: Request, res: Response) => {
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
      return;
    }
    // Stateless: a fresh server + transport per request, so restarts never break ChatGPT's connection.
    const server = buildServer(sb, allowCommands);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP-fout:", err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  };

  // Token in the path (what ChatGPT's "no auth" connectors can carry) or as a Bearer header (other MCP clients).
  app.all("/mcp/:token", (req, res) => {
    if (!safeEqual(String(req.params.token), token)) return void res.status(404).send("Not found");
    void handle(req, res);
  });
  app.all("/mcp", (req, res) => {
    const auth = req.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), token)) return void res.status(401).send("Unauthorized");
    void handle(req, res);
  });
  app.use((_req, res) => void res.status(404).send("Not found"));

  await new Promise<void>((resolve) => app.listen(port, "127.0.0.1", () => resolve()));

  let publicUrl: string | null = null;
  const children: ChildProcess[] = [];
  try {
    if (args.funnel) {
      const f = await startFunnel();
      publicUrl = f.url;
      children.push(f.child);
    } else if (args.cloudflared) {
      const c = await startCloudflared();
      publicUrl = c.url;
      children.push(c.child);
    }
  } catch (err) {
    console.error(`\n⚠  ${(err as Error).message}\n`);
  }

  const bar = "─".repeat(72);
  console.log(`\n${bar}\n ChatGPT Local Connector`);
  console.log(` Projectmap : ${sb.root}`);
  console.log(` Modus      : ${args["read-only"] ? "read-only" : "lezen + schrijven"}${allowCommands ? " + shell-commando's" : ""}`);
  console.log(` Lokaal     : http://127.0.0.1:${port}/mcp/${token}`);
  if (publicUrl) {
    console.log(`\n Connector-URL voor ChatGPT (geheim houden!):\n   ${publicUrl}/mcp/${token}`);
  } else {
    console.log(`\n Nog niet publiek bereikbaar. Start met --funnel of --cloudflared,\n of tunnel zelf poort ${port} en plak <publieke-url>/mcp/${token} in ChatGPT.`);
  }
  console.log(`${bar}\n`);

  const shutdown = () => {
    for (const c of children) c.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
