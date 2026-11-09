import * as vscode from 'vscode';
import { SECTION, readConfig } from './config';
import { registerCommands } from './commands';
import { computeEditorAssociations } from './editor-associations';
import { Exporter } from './exporter';
import type { Platform } from './platform';
import { PreviewProvider, VIEW_TYPE_EDITOR } from './preview-provider';

/** In "Previews Only" mode YAML files open in the preview editor. */
async function syncEditorAssociations(): Promise<void> {
  const cfg = readConfig();
  const wb = vscode.workspace.getConfiguration('workbench');
  const next = computeEditorAssociations(
    wb.get('editorAssociations'),
    cfg.previewMode,
    VIEW_TYPE_EDITOR,
    cfg.yamlFileExtensions,
  );
  if (next) {
    await wb.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
  }
}

/** Activation shared by the desktop and the web extension hosts. */
export function activateCommon(context: vscode.ExtensionContext, platform: Platform): PreviewProvider {
  const provider = new PreviewProvider(context, platform);
  const exporter = new Exporter(context, provider, platform);
  registerCommands(context, provider, exporter, platform);

  context.subscriptions.push(
    provider,
    { dispose: () => platform.diagrams.dispose() },
    vscode.window.registerCustomEditorProvider(
      VIEW_TYPE_EDITOR,
      {
        resolveCustomTextEditor: (document, webviewPanel) =>
          provider.adoptCustomEditor(webviewPanel, document),
      },
      { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: true },
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${SECTION}.previewMode`) ||
        e.affectsConfiguration(`${SECTION}.yamlFileExtensions`)
      ) {
        void syncEditorAssociations();
      }
    }),
  );

  void syncEditorAssociations();
  void provider.onActiveEditor(vscode.window.activeTextEditor);
  return provider;
}
