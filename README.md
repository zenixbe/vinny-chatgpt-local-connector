<img src="assets/icon.svg" width="64" height="64" alt="">

# ChatGPT Local Connector

Geef ChatGPT (web) rechtstreeks toegang tot **één lokale projectmap**, zodat je niet meer hoeft te copy-pasten.
ChatGPT kan bestanden lezen, zoeken, aanpassen, en (optioneel) tests/builds draaien. Het houdt zelf een
projectgeheugen en een beslissingslog bij in je repo, zodat een volgend gesprek verder kan waar het vorige stopte.

Technisch is het een [MCP](https://modelcontextprotocol.io)-server (Streamable HTTP) die je als custom connector
toevoegt in ChatGPT, publiek bereikbaar gemaakt via **Tailscale Funnel**.

```
ChatGPT (servers van OpenAI) ──https──▶ Tailscale Funnel ──▶ 127.0.0.1:8787/mcp/<token> ──▶ jouw projectmap
```

> **Snel opzetten met een AI-assistent:** geef [`LLM_SETUP.md`](LLM_SETUP.md) aan ChatGPT/Claude/... en zeg
> *"Help me dit op te zetten"*. Die begeleidt je stap voor stap met de juiste terminalcommando's voor jouw OS.

```bash
git clone https://github.com/zenixbe/vinny-chatgpt-local-connector.git
cd vinny-chatgpt-local-connector && npm install
```

## Tools die ChatGPT krijgt

| Tool | Wat |
|---|---|
| `project_overview` | Bestandsboom, git-status, AGENTS.md/README, projectgeheugen + beslissingen. Wordt als eerste aangeroepen. |
| `list_directory`, `read_file`, `search` | Verkennen (search = ripgrep, respecteert `.gitignore`) |
| `edit_file`, `write_file`, `move_path`, `delete_path` | Wijzigen (edits zijn exacte find/replace, alles-of-niets) |
| `update_notes` | Herschrijft `.chatgpt/notes.md`: status, volgende stappen, conventies |
| `log_decision` | Voegt een beslissing toe aan `.chatgpt/decisions.md` (datum, waarom, alternatieven) |
| `run_command` | Shell-commando in de projectmap. **Alleen met `--allow-commands`** |

`.chatgpt/` staat in je project, dus je kunt het mee committen of in `.gitignore` zetten.

## Beveiliging

- Alles zit opgesloten in `--root`: `../`, absolute paden en symlinks naar buiten worden geweigerd.
- `.env`, `*.pem`, `*.key`, SSH-sleutels, `.npmrc`, ... zijn geblokkeerd (tenzij `--allow-secrets`).
- Schrijven in `.git/` is geblokkeerd.
- De server luistert alleen op `127.0.0.1`. Publiek bereikbaar is hij alleen via de tunnel, en enkel op
  `/mcp/<token>` met een willekeurige token van 256 bits (`~/.config/chatgpt-local-connector/token`).
  **Behandel de connector-URL als een wachtwoord.** Een nieuwe token maak je met `--rotate-token`.
- Elke tool-aanroep wordt in je terminal gelogd.
- `--allow-commands` geeft ChatGPT in feite een shell met jouw rechten. Gebruik het bewust, en het liefst op een
  git-repo waarin je alles kunt terugdraaien.

## Installatie

Vereist: Node.js ≥ 23.6 (draait TypeScript rechtstreeks, zonder build-stap) en `ripgrep`.

```bash
npm install
npm test
```

### Tailscale Funnel (eenmalig)

Funnel is nodig en niet gewoon `tailscale serve`, want ChatGPT belt aan vanaf de servers van OpenAI en
die zitten niet in jouw tailnet.

```bash
sudo pacman -S tailscale
sudo systemctl enable --now tailscaled
sudo tailscale up
sudo tailscale set --operator=$USER    # zodat je funnel zonder sudo kunt starten
```

Zet in de [Tailscale admin console](https://login.tailscale.com/admin/dns) **MagicDNS** en **HTTPS-certificaten** aan.
De eerste keer dat je `tailscale funnel` draait, krijg je een link om Funnel voor dit toestel te activeren.

Je krijgt een vaste URL zoals `https://laptop.tail1234.ts.net`, dus je hoeft de connector maar één keer
in ChatGPT te registreren.

## Starten

```bash
node src/server.ts --root ~/code/mijn-project --funnel --allow-commands
```

De output toont de connector-URL:

```
 Connector-URL voor ChatGPT (geheim houden!):
   https://laptop.tail1234.ts.net/mcp/3q2…x9
```

Andere opties: `--read-only`, `--port 8787`, `--cloudflared` (alternatief zonder Tailscale; de URL wisselt dan bij
elke start), `--help`.

Tip: kies als `--root` een map met al je projecten, dan kan ChatGPT er zelf tussen navigeren.
Wil je het strakker houden, dan start je per project een connector.

## Koppelen in ChatGPT (eenmalig)

1. **Settings → Apps & Connectors → Advanced settings** → zet **Developer mode** aan.
2. **Create** (nieuwe connector): geef hem een naam (bv. "Lokaal project"), plak de connector-URL en kies
   **Authentication: No authentication**. De token in de URL is de beveiliging.
3. Open in een nieuw gesprek het **+**-menu → **Developer mode** en kies je connector.
4. Vraag bijvoorbeeld: *"Bekijk het project, zoek waarom de login-test faalt, los het op en draai de tests."*

ChatGPT vraagt standaard om bevestiging bij schrijfacties. Leestools zijn gemarkeerd als read-only en lopen zonder
bevestiging.

> De menunamen in ChatGPT veranderen af en toe. Zoek bij twijfel naar "Developer mode" of "Connectors" in de instellingen.

## Ontwikkelen

```bash
npm run typecheck
npm test            # end-to-end: start de server en praat ermee via een echte MCP-client
```

Code: [`src/server.ts`](src/server.ts) (HTTP, token, tunnels), [`src/tools.ts`](src/tools.ts) (tools),
[`src/sandbox.ts`](src/sandbox.ts) (padbeveiliging).
