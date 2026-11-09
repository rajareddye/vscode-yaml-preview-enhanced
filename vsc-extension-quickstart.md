# yaml-preview-enhanced-r — Developer Quickstart

## What's in the folder

- `package.json` — the extension manifest: commands, settings, keybindings, menus and the custom editor. Display strings live in `package.nls.json`.
- `src/extension.ts` and `src/extension-web.ts` — the desktop and web entry points; both call `activateCommon` in `src/extension-common.ts`.
- `src/engine/` — the pure YAML engine (parsing, rendering, schema validation, PlantUML helpers) shared by the extension host, the webview and the tests.
- `src/webview/preview.ts` — the script that runs inside the preview.
- `test/` — mocha tests; `test/vscode-stub.js` replaces the `vscode` module.
- `examples/requirements.yaml` — a sample file for trying the Document view and inline PlantUML.

See [AGENTS.md](AGENTS.md) for the full architecture and conventions.

## Get up and running

- run `pnpm install` and then `pnpm build`
- press `F5` to open a new window with the extension loaded
- open `examples/requirements.yaml`, then run **yaml-preview-enhanced-r: Open Preview to the Side** from the Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P` on Mac)
- for diagrams, set `yaml-preview-enhanced.plantumlJarPath` and run **yaml-preview-enhanced-r: Test PlantUML Setup**
- set breakpoints in the TypeScript sources to debug the extension host; use **Developer: Open Webview Developer Tools** to debug the preview

## Make changes

- run `pnpm watch` to rebuild on every change
- reload the window (`Ctrl+R` or `Cmd+R` on Mac) in the Extension Development Host to load your changes

## Run tests

- `pnpm test` builds the bundles and runs every `test/**/*.test.js` file
- `pnpm test:unit` runs the tests without rebuilding
- `pnpm check:all` runs ESLint, Prettier and the TypeScript compiler

## Package

- `pnpm package` creates `yaml-preview-enhanced-vscode-<version>.vsix` (needs Node 20 for `vsce`)
- install it with `code --install-extension yaml-preview-enhanced-vscode-<version>.vsix`
