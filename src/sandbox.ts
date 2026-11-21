import fs from "node:fs/promises";
import path from "node:path";

/** Directories skipped when listing/overviewing (still readable if addressed directly). */
export const NOISE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".nuxt", ".svelte-kit", ".turbo",
  ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache", "target", ".cache",
  "coverage", ".idea", ".gradle", "vendor",
]);

const SECRET_ALLOWED = /^\.env\.(example|sample|template|dist)$/i;
const SECRET_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|pgpass)$/i,
  /^credentials(\.json)?$/i,
];

export function isSecretName(name: string): boolean {
  if (SECRET_ALLOWED.test(name)) return false;
  return SECRET_PATTERNS.some((re) => re.test(name));
}

export class SandboxError extends Error {}

export interface SandboxOptions {
  allowSecrets: boolean;
  readOnly: boolean;
}

/**
 * Every path ChatGPT hands us goes through here. Guarantees the resolved path —
 * including after following symlinks — stays inside `root`.
 */
export class Sandbox {
  readonly root: string;
  readonly opts: SandboxOptions;

  private constructor(root: string, opts: SandboxOptions) {
    this.root = root;
    this.opts = opts;
  }

  static async create(root: string, opts: SandboxOptions): Promise<Sandbox> {
    const real = await fs.realpath(path.resolve(root));
    const st = await fs.stat(real);
    if (!st.isDirectory()) throw new Error(`Root is geen map: ${real}`);
    return new Sandbox(real, opts);
  }

  private inside(p: string): boolean {
    return p === this.root || p.startsWith(this.root + path.sep);
  }

  /** Project-relative display path. */
  rel(abs: string): string {
    return path.relative(this.root, abs) || ".";
  }

  /**
   * Resolve a user-supplied path (relative to root, or absolute inside root).
   * `forWrite` additionally forbids touching `.git/` and requires write mode.
   */
  async resolve(input: string, { forWrite = false } = {}): Promise<string> {
    if (forWrite && this.opts.readOnly) {
      throw new SandboxError("De connector draait in read-only modus; schrijven is uitgeschakeld.");
    }
    const raw = (input ?? "").trim() || ".";
    const candidate = path.resolve(this.root, raw);
    if (!this.inside(candidate)) {
      throw new SandboxError(`Pad valt buiten de projectmap: ${input}`);
    }

    // Follow symlinks on the deepest existing ancestor so a link can't escape the root.
    let existing = candidate;
    const tail: string[] = [];
    for (;;) {
      try {
        existing = await fs.realpath(existing);
        break;
      } catch {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        tail.unshift(path.basename(existing));
        existing = parent;
      }
    }
    const real = path.join(existing, ...tail);
    if (!this.inside(real)) {
      throw new SandboxError(`Pad verwijst (via symlink) naar buiten de projectmap: ${input}`);
    }

    const segments = path.relative(this.root, real).split(path.sep);
    if (!this.opts.allowSecrets && segments.some(isSecretName)) {
      throw new SandboxError(
        `Toegang tot '${input}' geweigerd: dit lijkt een bestand met secrets (.env, sleutels, ...). ` +
          `Start de connector met --allow-secrets als dit echt nodig is.`,
      );
    }
    if (forWrite && segments[0] === ".git") {
      throw new SandboxError("Direct schrijven in .git/ is niet toegestaan; gebruik git-commando's.");
    }
    return real;
  }
}
