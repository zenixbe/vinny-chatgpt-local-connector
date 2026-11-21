import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { isSecretName, NOISE_DIRS, type Sandbox, SandboxError } from "./sandbox.ts";

const execFileP = promisify(execFile);

export const MEMORY_DIR = ".chatgpt";
export const NOTES_FILE = `${MEMORY_DIR}/notes.md`;
export const DECISIONS_FILE = `${MEMORY_DIR}/decisions.md`;

const MAX_READ_BYTES = 512 * 1024;
const MAX_OUTPUT_CHARS = 60_000;

export interface ToolOptions {
  allowCommands: boolean;
  log: (tool: string, detail: string) => void;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

function clip(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n… [afgekapt: ${text.length - max} extra tekens]`;
}

/** Wrap a handler so sandbox/fs errors become readable tool errors instead of protocol errors. */
function guarded<A>(name: string, opts: ToolOptions, fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    opts.log(name, JSON.stringify(args).slice(0, 300));
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof SandboxError) return fail(err.message);
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return fail(`Bestaat niet: ${e.path ?? ""}`);
      if (e.code === "EISDIR") return fail("Dit is een map, geen bestand.");
      if (e.code === "ENOTDIR") return fail("Dit is geen map.");
      return fail(`Fout: ${e.message ?? String(err)}`);
    }
  };
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  try {
    const st = await fs.stat(abs);
    await fs.chmod(tmp, st.mode);
  } catch {
    /* new file */
  }
  await fs.rename(tmp, abs);
}

async function tree(sb: Sandbox, dir: string, depth: number, showHidden: boolean, limit = 800) {
  const lines: string[] = [];
  let truncated = false;
  async function walk(abs: string, level: number) {
    if (lines.length >= limit) return void (truncated = true);
    let entries = await fs.readdir(abs, { withFileTypes: true });
    entries = entries
      .filter((e) => showHidden || !e.name.startsWith(".") || e.name === MEMORY_DIR)
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      if (lines.length >= limit) return void (truncated = true);
      const indent = "  ".repeat(level);
      const child = path.join(abs, e.name);
      if (e.isDirectory()) {
        const noisy = NOISE_DIRS.has(e.name);
        lines.push(`${indent}${e.name}/${noisy ? "  (overgeslagen)" : ""}`);
        if (!noisy && level + 1 < depth) await walk(child, level + 1);
      } else if (e.isSymbolicLink()) {
        lines.push(`${indent}${e.name} -> (symlink)`);
      } else {
        let size = "";
        try {
          size = formatSize((await fs.stat(child)).size);
        } catch {}
        const secret = !sb.opts.allowSecrets && isSecretName(e.name) ? "  (secret, geblokkeerd)" : "";
        lines.push(`${indent}${e.name}  ${size}${secret}`);
      }
    }
  }
  await walk(dir, 0);
  if (truncated) lines.push(`… [lijst afgekapt na ${limit} items; gebruik een dieper pad]`);
  return lines.join("\n");
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

async function readIfExists(abs: string, maxChars = 8000): Promise<string | null> {
  try {
    return clip(await fs.readFile(abs, "utf8"), maxChars);
  } catch {
    return null;
  }
}

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", root, ...args], { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

function runShell(command: string, cwd: string, timeoutSec: number): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd, env: { ...process.env, CI: "1" } });
    let out = "";
    const add = (d: Buffer) => {
      if (out.length < MAX_OUTPUT_CHARS * 2) out += d.toString();
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, timeoutSec * 1000);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const status = timedOut ? `TIMEOUT na ${timeoutSec}s` : signal ? `signaal ${signal}` : `exit code ${code}`;
      resolve(`$ ${command}\n[${status}]\n\n${clip(out) || "(geen output)"}`);
    });
  });
}

export function registerTools(server: McpServer, sb: Sandbox, opts: ToolOptions): void {
  const RO = { readOnlyHint: true, openWorldHint: false } as const;
  const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
  const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

  server.registerTool(
    "project_overview",
    {
      title: "Projectoverzicht",
      description:
        "Call this FIRST in every conversation. Returns the project root, a file tree (depth 2), git status, " +
        "AGENTS.md/README excerpts and the persistent project memory (.chatgpt/notes.md and .chatgpt/decisions.md) " +
        "written in earlier conversations.",
      inputSchema: {},
      annotations: RO,
    },
    guarded("project_overview", opts, async () => {
      const parts: string[] = [`# Project root\n${sb.root}`];
      parts.push(`# Modus\n${sb.opts.readOnly ? "read-only" : "lezen + schrijven"}; shell-commando's: ${opts.allowCommands ? "aan" : "uit"}`);
      parts.push(`# Bestanden (diepte 2)\n${await tree(sb, sb.root, 2, false, 300)}`);
      const branch = await git(sb.root, ["status", "--short", "--branch"]);
      if (branch !== null) {
        const log = await git(sb.root, ["log", "--oneline", "-8"]);
        parts.push(`# Git\n${clip(branch, 4000)}\n\nRecente commits:\n${log || "(geen)"}`);
      }
      for (const f of ["AGENTS.md", "CLAUDE.md", "README.md"]) {
        const c = await readIfExists(path.join(sb.root, f), 4000);
        if (c) parts.push(`# ${f}\n${c}`);
      }
      const notes = await readIfExists(path.join(sb.root, NOTES_FILE), 12000);
      parts.push(`# Projectgeheugen (${NOTES_FILE})\n${notes ?? "(nog leeg — gebruik update_notes om context voor volgende gesprekken te bewaren)"}`);
      const decisions = await readIfExists(path.join(sb.root, DECISIONS_FILE), 12000);
      parts.push(`# Beslissingen (${DECISIONS_FILE})\n${decisions ?? "(nog geen — gebruik log_decision)"}`);
      return ok(parts.join("\n\n"));
    }),
  );

  server.registerTool(
    "list_directory",
    {
      title: "Map tonen",
      description: "List files and folders as an indented tree. Paths are relative to the project root. Heavy folders like node_modules are skipped.",
      inputSchema: {
        path: z.string().default(".").describe("Folder relative to project root"),
        depth: z.number().int().min(1).max(6).default(2),
        show_hidden: z.boolean().default(false),
      },
      annotations: RO,
    },
    guarded("list_directory", opts, async ({ path: p, depth, show_hidden }) => {
      const abs = await sb.resolve(p);
      return ok(`${sb.rel(abs)}/\n${await tree(sb, abs, depth, show_hidden)}`);
    }),
  );

  server.registerTool(
    "read_file",
    {
      title: "Bestand lezen",
      description:
        "Read a text file. Output is prefixed with line numbers (for reference only — never include them in edits). " +
        "Use start_line/end_line for large files.",
      inputSchema: {
        path: z.string(),
        start_line: z.number().int().min(1).optional(),
        end_line: z.number().int().min(1).optional(),
      },
      annotations: RO,
    },
    guarded("read_file", opts, async ({ path: p, start_line, end_line }) => {
      const abs = await sb.resolve(p);
      const st = await fs.stat(abs);
      if (st.isDirectory()) return fail("Dit is een map; gebruik list_directory.");
      if (st.size > MAX_READ_BYTES && !start_line) {
        return fail(`Bestand is ${formatSize(st.size)}; lees een deel met start_line/end_line.`);
      }
      const buf = await fs.readFile(abs);
      if (isBinary(buf)) return fail(`Binair bestand (${formatSize(st.size)}); niet leesbaar als tekst.`);
      const lines = buf.toString("utf8").split("\n");
      const from = (start_line ?? 1) - 1;
      const to = Math.min(end_line ?? from + 2000, lines.length);
      const width = String(to).length;
      const body = lines.slice(from, to).map((l, i) => `${String(from + i + 1).padStart(width)}│${l}`).join("\n");
      const more = to < lines.length ? `\n… [nog ${lines.length - to} regels; ga verder met start_line=${to + 1}]` : "";
      return ok(`${sb.rel(abs)} (${lines.length} regels)\n${clip(body)}${more}`);
    }),
  );

  server.registerTool(
    "search",
    {
      title: "Zoeken in code",
      description: "Search file contents with ripgrep (respects .gitignore). Returns file:line:match. Use this to find where something is defined or used.",
      inputSchema: {
        query: z.string().min(1),
        path: z.string().default("."),
        regex: z.boolean().default(false).describe("Treat query as a regular expression"),
        case_sensitive: z.boolean().default(false),
        glob: z.string().optional().describe("e.g. '*.ts' or 'src/**/*.py'"),
        max_results: z.number().int().min(1).max(500).default(100),
      },
      annotations: RO,
    },
    guarded("search", opts, async ({ query, path: p, regex, case_sensitive, glob, max_results }) => {
      const abs = await sb.resolve(p);
      const args = ["--line-number", "--no-heading", "--color=never", "--max-columns=300", "--max-count=20"];
      if (!regex) args.push("--fixed-strings");
      if (!case_sensitive) args.push("--ignore-case");
      if (glob) args.push("--glob", glob);
      if (!sb.opts.allowSecrets) args.push("--glob", "!.env*", "--glob", "!*.pem", "--glob", "!*.key");
      args.push("-e", query, "--", abs);
      try {
        const { stdout } = await execFileP("rg", args, { cwd: sb.root, maxBuffer: 20 * 1024 * 1024 });
        const hits = stdout.split("\n").filter(Boolean).map((l) => (l.startsWith(sb.root) ? l.slice(sb.root.length + 1) : l));
        const shown = hits.slice(0, max_results);
        const extra = hits.length > shown.length ? `\n… [nog ${hits.length - shown.length} resultaten]` : "";
        return ok(`${hits.length} resultaten\n${clip(shown.join("\n"))}${extra}`);
      } catch (err) {
        const e = err as { code?: number | string; stderr?: string };
        if (e.code === 1) return ok("Geen resultaten.");
        if (e.code === "ENOENT") return fail("ripgrep (rg) is niet geïnstalleerd op de host.");
        return fail(`Zoekfout: ${e.stderr ?? String(err)}`);
      }
    }),
  );

  server.registerTool(
    "write_file",
    {
      title: "Bestand schrijven",
      description: "Create or fully overwrite a file with the given content. Parent folders are created. Prefer edit_file for changes to existing files.",
      inputSchema: { path: z.string(), content: z.string() },
      annotations: DESTRUCTIVE,
    },
    guarded("write_file", opts, async ({ path: p, content }) => {
      const abs = await sb.resolve(p, { forWrite: true });
      const existed = await fs.stat(abs).then(() => true, () => false);
      await atomicWrite(abs, content);
      return ok(`${existed ? "Overschreven" : "Aangemaakt"}: ${sb.rel(abs)} (${content.split("\n").length} regels)`);
    }),
  );

  server.registerTool(
    "edit_file",
    {
      title: "Bestand bewerken",
      description:
        "Apply exact find-and-replace edits to a file, in order. Each old_text must match the file exactly (including whitespace) " +
        "and occur exactly once unless replace_all is true. All edits succeed or none are applied.",
      inputSchema: {
        path: z.string(),
        edits: z
          .array(z.object({ old_text: z.string().min(1), new_text: z.string(), replace_all: z.boolean().default(false) }))
          .min(1),
      },
      annotations: RW,
    },
    guarded("edit_file", opts, async ({ path: p, edits }) => {
      const abs = await sb.resolve(p, { forWrite: true });
      let text = await fs.readFile(abs, "utf8");
      const summary: string[] = [];
      for (const [i, e] of edits.entries()) {
        const count = text.split(e.old_text).length - 1;
        if (count === 0) return fail(`Edit ${i + 1}: old_text niet gevonden. Lees het bestand opnieuw en kopieer de tekst exact. Niets gewijzigd.`);
        if (count > 1 && !e.replace_all) {
          return fail(`Edit ${i + 1}: old_text komt ${count}x voor. Maak het uniek met meer context of zet replace_all=true. Niets gewijzigd.`);
        }
        text = e.replace_all ? text.split(e.old_text).join(e.new_text) : text.replace(e.old_text, () => e.new_text);
        summary.push(`edit ${i + 1}: ${e.replace_all ? count : 1} vervanging(en)`);
      }
      await atomicWrite(abs, text);
      return ok(`Bijgewerkt: ${sb.rel(abs)}\n${summary.join("\n")}`);
    }),
  );

  server.registerTool(
    "move_path",
    {
      title: "Verplaatsen / hernoemen",
      description: "Move or rename a file or folder inside the project. Fails if the destination exists.",
      inputSchema: { from: z.string(), to: z.string() },
      annotations: RW,
    },
    guarded("move_path", opts, async ({ from, to }) => {
      const src = await sb.resolve(from, { forWrite: true });
      const dst = await sb.resolve(to, { forWrite: true });
      if (await fs.stat(dst).then(() => true, () => false)) return fail(`Bestemming bestaat al: ${to}`);
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.rename(src, dst);
      return ok(`Verplaatst: ${sb.rel(src)} → ${sb.rel(dst)}`);
    }),
  );

  server.registerTool(
    "delete_path",
    {
      title: "Verwijderen",
      description: "Delete a file, or a folder when recursive=true. Cannot delete the project root.",
      inputSchema: { path: z.string(), recursive: z.boolean().default(false) },
      annotations: DESTRUCTIVE,
    },
    guarded("delete_path", opts, async ({ path: p, recursive }) => {
      const abs = await sb.resolve(p, { forWrite: true });
      if (abs === sb.root) return fail("De projectroot kan niet verwijderd worden.");
      const st = await fs.lstat(abs);
      if (st.isDirectory() && !recursive) return fail("Dit is een map; zet recursive=true om ze met inhoud te verwijderen.");
      await fs.rm(abs, { recursive, force: false });
      return ok(`Verwijderd: ${sb.rel(abs)}`);
    }),
  );

  server.registerTool(
    "update_notes",
    {
      title: "Projectgeheugen bijwerken",
      description:
        `Replace the persistent project memory (${NOTES_FILE}). Use it to keep the current goal, status, open TODOs, ` +
        "conventions and anything a future conversation needs to continue autonomously. Keep it concise and current " +
        "(rewrite rather than endlessly append). It is shown by project_overview.",
      inputSchema: { content: z.string().describe("Full new markdown content of the notes file") },
      annotations: RW,
    },
    guarded("update_notes", opts, async ({ content }) => {
      const abs = await sb.resolve(NOTES_FILE, { forWrite: true });
      await atomicWrite(abs, content.endsWith("\n") ? content : `${content}\n`);
      return ok(`Projectgeheugen opgeslagen in ${NOTES_FILE}.`);
    }),
  );

  server.registerTool(
    "log_decision",
    {
      title: "Beslissing vastleggen",
      description: `Append an architecture/implementation decision to ${DECISIONS_FILE} (date, decision, rationale, alternatives). Use whenever you make a non-trivial choice.`,
      inputSchema: {
        title: z.string(),
        decision: z.string(),
        rationale: z.string(),
        alternatives: z.string().optional(),
      },
      annotations: RW,
    },
    guarded("log_decision", opts, async ({ title, decision, rationale, alternatives }) => {
      const abs = await sb.resolve(DECISIONS_FILE, { forWrite: true });
      const existing = (await readIfExists(abs, Number.MAX_SAFE_INTEGER)) ?? "# Beslissingen\n";
      const date = new Date().toISOString().slice(0, 10);
      let entry = `\n## ${date} — ${title}\n\n**Beslissing:** ${decision}\n\n**Waarom:** ${rationale}\n`;
      if (alternatives) entry += `\n**Alternatieven:** ${alternatives}\n`;
      await atomicWrite(abs, existing.trimEnd() + "\n" + entry);
      return ok(`Beslissing vastgelegd in ${DECISIONS_FILE}.`);
    }),
  );

  if (opts.allowCommands) {
    server.registerTool(
      "run_command",
      {
        title: "Shell-commando uitvoeren",
        description:
          "Run a shell command (bash) in the project folder, e.g. tests, builds, linters, git. Returns combined stdout/stderr and exit code. " +
          "Not interactive; long-running servers will hit the timeout.",
        inputSchema: {
          command: z.string().min(1),
          cwd: z.string().default(".").describe("Working directory relative to project root"),
          timeout_seconds: z.number().int().min(1).max(600).default(120),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      },
      guarded("run_command", opts, async ({ command, cwd, timeout_seconds }) => {
        if (sb.opts.readOnly) return fail("Read-only modus: commando's zijn uitgeschakeld.");
        const abs = await sb.resolve(cwd);
        return ok(await runShell(command, abs, timeout_seconds));
      }),
    );
  }
}
