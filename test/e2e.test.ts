import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 18787 + Math.floor(Math.random() * 1000);
let proc: ChildProcess;
let root: string;
let cfg: string;
let client: Client;

const text = (r: any) => r.content.map((c: any) => c.text).join("\n");
const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<any>;

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "clc-root-"));
  cfg = await fs.mkdtemp(path.join(os.tmpdir(), "clc-cfg-"));
  await fs.writeFile(path.join(root, "hello.ts"), "export const greet = () => 'hi';\n");
  await fs.writeFile(path.join(root, ".env"), "SECRET=1\n");
  await fs.symlink("/etc", path.join(root, "escape"));
  proc = spawn(process.execPath, ["src/server.ts", "--root", root, "--port", String(PORT), "--allow-commands"], {
    env: { ...process.env, XDG_CONFIG_HOME: cfg },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((res) => proc.stdout!.on("data", (d) => String(d).includes("Lokaal") && res()));
  const token = (await fs.readFile(path.join(cfg, "chatgpt-local-connector", "token"), "utf8")).trim();
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${token}`)));
});

after(async () => {
  await client?.close();
  proc?.kill();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(cfg, { recursive: true, force: true });
});

test("rejects wrong token", async () => {
  const r = await fetch(`http://127.0.0.1:${PORT}/mcp/wrong`, { method: "POST" });
  assert.equal(r.status, 404);
});

test("lists tools incl. run_command", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["project_overview", "read_file", "edit_file", "search", "log_decision", "run_command"]) assert.ok(names.includes(n), n);
});

test("read, edit, search", async () => {
  assert.match(text(await call("read_file", { path: "hello.ts" })), /1│export const greet/);
  const e = await call("edit_file", { path: "hello.ts", edits: [{ old_text: "'hi'", new_text: "'hallo'" }] });
  assert.ok(!e.isError, text(e));
  assert.equal(await fs.readFile(path.join(root, "hello.ts"), "utf8"), "export const greet = () => 'hallo';\n");
  assert.match(text(await call("search", { query: "hallo" })), /hello\.ts:1:/);
  const miss = await call("edit_file", { path: "hello.ts", edits: [{ old_text: "nope", new_text: "x" }] });
  assert.ok(miss.isError);
});

test("sandbox blocks escapes and secrets", async () => {
  for (const p of ["../outside.txt", "/etc/passwd", "escape/passwd", ".env"]) {
    const r = await call("read_file", { path: p });
    assert.ok(r.isError, `${p} should be blocked: ${text(r)}`);
  }
  const w = await call("write_file", { path: ".git/config", content: "x" });
  assert.ok(w.isError);
});

test("memory + decisions show up in overview", async () => {
  await call("update_notes", { content: "# Status\nBezig met greet()" });
  await call("log_decision", { title: "Taal", decision: "Nederlands", rationale: "Gebruiker is Vlaams" });
  const o = text(await call("project_overview"));
  assert.match(o, /Bezig met greet/);
  assert.match(o, /— Taal/);
});

test("run_command runs in root", async () => {
  const r = text(await call("run_command", { command: "pwd && ls" }));
  assert.match(r, /exit code 0/);
  assert.ok(r.includes("hello.ts"));
});
