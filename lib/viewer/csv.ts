// Delimited text (CSV/TSV) parsing for the file viewer's table preview. Pure TS: runs in the
// browser and in Node tests.

/** Rows parsed when the caller doesn't say otherwise. */
const DEFAULT_MAX_ROWS = 5000;

/**
 * RFC 4180 parse: quoted fields, doubled quotes inside them, CR/LF/CRLF line ends, newlines inside
 * quotes. A UTF-8 BOM is stripped and one trailing empty line dropped. `delimiter` defaults to ","
 * (callers pass "\t" for .tsv files). At most `maxRows` rows (default 5000); `truncated` when the
 * text has more.
 */
export function parseDelimited(
  text: string,
  options?: { delimiter?: string; maxRows?: number },
): { rows: string[][]; truncated: boolean } {
  const delimiter = options?.delimiter || ",";
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Whether the current row consumed any character (so an empty last line isn't a row).
  let started = false;
  let i = 0;

  /** Ends the current row; false once the row limit is hit. */
  const endRow = (): boolean => {
    if (rows.length >= maxRows) return false;
    row.push(field);
    rows.push(row);
    row = [];
    field = "";
    started = false;
    return true;
  };

  while (i < source.length) {
    const ch = source[i];
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      started = true;
      i += 1;
    } else if (source.startsWith(delimiter, i)) {
      row.push(field);
      field = "";
      started = true;
      i += delimiter.length;
    } else if (ch === "\r" || ch === "\n") {
      if (!endRow()) return { rows, truncated: true };
      i += ch === "\r" && source[i + 1] === "\n" ? 2 : 1;
    } else {
      field += ch;
      started = true;
      i += 1;
    }
  }
  if (started && !endRow()) return { rows, truncated: true };
  return { rows, truncated: false };
}
