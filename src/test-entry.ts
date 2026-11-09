/**
 * Bundled to `out/host/index.js` for the integration tests only: exposes the
 * pieces that `extension.ts` wires together so tests can inject fakes.
 */
export { activateCommon } from './extension-common';
export { NativeCustomization } from './customization';
export { NativeDiagramService } from './diagram-service';
export { WebDiagramService } from './diagram-service-web';
export { WebCustomization } from './customization-web';
export { computeEditorAssociations } from './editor-associations';
export { DEFAULTS, applyOverrides, readConfig } from './config';
export { INTERNAL_COMMANDS } from './commands';
export { PreviewProvider } from './preview-provider';
export { clearSchemaCache } from './schema-loader';
