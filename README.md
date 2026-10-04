<img src="assets/icon.png" width="96" alt="Affinity app icon">

# Affinity Codex Plugin

Connect Codex to Affinity by Canva's native local MCP server for document inspection, vector and photo editing, page layouts, previews, reusable scripts, and a guided native-file handoff and refresh workflow for Cavalry.

This independent community plugin forwards Affinity's own MCP tools through a local SSE-to-stdio adapter. It includes a workflow skill, a global installer, and a harmless connection check. No cloud server or API key is needed for the local connection.

## Affinity to Cavalry handoff

Open and save a current `.af` document, then open the destination composition in Cavalry. Ask Codex to **“Plan an Affinity to Cavalry handoff for my open document.”** The plugin adds five tools:

| Tool | Action |
| --- | --- |
| `codex_affinity_handoff_plan` | Read-only inspection of the active Affinity document, saved file, and Cavalry composition. Returns a ten-minute plan ID. |
| `codex_affinity_handoff_stage` | Rechecks the document, saved file, and composition, then loads the native Affinity file into Cavalry's Assets window. |
| `codex_affinity_refresh_plan` | Finds the one Cavalry asset linked to the saved Affinity file and returns a ten-minute refresh plan. |
| `codex_affinity_refresh_apply` | Rechecks the source, file, asset, and composition, then requests a native asset reload in place. |
| `codex_affinity_visual_compare` | Returns labeled Affinity and Cavalry previews in one response, for the full scene or a chosen layer and frame. |

The default `asset` mode lets you drag the staged asset into Cavalry and choose **Separate Layers** in Cavalry's native dialog. The optional `single_layer` mode requests one footage layer through scripting; verify its render before using it. In our live Affinity 3.3.0/Cavalry 2.8.0 test, that scripted footage layer showed a blank image even though Affinity rendered colored artwork. Cavalry's scripting API does not expose the native **Separate Layers** dialog choice as a script argument, so the guided handoff keeps that choice in Cavalry's UI.

Save changes in Affinity before planning. The handoff does not save or alter the source document. It refuses to stage if the source document, saved file, or active Cavalry composition changes after planning. Existing Cavalry assets with the exact same path are reused. After import, inspect the layers and save the Cavalry scene. Re-save older Affinity files in the current version if Cavalry warns that they lack stable layer IDs for per-layer updates.

For later edits, save the `.af` file, ask Codex to plan and apply a refresh, then compare the previews. A completed reload confirms that Cavalry accepted `reloadAsset` and retained the same asset and composition layer IDs; it does **not** guarantee that the visible art changed. In our live test, Affinity's image changed while Cavalry's scripted footage preview remained unchanged, including after a short delay. Check the Cavalry view before saving. Cavalry documents that adding or removing Affinity layers after a **Separate Layers** import does not add or remove those Cavalry scene layers on reload; reimport the asset into the composition for structural changes. [Cavalry Affinity Asset documentation](https://cavalry.studio/docs/user-interface/menus/window-menu/assets-window/affinity-asset/).

Keep both apps open with their MCP servers enabled. Cavalry defaults to port **6768**; set `CAVALRY_MCP_PORT` for a different port. The handoff connects only to the local Cavalry server when a handoff tool runs.

## Requirements

- macOS with a version of Affinity by Canva that includes the native MCP server, installed and open with that server enabled. Initially tested with Affinity 3.3.0.
- Node.js 20 or newer and npm.
- Python 3 and a recent Codex CLI with `codex plugin add`, available on PATH.
- Codex desktop for the plugin UI.

## Install globally

```sh
git clone https://github.com/ebuberpg-prog/affinity-codex-plugin.git
cd affinity-codex-plugin
npm ci --ignore-scripts
python3 scripts/install-global.py
```

The installer copies the package and dependencies into `~/plugins/affinity`, adds it to the existing personal marketplace at `~/.agents/plugins/marketplace.json`, and installs/enables `affinity@personal`. Other marketplace entries are preserved, and a timestamped catalog backup is saved before updating it. Git history, environment files, and logs are excluded from the installed copy.

Restart Codex and open a new chat. Keep Affinity open and its MCP server enabled. The default port is **6767**.

Try: **“Use Affinity to inspect my open document.”**

## Verify and update

```sh
npm run check
npm test
npm run verify
```

`npm test` checks handoff and refresh planning, stale-file protection, preview output, and script construction without opening either app. `npm run verify` performs the native handshake, discovers tools, reads the SDK preamble, and executes only `console.log`. It does not edit documents. The native app initially exposed 11 tools; this plugin adds five workflow tools.

For updates:

```sh
git pull --ff-only
npm ci --ignore-scripts
python3 scripts/install-global.py
```

Restart Codex afterward. For local development, edit this checkout, check the connection, and rerun the installer to refresh the global copy. `node_modules` is ignored by Git and installed from the lockfile.

## Connection and workflow

The adapter connects to `http://127.0.0.1:6767/sse` by default. To use a different app port, pass `AFFINITY_MCP_PORT` in the MCP process environment. For a command-line verification, use `AFFINITY_MCP_PORT=YOUR_PORT npm run verify`. The optional handoff connects to Cavalry at `127.0.0.1:6768` unless `CAVALRY_MCP_PORT` is set.

Native tool definitions, messages, results, and application instructions pass through without rewriting them. The five `codex_affinity_*` workflow tools are handled by the local adapter. The skill reads the native SDK preamble before scripting, uses current API documentation, preserves selection when changing spreads, and verifies edits through native previews.

Affinity may restrict SDK filesystem, network, or AI operations in its settings. `NOT_ALLOWED` results should be handled within those restrictions. Its SDK documents filesystem access as limited to Desktop. The plugin does not change application permissions.

The server also exposes optional global hint-search and issue-reporting tools. The skill requires explicit authorization before reporting issues, publishing hints, or sending private document/script content to those services. The local transport itself does not upload documents or transmit telemetry.

## Package contents

- `.codex-plugin/plugin.json`: plugin identity, icon, and skill/MCP declarations.
- `.mcp.json`: local transport launch configuration.
- `scripts/bridge.mjs`: transport adapter using the pinned official MCP SDK.
- `scripts/handoff-tools.mjs`: planned Affinity-to-Cavalry native-file handoff, refresh, and visual comparison.
- `scripts/handoff-tools.test.mjs`: offline handoff checks.
- `scripts/install-global.py`: personal marketplace installer.
- `scripts/verify.mjs`: non-mutating smoke check.
- `skills/affinity/SKILL.md`: Affinity workflow guidance.

The package follows [OpenAI's plugin format](https://developers.openai.com/plugins/build/plugins). For the native integration, see [Affinity's integrations page](https://www.affinity.studio/integrations). Plugin code and authored documentation are MIT-licensed. The native app icon is excluded; see [NOTICE.md](NOTICE.md).
