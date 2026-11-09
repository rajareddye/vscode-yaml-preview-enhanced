# Agent Instructions for vscode-yaml-preview-enhanced

This file provides context for AI coding agents (GitHub Copilot, Claude, etc.) working in this repository.

## Project Overview

This is the **VS Code extension** yaml-preview-enhanced-r. It previews `.yaml` / `.yml` files in a webview: a collapsible tree, a readable document view (Markdown text and inline PlantUML diagrams), resolved JSON / YAML views, JSON Schema validation and export. It is derived from [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced) but no longer depends on crossnote — YAML is parsed with [`yaml`](https://eemeli.org/yaml/), text is rendered with `markdown-it`, schemas are validated with `ajv`, and PlantUML runs through a local `plantuml.jar`.

User-facing behavior is documented in [README.md](README.md); keep it in sync with `package.json` and `package.nls.json` when you add or change commands, settings or keybindings.

## Architecture

### Extension host (`src/`)

- **`extension.ts`** — Desktop entry point (Node.js): plugs in local Java, Chrome and the filesystem
- **`extension-web.ts`** — Web entry point (VS Code for the Web): plugs in stubs
- **`extension-common.ts`** — Shared activation: provider, exporter, commands, custom editor, editor associations
- **`platform.ts`** — Interfaces for everything that differs between desktop and web (`DiagramService`, `Customization`, `nativeExport`)
- **`preview-provider.ts`** — Webview panels, custom editor, live update, scroll sync, diagnostics and the message protocol with the webview
- **`commands.ts`** — Registers every `yaml-preview-enhanced.*` command
- **`config.ts`** — Reads VS Code settings into a typed `Config`; `DEFAULTS` must match `package.json` (enforced by `test/manifest.test.js`)
- **`editor-associations.ts`** — Maps YAML files to the preview editor in `Previews Only` mode
- **`schema-loader.ts`** — Chooses and loads the JSON Schema (modeline → `schemas` → `schema`), including opt-in remote schemas
- **`exporter.ts`** — HTML, PDF, PNG, JPEG, JSON, resolved YAML and Markdown export
- **`chrome-export.ts`** — PDF / image export through a local Chrome driven by `puppeteer-core`
- **`plantuml-runner.ts`** — Spawns `java -jar plantuml.jar -pipe -tsvg`; no `vscode` import, so it is unit-tested against a real jar
- **`diagram-service.ts`**, **`diagram-service-web.ts`** — Native and web implementations of `DiagramService`
- **`customization.ts`**, **`customization-web.ts`** — `style.css`, `head.html`, `config.js`, `parser.js`
- **`test-entry.ts`** — Exposes the wiring to the integration tests only

### Engine (`src/engine/`)

Pure TypeScript with **no `vscode` import and no Node built-ins**, so it runs in the desktop host, the web host, the webview bundle and the unit tests.

- **`parse.ts`** — YAML → `ParsedYaml` (nodes, anchors, comments, issues)
- **`render.ts`** — Tree, Document, JSON and Resolved views, outline, masking, key sorting
- **`schema.ts`** — Ajv compilation and validation
- **`plantuml.ts`** — Finds diagrams in strings, hashes them, builds the diagram HTML
- **`markdown.ts`**, **`text.ts`** — Markdown, linkify and image-reference helpers
- **`page.ts`**, **`styles.ts`** — Page shell, toolbar and themes
- **`export.ts`** — JSON, resolved YAML and Markdown export
- **`types.ts`** — Shared types and default options

### Webview (`src/webview/preview.ts`)

The client script for the preview and for exported HTML: search, expand / collapse, context menu, lightbox, zen mode and keyboard shortcuts. It is bundled separately and must not import from the extension host.

### Build (`build.js`)

esbuild bundles these targets: `src/extension.ts` → `out/native/extension.js`, `src/extension-web.ts` → `out/web/extension.js`, `src/webview/preview.ts` → `out/webview/preview.js`, plus test bundles in `out/engine/`, `out/host/`, `out/plantuml-runner/` and `out/chrome-export/`. `vscode` is always external. Use `node build.js --production` for a minified build.

## Key Conventions

### Code Style

- **Single quotes** everywhere (Prettier-enforced)
- **TypeScript**: `strict: true` — no implicit `any`
- Package manager: **pnpm** (not npm or yarn), pinned via the `packageManager` field in `package.json`
- **nix shell**: the dev environment is provided by `flake.nix` → `shell.nix`. With direnv (`use flake` in `.envrc`) the tools are available automatically; otherwise prefix commands with `nix develop -c` (e.g. `nix develop -c pnpm build`).
- Keep the engine pure: anything that needs `vscode`, `fs`, `child_process` or `os` belongs in the host (`src/*.ts`) behind the `Platform` interface.
- Documentation, comments, UI strings and user-facing text are **English only**.

### Runtime Support

- **`engines.vscode` is `^1.82.0`** — VS Code 1.82 is the first release whose extension host runs Node 18 (Electron 25 → Node 18.15.0). Older VS Codes run Node 16.
- **Development and CI run Node 18** — a green run on Node 20+ proves nothing for the VS Code versions the extension supports. Both `shell.nix` and the GitHub workflows follow [`.tool-versions`](.tool-versions) (18.17.1); keep them on the same major version. Dev-only tools must stay Node-18-loadable too: eslint is held at the 9.x line and lint-staged at 15.x.
- **`vsce` needs Node 20** — every released line fails to load on Node 18 (its bundled undici references the `File` global at load), so run `pnpm package` and any publishing step on Node 20 while everything gating the extension itself stays on 18.
- The native bundle targets `node18`; the web bundle must never load Node-only modules (`fs`, `child_process`, `os`, `path`, `module`) or `puppeteer-core` — `test/manifest.test.js` checks this.

### Build & Lint

- Build: `pnpm build`
- Lint: `pnpm check:all` (ESLint + Prettier + tsc)
- Fix: `pnpm fix:all`
- Watch mode (for extension dev): `pnpm watch`
- Package: `pnpm package` (writes `yaml-preview-enhanced-r-<version>.vsix`; run on Node 20)

Prettier also checks Markdown, so run `pnpm fix:prettier` (or `pnpm exec prettier --write README.md AGENTS.md`) after editing documentation.

## Testing

- Run tests: `pnpm test` (builds, then runs the mocha tests in `test/`); `pnpm test:unit` runs them against the existing `out/` bundles.
- `test/vscode-stub.js` and `test/host-helpers.js` provide a fake `vscode` module so the host code can be tested without VS Code.
- `test/plantuml-runner.test.js` also runs against a real PlantUML jar (`PLANTUML_JAR`, default `/usr/local/bin/plantuml.jar`, plus `java` on the `PATH`); those tests are skipped when either is missing.
- For manual testing, press **F5** in VS Code to launch the Extension Development Host. After changing `build.js` or `src/`, run `pnpm build` and reload it (`Developer: Reload Window`). Try it on `examples/requirements.yaml`.

## Adding New Settings

1. Add the setting to `package.json` under `contributes.configuration`, with its description in `package.nls.json` (`yaml-preview-enhanced.<name>.markdownDescription`)
2. Add it to the `Config` interface and to `DEFAULTS` in `src/config.ts` (the default must equal the one in `package.json`)
3. Read it wherever it is used — usually `preview-provider.ts`, which maps `Config` to the engine's `RenderOptions`
4. If it points at an executable, a script or the network, make it `"scope": "machine"` and list it under `capabilities.untrustedWorkspaces.restrictedConfigurations`
5. Document it in the matching table in [README.md](README.md#settings)

## Adding New Commands

1. Declare the command in `package.json` (`contributes.commands`, plus `menus` and `keybindings` when needed) with its title in `package.nls.json`
2. Register it in `src/commands.ts`; commands that only make sense on desktop get `"enablement": "!isWeb"`
3. Add it to the table in [README.md](README.md#commands)

`test/manifest.test.js` fails when a declared command is not registered, or the other way round.
