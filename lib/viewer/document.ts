// Shared document model for the in-app file viewer: Word, PowerPoint and EPUB parsers
// (lib/viewer/office.ts) reduce their content to these blocks, and `DocumentBlocks`
// (components/viewer/document-blocks.tsx) renders them as React elements. Pure types; no DOM.

/** A span of text with uniform formatting. */
export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** Monospace / inline code. */
  code?: boolean;
  /** Link target; only ever an http(s) or mailto URL (never javascript: or relative paths). */
  href?: string;
}

/** One block of a document, in reading order. */
export type DocBlock =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Run[] }
  | { kind: "paragraph"; runs: Run[] }
  /** `level` is the 0-based nesting depth. */
  | { kind: "list-item"; ordered: boolean; level: number; runs: Run[] }
  /** rows -> cells -> runs. */
  | { kind: "table"; rows: Run[][][] }
  | { kind: "code"; text: string }
  /** Placeholder for an embedded picture; no image data is extracted. */
  | { kind: "image"; alt: string }
  | { kind: "rule" };
