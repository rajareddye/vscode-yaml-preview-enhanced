import * as vscode from 'vscode';
import type { ViewName } from './engine';
import { Config, SECTION, readConfig, toPlantUmlSettings } from './config';
import { Exporter } from './exporter';
import type { CustomFile, Platform } from './platform';
import { PreviewProvider } from './preview-provider';

/** Commands registered for internal use only (not in package.json). */
export const INTERNAL_COMMANDS = ['saveDiagramSvg'];

const posixRelative = (fromDir: string, to: string): string => {
  const a = fromDir.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) {
    i++;
  }
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
};

function activeYamlUri(provider: PreviewProvider, arg?: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  const doc = vscode.window.activeTextEditor?.document;
  return doc && provider.isYaml(doc) ? doc.uri : undefined;
}

async function toggleBoolean(key: keyof Config): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  await cfg.update(key, !cfg.get<boolean>(key), vscode.ConfigurationTarget.Global);
}

async function cycle(key: string, values: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const cur = cfg.get<string>(key, values[0]);
  const next = values[(values.indexOf(cur) + 1) % values.length];
  await cfg.update(key, next, vscode.ConfigurationTarget.Global);
  vscode.window.setStatusBarMessage(`YAML Preview: ${key} → ${next}`, 2500);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  provider: PreviewProvider,
  exporter: Exporter,
  platform: Platform,
): void {
  const reg = (name: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(`${SECTION}.${name}`, async (...args: unknown[]) => {
        try {
          return await fn(...args);
        } catch (e) {
          void vscode.window.showErrorMessage(
            `YAML Preview Enhanced: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );

  const needYaml = (arg?: unknown): vscode.Uri | undefined => {
    const uri = activeYamlUri(provider, arg);
    if (!uri) {
      void vscode.window.showWarningMessage('YAML Preview: open a YAML file first.');
    }
    return uri;
  };

  /* ---- opening ---- */
  reg('openPreviewToTheSide', async (arg?: unknown) => {
    const uri = needYaml(arg);
    if (uri) {
      await provider.open(uri, { side: true });
    }
  });
  reg('openPreview', async (arg?: unknown) => {
    const uri = needYaml(arg);
    if (uri) {
      await provider.open(uri, { side: false });
    }
  });
  reg('openLockedPreviewToTheSide', async (arg?: unknown) => {
    const uri = needYaml(arg);
    if (uri) {
      await provider.open(uri, { side: true, locked: true });
    }
  });
  reg('togglePreviewLock', () => {
    const locked = provider.toggleLock();
    if (locked === undefined) {
      void vscode.window.showInformationMessage('YAML Preview: there is no preview to lock.');
    } else {
      vscode.window.setStatusBarMessage(`YAML Preview: ${locked ? 'locked to this file' : 'follows the active editor'}`, 2500);
    }
  });
  reg('syncPreview', async () => {
    const p = provider.target();
    if (!p) {
      return;
    }
    await provider.refresh(p);
    const ed = vscode.window.activeTextEditor;
    if (ed) {
      provider.postTo(p, { command: 'revealLine', line: ed.selection.active.line + 1, mode: 'cursor' });
    }
  });

  /* ---- settings toggles ---- */
  reg('toggleScrollSync', () => toggleBoolean('scrollSync'));
  reg('toggleLiveUpdate', () => toggleBoolean('liveUpdate'));
  reg('toggleAutoTables', () => toggleBoolean('autoTables'));
  reg('toggleComments', () => toggleBoolean('showComments'));
  reg('toggleSortKeys', () => cycle('sortKeys', ['none', 'asc', 'desc']));
  reg('toggleMarkdownInStrings', () => cycle('renderMarkdownInStrings', ['off', 'byKey', 'all']));

  /* ---- source navigation ---- */
  reg('copyCurrentSourcePath', async () => {
    const p = provider.target();
    if (p) {
      const u = provider.sourceOf(p);
      await vscode.env.clipboard.writeText(u.scheme === 'file' ? u.fsPath : u.toString());
    }
  });
  reg('copyCurrentSourceRelativePath', async () => {
    const p = provider.target();
    if (p) {
      await vscode.env.clipboard.writeText(vscode.workspace.asRelativePath(provider.sourceOf(p)));
    }
  });
  const openSource = async (closePreview: boolean) => {
    const p = provider.target();
    if (!p) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(provider.sourceOf(p));
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    if (closePreview) {
      provider.closePreview(p);
    }
  };
  reg('openCurrentSourceInEditor', () => openSource(false));
  reg('openCurrentSourceInEditorAndClosePreview', () => openSource(true));

  /* ---- view & navigation inside the preview ---- */
  reg('setView', async () => {
    const p = provider.target();
    if (!p) {
      return;
    }
    const current = provider.getView(p);
    const items: Array<{ label: string; description: string; view: ViewName }> = [
      { label: 'Tree', description: 'Collapsible tree with types, anchors and comments', view: 'tree' },
      { label: 'Document', description: 'Titles, metadata, Markdown text and diagrams', view: 'document' },
      { label: 'JSON', description: 'Resolved JSON', view: 'json' },
      { label: 'Resolved', description: 'YAML with anchors expanded', view: 'resolved' },
    ];
    const pick = await vscode.window.showQuickPick(
      items.map((i) => ({ ...i, picked: i.view === current, label: `${i.view === current ? '$(check) ' : ''}${i.label}` })),
      { placeHolder: 'Select a preview view' },
    );
    if (pick) {
      await provider.setView(p, pick.view);
    }
  });
  reg('expandAll', () => provider.postTo(provider.target(), { command: 'expandAll' }));
  reg('collapseAll', () => provider.postTo(provider.target(), { command: 'collapseAll' }));
  reg('focusSearch', () => provider.postTo(provider.target(), { command: 'focusSearch' }));

  /* ---- schema ---- */
  reg('selectSchema', async (arg?: unknown) => {
    const uri = needYaml(arg);
    if (!uri) {
      return;
    }
    const BROWSE = '$(folder-opened) Browse…';
    const URL_ITEM = '$(link) Enter a URL…';
    const files = await vscode.workspace.findFiles(
      '{**/*schema*.json,**/*.schema.{json,yaml,yml}}',
      '**/{node_modules,.git}/**',
      200,
    );
    const items: Array<{ label: string; uri?: vscode.Uri }> = files
      .map((f) => ({ label: vscode.workspace.asRelativePath(f), uri: f }))
      .sort((a, b) => a.label.localeCompare(b.label));
    items.push({ label: BROWSE }, { label: URL_ITEM });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'JSON Schema for this file (inserted as a # yaml-language-server comment)',
    });
    if (!pick) {
      return;
    }
    let ref: string | undefined;
    if (pick.label === BROWSE) {
      const [f] = (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { Schema: ['json', 'yaml', 'yml'] } })) ?? [];
      if (f) {
        ref = f.scheme === 'file' && uri.scheme === 'file'
          ? posixRelative(uri.path.replace(/\/[^/]*$/, ''), f.path)
          : f.toString();
      }
    } else if (pick.label === URL_ITEM) {
      ref = await vscode.window.showInputBox({ prompt: 'Schema URL (loading remote schemas also needs "allowRemoteSchemas")', placeHolder: 'https://…' });
    } else if (pick.uri) {
      ref = posixRelative(uri.path.replace(/\/[^/]*$/, ''), pick.uri.path);
    }
    if (!ref) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const line = `# yaml-language-server: $schema=${ref}`;
    const edit = new vscode.WorkspaceEdit();
    let replaced = false;
    for (let i = 0; i < Math.min(doc.lineCount, 30); i++) {
      const t = doc.lineAt(i).text;
      if (/^#\s*yaml-language-server\s*:\s*\$schema\s*=/i.test(t)) {
        edit.replace(uri, doc.lineAt(i).range, line);
        replaced = true;
        break;
      }
      if (t.trim() !== '' && !t.startsWith('#') && t.trim() !== '---') {
        break;
      }
    }
    if (!replaced) {
      edit.insert(uri, new vscode.Position(0, 0), `${line}\n`);
    }
    await vscode.workspace.applyEdit(edit);
  });

  /* ---- copy / export ---- */
  reg('copyAsJson', (arg?: unknown) => exporter.copy('json', activeYamlUri(provider, arg)));
  reg('copyAsResolvedYaml', (arg?: unknown) => exporter.copy('resolvedYaml', activeYamlUri(provider, arg)));
  reg('exportHtml', (arg?: unknown) => exporter.run('html', activeYamlUri(provider, arg)));
  reg('exportPdf', (arg?: unknown) => exporter.run('pdf', activeYamlUri(provider, arg)));
  reg('exportPng', (arg?: unknown) => exporter.run('png', activeYamlUri(provider, arg)));
  reg('exportJpeg', (arg?: unknown) => exporter.run('jpeg', activeYamlUri(provider, arg)));
  reg('exportJson', (arg?: unknown) => exporter.run('json', activeYamlUri(provider, arg)));
  reg('exportResolvedYaml', (arg?: unknown) => exporter.run('resolvedYaml', activeYamlUri(provider, arg)));
  reg('exportMarkdown', (arg?: unknown) => exporter.run('markdown', activeYamlUri(provider, arg)));
  reg('openInBrowser', (arg?: unknown) => exporter.run('browser', activeYamlUri(provider, arg)));
  reg('export', async (arg?: unknown) => {
    const kinds = Exporter.KINDS.filter((k) => !(k.desktopOnly && platform.isWeb));
    const pick = await vscode.window.showQuickPick(
      // NB: not `kind` — that is QuickPickItem's own (separator) property.
      kinds.map((k) => ({ label: k.label, description: k.description, exportKind: k.kind })),
      { placeHolder: 'Export this YAML file as…' },
    );
    if (pick) {
      await exporter.run(pick.exportKind, activeYamlUri(provider, arg));
    }
  });
  reg('saveDiagramSvg', (hash: string) => exporter.saveDiagramSvg(hash));

  /* ---- PlantUML ---- */
  reg('clearDiagramCache', async () => {
    await provider.refreshDiagrams();
    vscode.window.setStatusBarMessage('YAML Preview: re-rendering diagrams…', 2500);
  });
  reg('testPlantUml', async () => {
    const cfg = await provider.effectiveConfig();
    const settings = toPlantUmlSettings(cfg);
    const probe = await platform.diagrams.probe(settings);
    if (!probe.ok) {
      const open = 'Open Settings';
      const c = await vscode.window.showErrorMessage(`PlantUML is not set up: ${probe.message}`, open);
      if (c === open) {
        await vscode.commands.executeCommand('workbench.action.openSettings', `${SECTION}.plantuml`);
      }
      return;
    }
    const r = await platform.diagrams.render('@startuml\nAlice -> Bob: test\n@enduml', settings);
    if (r.svg && !r.warning) {
      void vscode.window.showInformationMessage(
        `PlantUML works: ${probe.message} — jar ${cfg.plantumlJarPath}, security profile ${cfg.plantumlSecurityProfile}.`,
      );
    } else {
      void vscode.window.showErrorMessage(`PlantUML started but could not draw a diagram: ${r.error ?? r.warning ?? 'unknown error'}`);
    }
  });

  /* ---- customisation files ---- */
  const custom = (name: string, scope: 'global' | 'workspace', file: CustomFile) =>
    reg(name, async () => platform.customization.openFile(scope, file, readConfig()));
  custom('customizeCss', 'global', 'style.css');
  custom('customizeCssInWorkspace', 'workspace', 'style.css');
  custom('openConfigScript', 'global', 'config.js');
  custom('openConfigScriptInWorkspace', 'workspace', 'config.js');
  custom('extendParser', 'global', 'parser.js');
  custom('extendParserInWorkspace', 'workspace', 'parser.js');
  custom('customizePreviewHtmlHead', 'global', 'head.html');
  custom('customizePreviewHtmlHeadInWorkspace', 'workspace', 'head.html');
}
