<h1 align="center"> YAML Preview Enhanced </h1>

<p align="center">
  <img src="media/icon.png" alt="YAML Preview Enhanced" width="128">
</p>

<p align="center">
  A live, searchable preview for YAML files in VS Code — a collapsible tree, a readable document view with Markdown and inline PlantUML diagrams, JSON Schema validation, themes and export.
</p>

<div align="center">

[VS Code](https://code.visualstudio.com) · [VS Code for the Web](https://vscode.dev)

</div>

## Introduction

YAML Preview Enhanced brings the [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced) experience to `.yaml` and `.yml` files. Open a preview next to your editor and the extension:

- shows the file as a **collapsible tree** with types, anchors, aliases, comments, line numbers and automatic tables;
- reads it as a **document** — titles become headings, `metadata` collapses, text is rendered as Markdown and **PlantUML diagrams are drawn inline**;
- converts it to **JSON** or **resolved YAML** (anchors, aliases and merge keys expanded);
- **validates** it against a JSON Schema and lists YAML and schema problems;
- keeps the editor and the preview **in sync** as you type, scroll and click;
- **exports** to HTML, PDF, PNG, JPEG, JSON, resolved YAML and Markdown.

It works for plain YAML and for the formats built on it: Kubernetes, OpenAPI, Docker Compose, GitHub Actions, Ansible, Azure Pipelines, Home Assistant, CloudFormation and more.

## Requirements

| Feature                         | Needs                                                         |
| ------------------------------- | ------------------------------------------------------------- |
| Preview, search, schema, export | VS Code 1.82 or later (desktop or web)                        |
| Inline PlantUML diagrams        | Desktop VS Code, Java and a local `plantuml.jar`              |
| PDF, PNG and JPEG export        | Desktop VS Code and Google Chrome, Chromium or Microsoft Edge |
| Remote JSON Schemas (opt-in)    | Network access and `yaml-preview-enhanced.allowRemoteSchemas` |

## Installation

Install the packaged extension from a `.vsix` file:

```sh
code --install-extension yaml-preview-enhanced-vscode-0.1.2.vsix
```

Or in VS Code: **Extensions** view → **…** menu → **Install from VSIX…**.

To build the `.vsix` yourself, see [Development](#development).

## Getting Started

1. Open a YAML file (`.yaml` or `.yml`).
2. Open the preview — it does **not** start on its own unless you turn on `automaticallyShowPreviewOfYamlBeingEdited`. Use any of these:
   - press <kbd>ctrl-k v</kbd> (<kbd>cmd-k v</kbd> on macOS) to open the preview to the side;
   - click the preview icon in the editor title bar;
   - right-click the editor and choose **YAML Preview Enhanced: Open Preview to the Side**;
   - run **YAML Preview Enhanced: Open Preview** from the Command Palette.
3. Pick a view in the preview toolbar: **Tree**, **Document**, **JSON** or **Resolved**.

To open every YAML file straight into the preview instead of a text editor, set `yaml-preview-enhanced.previewMode` to **Previews Only**. You can also choose **Reopen Editor With… → YAML Preview** for a single file.

Try it on [examples/requirements.yaml](examples/requirements.yaml): open it, switch to the **Document** view, and the requirement text and the sequence diagram are rendered inline.

## Views

| View         | What it shows                                                                                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tree**     | A collapsible tree. Anchors (`&name`) and tags are shown as chips, aliases (`*name`) link to their anchor, comments sit beside the node they annotate, and lists of similar records become tables. |
| **Document** | The file read as a document: headings, collapsed metadata, Markdown text and inline diagrams. See [Document view](#document-view).                                                                 |
| **JSON**     | The document converted to JSON, with anchors and merge keys resolved.                                                                                                                              |
| **Resolved** | Round-tripped YAML with anchors, aliases and merge keys expanded.                                                                                                                                  |

The toolbar also offers **Expand**, **Collapse**, an expand-to-level selector, a search box, and the toggles **Tables**, **Comments**, **Sort** (none → A→Z → Z→A) and **MD** (Markdown rendering in strings: off → by key → all). A status area shows the node count and the number of problems and warnings; click it to jump to the first problem. Files with several `---` separated documents get one tab per document.

Everything the preview does is display-only — **your file is never modified**, except when you explicitly run **Associate JSON Schema…**, which inserts a `# yaml-language-server: $schema=…` comment.

### Document view

The Document view turns a data file into something you can read. Which keys play which role is configurable.

| Role     | Default keys                                                                                                                           | Rendered as                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Title    | `id`, `title`, `name`, `heading`, `label`                                                                                              | The heading of the block (first match wins)                                               |
| Metadata | `metadata`, `meta`, `attributes`, `properties`, `info`                                                                                 | A collapsed `<Kind> metadata` section; `<Kind>` comes from a sibling `type` or `kind` key |
| Text     | `text`, `description`, `content`, `body`, `statement`, `rationale`, `summary`, `details`, `notes`, `comment`, `message`, `requirement` | Markdown prose, without a label                                                           |
| Flatten  | `content`, `children`, `items`, `sections`, `blocks`, `elements`, `entries`                                                            | Children shown directly, without a heading for the key itself                             |

Everything else is shown as `key  value` lines, sub-headings or tables. Settings: `documentTitleKeys`, `documentMetadataKeys`, `documentTextKeys`, `documentFlattenKeys`.

```yaml
- id: req:user-login
  type: requirement
  metadata:
    status: approved
    owner: web-team
  text: |
    A registered user shall be able to sign in with an e-mail address and a password.
```

## Inline PlantUML Diagrams

PlantUML diagrams are rendered **locally** with `java -jar plantuml.jar -pipe -tsvg`. A diagram can appear:

- as an `@startuml … @enduml` block (or any `@start<kind> … @end<kind>`, such as `mindmap`, `gantt`, `salt`, `wbs`) inside a string value;
- as a ` ```plantuml ` (or `puml`, `uml`) fence inside Markdown text;
- as the value of a key listed in `plantumlKeys` (default `plantuml`, `puml`, `uml`) — `@startuml` and `@enduml` are added for you.

```yaml
- title: Sign-in flow
  plantuml: |
    @startuml
    actor User
    participant "Web App" as App
    User -> App: submit(email, password)
    App --> User: show dashboard
    @enduml
```

### Setup

1. Install Java and download [`plantuml.jar`](https://plantuml.com/download).
2. Set `yaml-preview-enhanced.plantumlJarPath` to the jar (default `/usr/local/bin/plantuml.jar`). If `java` is not on your `PATH`, also set `yaml-preview-enhanced.javaPath`.
3. Run **YAML Preview Enhanced: Test PlantUML Setup** to confirm it works.

Diagrams are cached, rendered in parallel (a bounded number at a time) and stopped if they exceed `plantumlTimeoutMs`. Run **Clear PlantUML Cache and Refresh Diagrams** after changing PlantUML settings or the jar. Right-click a diagram to enlarge it, copy its source or save it as SVG.

### Security

A YAML file you open may be untrusted, so diagrams run with `PLANTUML_SECURITY_PROFILE=SANDBOX` by default: they cannot read local files or use the network. The bundled standard library (`!include <C4/…>`) still works. Change `plantumlSecurityProfile` to `INTERNET`, `LEGACY` or `UNSECURE` only if your diagrams `!include` other files.

Diagrams are displayed as images, so a diagram cannot run scripts in the preview. The Java and PlantUML settings are machine-scoped and are ignored in untrusted workspaces. PlantUML is not available in VS Code for the Web.

## JSON Schema Validation

Schema problems are listed in the preview, flagged on the offending nodes and, with `publishDiagnostics`, shown in the **Problems** panel. A schema is chosen in this order:

1. A modeline comment in the file: `# yaml-language-server: $schema=./schemas/ci.json`
2. The `yaml-preview-enhanced.schemas` map of schema path → glob pattern(s), for example `{ "schemas/ci.json": ".github/workflows/*.yml" }`
3. The single `yaml-preview-enhanced.schema` setting

Schemas may be JSON or YAML, and relative paths resolve against the file (modeline) or the workspace folder (settings). Drafts 2020-12, 2019-09 and 07 are supported, with standard string formats; a schema that declares an older draft is validated on a best-effort basis. Run **YAML Preview Enhanced: Associate JSON Schema…** to pick a schema and insert the modeline for you.

Previewing a file never makes a network request by itself: `http(s)://` schemas are downloaded only after you enable `yaml-preview-enhanced.allowRemoteSchemas`.

## Search and Navigation

- **Search** keys and values with the toolbar box (<kbd>/</kbd>); step through matches with <kbd>enter</kbd> / <kbd>shift-enter</kbd>.
- The **outline** sidebar lists the top-level keys (or the titled blocks in the Document view) and every anchor with the number of aliases that use it.
- **Click a line number** or **double-click a node** to reveal its source line in the editor; clicking a problem jumps to it.
- **Scroll sync** keeps the editor and the preview aligned in both directions (`scrollSync`). **Sync Preview with Editor** re-aligns them on demand.
- A **locked preview** stays on one file while you edit others.
- Right-click inside the preview for a context menu: copy the path, JSONPath, JSON pointer or the value as JSON or YAML, reveal in the editor, expand or collapse children, work with diagrams, and export.

### Keys inside the preview

| Key                                       | Action                                     |
| ----------------------------------------- | ------------------------------------------ |
| <kbd>/</kbd>                              | Focus the search box                       |
| <kbd>enter</kbd> / <kbd>shift-enter</kbd> | Next / previous match (in the search box)  |
| <kbd>n</kbd> / <kbd>shift-n</kbd>         | Next / previous match                      |
| <kbd>e</kbd> / <kbd>c</kbd>               | Expand all / collapse all                  |
| <kbd>1</kbd> – <kbd>9</kbd>               | Expand the tree to that level              |
| <kbd>z</kbd>                              | Toggle zen mode (hide toolbar and outline) |
| <kbd>esc</kbd>                            | Clear the search, close menus and images   |

## Hiding Sensitive Values

List regular expressions in `yaml-preview-enhanced.maskKeys` and the values of every matching key are replaced with `••••••` in the preview **and** in exports — handy when sharing your screen:

```json
{ "yaml-preview-enhanced.maskKeys": ["password", "secret", "token"] }
```

Matching is case-insensitive.

## Markdown, Links and Images

- Set `renderMarkdownInStrings` to `byKey` (only the keys in `markdownKeys`, such as `description`) or `all` (every multi-line string) to render Markdown inside string values. The Document view always renders its text keys as Markdown.
- URLs in strings become links (`enableLinkify`). Only the protocols in `protocolsWhiteList` can be opened from the preview.
- String values that point to images show thumbnails (`imagePreview`): `local` (default) loads workspace images only, `all` also loads remote `https://` images, `off` disables thumbnails. Click a thumbnail to enlarge it.

## Exporting

Run **YAML Preview Enhanced: Export…** (or use the right-click menu in the preview) and choose a format:

| Format              | Description                                                                  |
| ------------------- | ---------------------------------------------------------------------------- |
| **HTML**            | A self-contained, interactive page with every view and the diagrams embedded |
| **PDF**             | Print-ready output of the current view, through Chrome (desktop only)        |
| **PNG / JPEG**      | A full-page image of the current view, through Chrome (desktop only)         |
| **JSON**            | The document with anchors and merge keys resolved                            |
| **Resolved YAML**   | Anchors, aliases and merge keys expanded                                     |
| **Markdown**        | Headings, lists and tables                                                   |
| **Open in browser** | Opens the exported HTML from a temporary file (desktop only)                 |

**Copy Document as JSON** and **Copy Document as Resolved YAML** put the result on the clipboard instead. Masked keys stay masked and key sorting is applied in every export.

PDF and image export drive a locally installed Chrome, Chromium or Edge (found automatically; or set `chromePath`). Inside a container you may need `"yaml-preview-enhanced.chromeArgs": ["--no-sandbox"]`. Use `printBackground` to keep background colours in PDFs and `exportColorScheme` to choose between the selected theme and the viewer's light/dark preference.

## Customization

Besides settings, the preview can be customised with four files. **Global** files live in the config directory (`yaml-preview-enhanced.configPath`; by default `~/.local/state/yaml-preview-enhanced`, or `%USERPROFILE%\.yaml-preview-enhanced` on Windows) and always apply. **Workspace** files live in `<workspace>/.yaml-preview-enhanced/` and apply on top of them.

| File        | Purpose                                                                                                                                                          | Runs code |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `style.css` | Extra CSS for the preview and exports (theme colours are CSS variables)                                                                                          | No        |
| `head.html` | Extra `<head>` markup, for example `<link>` or `<meta>` (scripts are blocked in the live preview by its Content-Security-Policy, but not in exported HTML files) | No        |
| `config.js` | Overrides for any setting; export an object or a function                                                                                                        | Yes       |
| `parser.js` | `onWillParseYaml(text)` and `onDidParseYaml(html)` hooks                                                                                                         | Yes       |

Use the **Customize CSS**, **Open Config Script**, **Extend Parser** and **Customize Preview HTML Head** commands (each in a Global and a Workspace variant) to create and open the files from templates.

`config.js` and `parser.js` execute code. Global ones always run; **workspace** ones run only in a **trusted** workspace **and** when `yaml-preview-enhanced.enableScriptExecution` is on. Customization files are not available in VS Code for the Web.

## Commands

All commands are in the Command Palette under **YAML Preview Enhanced**.

| Command                                                                          | Description                                                   |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Open Preview to the Side / Open Preview                                          | Open the preview beside the editor or in the current group    |
| Open Locked Preview to the Side / Toggle Preview Lock                            | Pin a preview to one file                                     |
| Sync Preview with Editor                                                         | Align the preview with the editor position                    |
| Toggle Scroll Sync / Toggle Live Update                                          | Switch the setting on or off                                  |
| Select View (Tree / Document / JSON / Resolved)…                                 | Change the active preview's view                              |
| Expand All / Collapse All / Search in Preview                                    | Control the active preview                                    |
| Toggle Auto Tables / Toggle Comments                                             | Switch the setting on or off                                  |
| Cycle Key Sorting / Cycle Markdown Rendering in Strings                          | Step through the option values                                |
| Associate JSON Schema…                                                           | Insert a `# yaml-language-server: $schema=…` comment          |
| Copy Document as JSON / Copy Document as Resolved YAML                           | Copy to the clipboard                                         |
| Export… and Export as HTML / PDF / PNG / JPEG / JSON / Resolved YAML / Markdown  | Export the document                                           |
| Open in Browser                                                                  | Open the exported HTML in your browser (desktop only)         |
| Copy Current Source Path / Relative Path                                         | Copy the previewed file's path                                |
| Open Current Source in Editor (and Close Preview)                                | Jump back to the text editor                                  |
| Test PlantUML Setup                                                              | Check Java, the jar and the security profile                  |
| Clear PlantUML Cache and Refresh Diagrams                                        | Re-render every diagram                                       |
| Customize CSS / Open Config Script / Extend Parser / Customize Preview HTML Head | Create and open the customization files (Global or Workspace) |

## Keybindings

> The <kbd>cmd</kbd> key for _Windows_ and _Linux_ is <kbd>ctrl</kbd>. These shortcuts are active in YAML editors (`yaml`, `dockercompose`, `github-actions-workflow`, `ansible`, `azure-pipelines` and `home-assistant` language modes).

| Shortcuts                                                      | Functionality                   |
| -------------------------------------------------------------- | ------------------------------- |
| <kbd>cmd-k v</kbd> or <kbd>ctrl-k v</kbd>                      | Open preview to the Side        |
| <kbd>cmd-shift-v</kbd> or <kbd>ctrl-shift-v</kbd>              | Open preview                    |
| <kbd>cmd-k shift-l</kbd> or <kbd>ctrl-k shift-l</kbd>          | Open locked preview to the Side |
| <kbd>cmd-k cmd-shift-l</kbd> or <kbd>ctrl-k ctrl-shift-l</kbd> | Toggle preview lock             |
| <kbd>cmd-shift-s</kbd> or <kbd>ctrl-shift-s</kbd>              | Sync preview with editor        |

## Settings

All settings start with `yaml-preview-enhanced.`. Open **Settings** and search for _YAML Preview Enhanced_ to edit them with descriptions.

### Preview behavior

| Setting                                     | Default                    | Description                                                                                                                             |
| ------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `previewMode`                               | `Single Preview`           | `Single Preview` (one panel follows the active editor), `Multiple Previews` (one per file) or `Previews Only` (YAML opens as a preview) |
| `scrollSync`                                | `true`                     | Keep the editor and preview scrolled together; clicking a node reveals its line                                                         |
| `liveUpdate`                                | `true`                     | Refresh while typing; when off, refresh on save                                                                                         |
| `liveUpdateDebounceMs`                      | `300`                      | Delay between the last keystroke and a refresh                                                                                          |
| `automaticallyShowPreviewOfYamlBeingEdited` | `false`                    | Open a preview to the side when a YAML file is opened                                                                                   |
| `disableAutoPreviewForUriSchemes`           | `["vscode-notebook-cell"]` | URI schemes that never get an automatic preview                                                                                         |
| `disableAutoPreviewForFilePatterns`         | `[]`                       | Glob patterns that never get an automatic preview                                                                                       |
| `yamlFileExtensions`                        | `[".yaml", ".yml"]`        | Extensions treated as YAML (used by `Previews Only`)                                                                                    |
| `maxFileSize`                               | `5242880`                  | Largest file (bytes) rendered; `0` removes the limit                                                                                    |

### Appearance

| Setting                        | Default                | Description                                                                                                             |
| ------------------------------ | ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `previewColorScheme`           | `selectedPreviewTheme` | Take colours from `previewTheme`, the operating system (`systemColorScheme`) or the VS Code theme (`editorColorScheme`) |
| `previewTheme`                 | `github-light`         | `github-light`, `github-dark`, `one-light`, `one-dark`, `solarized-light`, `solarized-dark`, `monokai`, `dracula`       |
| `defaultView`                  | `tree`                 | View shown when a preview opens: `tree`, `document`, `json` or `resolved`                                               |
| `defaultExpandDepth`           | `4`                    | Tree levels expanded on open (`0` collapses everything, `99` expands everything)                                        |
| `showComments`                 | `true`                 | Show YAML comments beside their nodes                                                                                   |
| `showLineNumbers`              | `true`                 | Show source line numbers in the tree                                                                                    |
| `showTypeBadges`               | `false`                | Show a type badge (`str`, `int`, `bool`, …) after every scalar                                                          |
| `autoTables`                   | `true`                 | Render lists of similar records as tables                                                                               |
| `sortKeys`                     | `none`                 | Sort mapping keys for display: `none`, `asc` or `desc`                                                                  |
| `maskKeys`                     | `[]`                   | Case-insensitive regular expressions of keys whose values are masked                                                    |
| `enablePreviewZenMode`         | `true`                 | Allow <kbd>z</kbd> to hide the toolbar and outline                                                                      |
| `enablePreviewContextMenu`     | `true`                 | Show the custom right-click menu in the preview                                                                         |
| `useVSCodeThemeForContextMenu` | `false`                | Style that menu with the VS Code theme                                                                                  |

### Text, links and images

| Setting                   | Default                                                                                                                                       | Description                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `renderMarkdownInStrings` | `off`                                                                                                                                         | Render Markdown in multi-line strings: `off`, `byKey` or `all`               |
| `markdownKeys`            | `description`, `summary`, `notes`, `readme`, `body`, `details`, `text`, `content`, `message`, `help`, `doc`, `docs`, `documentation`, `about` | Keys rendered as Markdown when `renderMarkdownInStrings` is `byKey`          |
| `breakOnSingleNewLine`    | `false`                                                                                                                                       | Turn a single newline into a line break in rendered Markdown                 |
| `enableTypographer`       | `false`                                                                                                                                       | Smart quotes and typographic replacements in rendered Markdown               |
| `enableLinkify`           | `true`                                                                                                                                        | Turn URLs in strings into links                                              |
| `protocolsWhiteList`      | `http://, https://, mailto:, tel:`                                                                                                            | Protocols that may be opened from the preview                                |
| `imagePreview`            | `local`                                                                                                                                       | Thumbnails for image paths: `off`, `local` or `all` (also remote `https://`) |
| `enableImageLightbox`     | `true`                                                                                                                                        | Click a thumbnail to enlarge it                                              |

### Document view

| Setting                | Default                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `documentTitleKeys`    | `id`, `title`, `name`, `heading`, `label`                                                                                              |
| `documentMetadataKeys` | `metadata`, `meta`, `attributes`, `properties`, `info`                                                                                 |
| `documentTextKeys`     | `text`, `description`, `content`, `body`, `statement`, `rationale`, `summary`, `details`, `notes`, `comment`, `message`, `requirement` |
| `documentFlattenKeys`  | `content`, `children`, `items`, `sections`, `blocks`, `elements`, `entries`                                                            |

### PlantUML

| Setting                   | Default                       | Description                                                        |
| ------------------------- | ----------------------------- | ------------------------------------------------------------------ |
| `plantumlEnabled`         | `true`                        | Render inline PlantUML diagrams                                    |
| `plantumlJarPath`         | `/usr/local/bin/plantuml.jar` | Path to `plantuml.jar`                                             |
| `javaPath`                | `java`                        | Java executable                                                    |
| `plantumlSecurityProfile` | `SANDBOX`                     | `SANDBOX`, `INTERNET`, `LEGACY` or `UNSECURE`                      |
| `plantumlTimeoutMs`       | `30000`                       | Maximum time for one diagram (1000–300000)                         |
| `plantumlArgs`            | `[]`                          | Extra command-line arguments, for example `["-theme", "cerulean"]` |
| `plantumlKeys`            | `plantuml`, `puml`, `uml`     | Keys whose string value is PlantUML source                         |

### YAML parsing and schema

| Setting                    | Default | Description                                                                                         |
| -------------------------- | ------- | --------------------------------------------------------------------------------------------------- |
| `yamlVersion`              | `1.2`   | `1.1` treats `yes`/`no`/`on`/`off` as booleans and understands timestamps and sexagesimal numbers   |
| `maxAliasCount`            | `100`   | Maximum alias dereferences when resolving (guards against "billion laughs"); `-1` removes the limit |
| `uniqueKeys`               | `true`  | Report duplicate mapping keys as errors                                                             |
| `ignoreUnknownTagWarnings` | `true`  | Do not warn about custom tags such as `!Ref`, `!Sub` or `!vault`                                    |
| `schema`                   | `""`    | JSON Schema applied to every previewed file                                                         |
| `schemas`                  | `{}`    | Map of schema path → glob pattern(s)                                                                |
| `allowRemoteSchemas`       | `false` | Allow downloading `http(s)://` schemas                                                              |
| `publishDiagnostics`       | `false` | Also list YAML and schema problems in the Problems panel                                            |

### Export and customization

| Setting                 | Default | Description                                                      |
| ----------------------- | ------- | ---------------------------------------------------------------- |
| `printBackground`       | `false` | Include background colours in PDF export                         |
| `exportColorScheme`     | `theme` | `theme` (selected preview theme) or `auto` (viewer's preference) |
| `chromePath`            | `""`    | Chrome, Chromium or Edge executable; detected when empty         |
| `chromeArgs`            | `[]`    | Extra Chrome arguments, for example `["--no-sandbox"]`           |
| `configPath`            | `""`    | Directory of the global customization files                      |
| `enableScriptExecution` | `false` | Allow workspace-level `config.js` and `parser.js` to run         |

## Privacy and Security

**This extension does not collect, transmit or share your data.** There is no telemetry, no tracking and no phone-home.

- **YAML content** is parsed and rendered locally and never leaves your machine.
- **PlantUML** runs locally through your own Java and `plantuml.jar`; no diagram data is sent to any server. Diagrams run in the `SANDBOX` security profile by default.
- **JSON Schemas** are read from disk. Remote schemas are downloaded only if you enable `allowRemoteSchemas`.
- **Images**: only local images are loaded by default. Remote `https://` images are requested only if you set `imagePreview` to `all`.
- **PDF / image export** uses a locally installed Chrome; nothing is uploaded.
- The preview runs under a strict **Content-Security-Policy** that only allows the extension's own script.
- **Untrusted workspaces**: settings that point to executables or scripts (`plantumlJarPath`, `javaPath`, `plantumlArgs`, `plantumlSecurityProfile`, `chromePath`, `chromeArgs`, `configPath`, `enableScriptExecution`, `allowRemoteSchemas`) are ignored, and workspace-level scripts never run.
- **Virtual workspaces** and **VS Code for the Web**: the preview, schema validation and the HTML, JSON, resolved YAML and Markdown exports work. PlantUML, PDF / PNG / JPEG export, _Open in Browser_ and customization files need the desktop version.

If you have questions about data handling, please open an issue in this repository.

## Development

The extension is written in TypeScript and bundled with esbuild. Package management uses **pnpm**; Node 18 matches the runtime of the VS Code extension host. See [AGENTS.md](AGENTS.md) for architecture notes and conventions.

```sh
pnpm install            # install dependencies
pnpm build              # bundle to out/ (desktop, web and webview)
pnpm watch              # rebuild on change
pnpm test               # build, then run the mocha tests in test/
pnpm check:all          # ESLint, Prettier and tsc
pnpm package            # create yaml-preview-enhanced-vscode-<version>.vsix (vsce needs Node 20)
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the extension loaded. After a change, run `pnpm build` and reload that window (**Developer: Reload Window**).

## Acknowledgements

YAML Preview Enhanced is derived from [Markdown Preview Enhanced](https://github.com/shd101wyy/vscode-markdown-preview-enhanced) by Yiyi Wang and contributors, and keeps its familiar commands, keybindings and settings style. Many thanks to the authors.

## License

[University of Illinois/NCSA Open Source License](LICENSE.md)
