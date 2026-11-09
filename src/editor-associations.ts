import type { PreviewMode } from './config';

export type Associations = Record<string, string>;

/**
 * Compute the `workbench.editorAssociations` value for a preview mode.
 *
 *  - **Previews Only**: every YAML pattern opens in the preview editor
 *    (unless the user already mapped that pattern to some *other* editor).
 *  - any other mode: the entries this extension added are removed again.
 *
 * Returns the new map, or `undefined` when nothing needs to change (so the
 * caller does not rewrite the user's settings needlessly). The legacy array
 * format is left alone.
 */
export function computeEditorAssociations(
  existing: unknown,
  mode: PreviewMode,
  viewType: string,
  extensions: string[],
): Associations | undefined {
  if (existing !== undefined && existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) {
    return undefined;
  }
  const current: Associations = { ...((existing as Associations | undefined) ?? {}) };
  const patterns = extensions.map((e) => `*${e.startsWith('.') ? e : '.' + e}`);
  let changed = false;

  if (mode === 'Previews Only') {
    for (const p of patterns) {
      if (current[p] === undefined) {
        current[p] = viewType;
        changed = true;
      }
    }
  } else {
    // Only undo what we add ourselves: a user's own mapping such as
    // "docs/*.yaml" → this editor is left untouched.
    for (const p of patterns) {
      if (current[p] === viewType) {
        delete current[p];
        changed = true;
      }
    }
  }
  return changed ? current : undefined;
}
