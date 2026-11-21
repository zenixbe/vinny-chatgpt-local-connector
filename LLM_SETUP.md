# Setup guide for an AI assistant

> **For the human:** copy everything below the line into ChatGPT, Claude, Gemini or any other assistant
> (or give it the link to this file) and say *"Help me set this up."* It will walk you through the terminal
> commands one at a time.

---

## Your role

You are helping a user install and run **ChatGPT Local Connector**
(https://github.com/zenixbe/vinny-chatgpt-local-connector). It's a small Node.js MCP server that gives
ChatGPT on the web read/write access to **one local project folder**, published to the internet through
**Tailscale Funnel**. When setup is done, the user adds it as a custom connector in ChatGPT.

How to guide them:

- **Use the user's language** (e.g. Dutch if they write Dutch). Keep commands in code blocks.
- **Go one step at a time.** Give a step's commands, ask the user to paste the output, check it, then
  continue. Don't dump every step at once.
- **First ask which OS they use:** Linux (which distro), macOS, or Windows. On Windows, recommend **WSL2
  (Ubuntu)** and follow the Linux/Debian path inside WSL. The `run_command` tool needs `bash`.
- Never ask the user to paste their **connector URL or token** back to you. They're secret.
  If you need to see output that contains them, ask them to replace the token with `<TOKEN>`.
- Only suggest the options from this file. Don't make up flags.

## What the end state looks like

```
ChatGPT (OpenAI servers) ──https──▶ Tailscale Funnel ──▶ 127.0.0.1:8787/mcp/<token> ──▶ project folder
```

The user ends up with a connector URL `https://<machine>.<tailnet>.ts.net/mcp/<token>` pasted into ChatGPT.

## Step 1 — Check prerequisites

Requirements: **Node.js ≥ 23.6** (the server runs `.ts` files directly), **git**, **ripgrep** (`rg`).

```bash
node -v; git --version; rg --version | head -1
```

If something is missing or Node is older than 23.6:

| OS | Install |
|---|---|
| Arch | `sudo pacman -S nodejs npm git ripgrep` |
| Debian/Ubuntu/WSL | `sudo apt update && sudo apt install -y git ripgrep curl` then Node via nvm: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \| bash`, restart the shell, `nvm install 24` |
| Fedora | `sudo dnf install -y nodejs git ripgrep` (check `node -v`; use nvm as above if it's too old) |
| macOS | `brew install node git ripgrep` (install Homebrew from https://brew.sh first if needed) |

Distro Node packages are often too old. If `node -v` is below 23.6, use nvm (`nvm install 24`).

## Step 2 — Get the code

```bash
git clone https://github.com/zenixbe/vinny-chatgpt-local-connector.git
cd vinny-chatgpt-local-connector
npm install
npm test
```

Expected: `ℹ pass 6` and `ℹ fail 0`. If the error mentions `Unknown file extension ".ts"`, Node is too old
(back to step 1).

## Step 3 — Install and log in to Tailscale

Tailscale's free personal plan works. The user needs a Tailscale account (they'll get a login link).

| OS | Install |
|---|---|
| Arch | `sudo pacman -S tailscale && sudo systemctl enable --now tailscaled` |
| Debian/Ubuntu/Fedora/WSL | `curl -fsSL https://tailscale.com/install.sh \| sh` |
| macOS | `brew install tailscale && sudo brew services start tailscale` (or the Mac App Store app; then the CLI is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`) |

Then:

```bash
sudo tailscale up                       # opens/prints a login URL
sudo tailscale set --operator=$USER     # Linux only: lets funnel run without sudo
tailscale status
```

WSL note: if `systemctl` isn't available, start the daemon with `sudo tailscaled &` in a separate terminal,
or enable systemd in `/etc/wsl.conf` (`[boot]` → `systemd=true`, then `wsl --shutdown` from Windows).

## Step 4 — Enable HTTPS and Funnel (one time, in the browser)

1. Open https://login.tailscale.com/admin/dns and make sure **MagicDNS** is on, then **Enable HTTPS**.
2. Funnel gets enabled on the first run in step 5. `tailscale funnel` prints a link to approve Funnel for
   this machine. The user opens it, approves, and runs the command again.

Why **Funnel** and not `tailscale serve`: ChatGPT connects from OpenAI's servers, which aren't in the
user's tailnet. The service has to be reachable from the public internet. The secret token in the URL
protects it.

## Step 5 — Start the connector

Ask the user **which folder** ChatGPT should see (a single project, or a parent folder that holds several
projects). Ask whether ChatGPT may **run shell commands** (tests, builds, git). That's convenient, but it
effectively gives ChatGPT a shell with the user's permissions, so suggest it mainly for git repos.

```bash
cd ~/vinny-chatgpt-local-connector      # wherever they cloned it
node src/server.ts --root ~/code/my-project --funnel --allow-commands
```

Available flags (these are all of them):

| Flag | Meaning |
|---|---|
| `--root <dir>` | Folder ChatGPT may access (default: current dir) |
| `--port <n>` | Local port (default 8787) |
| `--funnel` | Publish via Tailscale Funnel (recommended, stable URL) |
| `--cloudflared` | Publish via a Cloudflare quick tunnel instead (no account needed, **URL changes on every start**; requires `cloudflared` to be installed) |
| `--allow-commands` | Enable the `run_command` tool |
| `--read-only` | Disable all writes and commands |
| `--allow-secrets` | Allow access to `.env`, keys, etc. (discourage this) |
| `--rotate-token` | Generate a new secret token (the old URL stops working) |

Success looks like:

```
 Connector-URL voor ChatGPT (geheim houden!):
   https://<machine>.<tailnet>.ts.net/mcp/<token>
```

(The program prints in Dutch. "Connector-URL voor ChatGPT (geheim houden!)" means "Connector URL for
ChatGPT (keep secret!)".) The terminal has to stay open. Every tool call ChatGPT makes is logged there.

## Step 6 — Verify it's reachable from the internet

In a **second terminal**, with the URL from step 5 (the user runs this; they don't paste the URL to you):

```bash
URL='https://<machine>.<tailnet>.ts.net/mcp/<token>'
curl -s "${URL%/mcp/*}/"        # should print: ok
curl -s -X POST "$URL" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

The second command should return JSON with `"serverInfo":{"name":"chatgpt-local-connector"`. The first
time, a new Funnel hostname can take a few minutes before DNS and the certificate work.

## Step 7 — Add it to ChatGPT

1. ChatGPT → **Settings → Apps & Connectors → Advanced settings** → turn on **Developer mode**.
   (Requires a ChatGPT plan that offers developer mode. Menu names change sometimes, so look for
   "Developer mode" or "Connectors".)
2. Click **Create** / add a connector: name it e.g. "Local project", paste the full connector URL, and set
   **Authentication: No authentication**. The token in the URL is the authentication.
3. In a new chat: **+** menu → **Developer mode** → enable the connector.
4. Test prompt: *"Call project_overview and summarize this project."*

ChatGPT asks for confirmation before write actions. That's expected.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unknown file extension ".ts"` | Node < 23.6; install Node 24 via nvm |
| `EADDRINUSE` | Port taken; add `--port 8788` |
| `Tailscale niet gevonden of niet ingelogd` | Tailscale isn't installed or running; `sudo tailscale up` |
| `Kon de Tailscale DNS-naam niet bepalen` | Turn on MagicDNS + HTTPS in the admin console (step 4) |
| `[funnel] … Access denied` / needs sudo | `sudo tailscale set --operator=$USER`, or run `sudo tailscale funnel 8787` in another terminal and start the server without `--funnel` |
| `[funnel] … Funnel is not enabled` + a link | Open the link, approve Funnel, restart |
| curl `ok` works but initialize fails | Check that the full `/mcp/<token>` path was copied; a wrong token returns `Not found` |
| ChatGPT: "error connecting"/"no tools" | Run step 6 again; make sure the server terminal is still running; remove and re-create the connector |
| ChatGPT says file access is blocked | Path is outside `--root`, a secret file (`.env`, keys), or inside `.git/`. That's by design |
| Token leaked | Restart with `--rotate-token` and update the URL in ChatGPT |

## Optional — keep it running in the background (Linux, systemd user service)

```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/chatgpt-connector.service <<EOF
[Unit]
Description=ChatGPT Local Connector
After=network-online.target

[Service]
WorkingDirectory=%h/vinny-chatgpt-local-connector
ExecStart=$(command -v node) src/server.ts --root %h/code/my-project --funnel --allow-commands
Restart=on-failure

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now chatgpt-connector
journalctl --user -u chatgpt-connector -f      # shows the connector URL and tool calls
```

Adjust `WorkingDirectory` and `--root` to the user's paths.
