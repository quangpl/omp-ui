// Jupyter notebook (.ipynb, nbformat 4) parsing for the file viewer. Only safe outputs are kept:
// text, markdown, and base64 png/jpeg/gif images; svg/html/javascript outputs are dropped.

export type NotebookOutput =
  | { kind: "text"; text: string; error?: boolean }
  | { kind: "image"; mime: "image/png" | "image/jpeg" | "image/gif"; dataUrl: string }
  | { kind: "markdown"; text: string };

export interface NotebookCell {
  type: "markdown" | "code" | "raw";
  source: string;
  executionCount: number | null;
  outputs: NotebookOutput[];
}

/** A parsed notebook: kernel language (when declared) and its cells in order. */
export interface Notebook {
  language: string | null;
  cells: NotebookCell[];
}

/** nbformat 4 JSON as read from disk: every field is unverified, so `unknown` until checked. */
interface RawOutput {
  output_type?: unknown;
  text?: unknown;
  data?: unknown;
  ename?: unknown;
  evalue?: unknown;
  traceback?: unknown;
}
interface RawCell {
  cell_type?: unknown;
  source?: unknown;
  execution_count?: unknown;
  outputs?: unknown;
}
interface RawNotebook {
  cells?: unknown;
  metadata?: { language_info?: { name?: unknown } | null; kernelspec?: { language?: unknown } | null } | null;
}

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif"] as const;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** ANSI escape sequences: CSI (colors, cursor), OSC (titles, links), and other two-byte escapes. */
const ANSI = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?|${ESC}[@-_]?`, "g");

/** Text with ANSI escape sequences removed. */
function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** nbformat multiline strings: a string or an array of lines (each keeping its "\n"). */
function multiline(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part) => typeof part === "string").join("");
  return "";
}

/** The preview of one output from its MIME bundle: an image, else markdown, else plain text. */
function bundleOutput(data: Record<string, unknown>): NotebookOutput | null {
  for (const mime of IMAGE_MIMES) {
    const base64 = multiline(data[mime]).replace(/\s+/g, "");
    if (base64) return { kind: "image", mime, dataUrl: `data:${mime};base64,${base64}` };
  }
  const markdown = multiline(data["text/markdown"]);
  if (markdown) return { kind: "markdown", text: markdown };
  const plain = multiline(data["text/plain"]);
  if (plain) return { kind: "text", text: stripAnsi(plain) };
  return null;
}

function parseOutput(raw: RawOutput | null): NotebookOutput | null {
  if (typeof raw !== "object" || raw === null) return null;
  switch (raw.output_type) {
    case "stream": {
      const text = stripAnsi(multiline(raw.text));
      return text ? { kind: "text", text } : null;
    }
    case "execute_result":
    case "display_data":
      return typeof raw.data === "object" && raw.data !== null && !Array.isArray(raw.data)
        ? bundleOutput(raw.data as Record<string, unknown>)
        : null;
    case "error": {
      const ename = typeof raw.ename === "string" ? raw.ename : "Error";
      const evalue = typeof raw.evalue === "string" ? raw.evalue : "";
      const traceback = stripAnsi(
        Array.isArray(raw.traceback)
          ? raw.traceback.filter((line): line is string => typeof line === "string").join("\n")
          : "",
      );
      const summary = stripAnsi(evalue ? `${ename}: ${evalue}` : ename);
      // Jupyter tracebacks usually end with the summary line already; show it only once.
      const hasSummary = traceback.split("\n").some((line) => line.trim() === summary.trim());
      const text = !traceback.trim() ? summary : hasSummary ? traceback : `${summary}\n${traceback}`;
      return { kind: "text", text, error: true };
    }
    default:
      return null;
  }
}

function parseCell(raw: RawCell | null): NotebookCell | null {
  if (typeof raw !== "object" || raw === null) return null;
  const type = raw.cell_type === "markdown" || raw.cell_type === "code" ? raw.cell_type : "raw";
  const source = multiline(raw.source);
  if (type !== "code") return { type, source, executionCount: null, outputs: [] };
  const outputs = Array.isArray(raw.outputs)
    ? (raw.outputs as (RawOutput | null)[]).map(parseOutput).filter((output) => output !== null)
    : [];
  const executionCount = typeof raw.execution_count === "number" ? raw.execution_count : null;
  return { type, source, executionCount, outputs };
}

/**
 * Parse .ipynb JSON (nbformat 4; source/text may be string or string[]). Strips ANSI escapes from
 * tracebacks and streams. Throws Error("Invalid notebook: …") on invalid JSON or no cells array.
 */
export function parseNotebook(text: string): Notebook {
  let notebook: RawNotebook | null;
  try {
    notebook = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as RawNotebook | null;
  } catch {
    throw new Error("Invalid notebook: not valid JSON");
  }
  if (!Array.isArray(notebook?.cells)) throw new Error("Invalid notebook: no cells array");
  const languageName = notebook.metadata?.language_info?.name;
  const kernelLanguage = notebook.metadata?.kernelspec?.language;
  const language =
    (typeof languageName === "string" && languageName) || (typeof kernelLanguage === "string" && kernelLanguage) || null;
  const cells = (notebook.cells as (RawCell | null)[]).map(parseCell).filter((cell) => cell !== null);
  return { language, cells };
}
