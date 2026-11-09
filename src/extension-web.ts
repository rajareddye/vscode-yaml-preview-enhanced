import type * as vscode from 'vscode';
import { WebCustomization } from './customization-web';
import { WebDiagramService } from './diagram-service-web';
import { activateCommon } from './extension-common';
import type { Platform } from './platform';

/** Web extension host (vscode.dev, github.dev): no processes, no Node APIs. */
export function activate(context: vscode.ExtensionContext): void {
  const platform: Platform = {
    isWeb: true,
    diagrams: new WebDiagramService(),
    customization: new WebCustomization(),
  };
  activateCommon(context, platform);
}

export function deactivate(): void {}
