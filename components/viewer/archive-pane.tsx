"use client";

// Contents listing of zip-family and tar/tar.gz archives: a summary, a path filter, and a table
// of entries with sizes and dates. Listing only; extracting means downloading the archive.
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { FolderIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  KIND_ICON,
  MAX_BINARY_BYTES,
  PaneSkeleton,
  ViewerFallback,
  WithFileBytes,
  attachmentKind,
  formatSize,
  type PaneProps,
} from "@/components/viewer/common";
import { listTar } from "@/lib/viewer/tar";
import { openZip, type ArchiveEntry } from "@/lib/viewer/zip";

/** Rows rendered at most; the filter narrows the rest. */
const MAX_ROWS = 2000;

const TGZ_NAME = /\.(tgz|tar\.gz)$/i;
const TAR_NAME = /\.tar$/i;
const ZIP_NAME = /\.(zip|jar|war|ear|apk|whl|nupkg|vsix|xpi|crx)$/i;

interface Listing {
  entries: ArchiveEntry[];
  /** The tar reader stopped at its entry cap. */
  truncated: boolean;
}

type ListingState = { status: "loading" } | { status: "ready"; listing: Listing } | { status: "error"; message: string };

/** Archive format from the file name, or from its magic bytes when the name doesn't say. */
function archiveFormat(name: string, bytes: Uint8Array): "zip" | "tar" | "tgz" {
  if (TGZ_NAME.test(name)) return "tgz";
  if (TAR_NAME.test(name)) return "tar";
  if (ZIP_NAME.test(name)) return "zip";
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6))) {
    return "zip";
  }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return "tgz";
  if (String.fromCharCode(...bytes.subarray(257, 262)) === "ustar") return "tar";
  return "zip";
}

async function listArchive(name: string, bytes: Uint8Array): Promise<Listing> {
  const format = archiveFormat(name, bytes);
  if (format === "zip") return { entries: openZip(bytes).entries, truncated: false };
  return listTar(bytes, { gzip: format === "tgz" });
}

/** Archive (.zip family, .tar, .tar.gz/.tgz): its file list. */
export function ArchivePane(props: PaneProps) {
  return (
    <WithFileBytes {...props} limit={MAX_BINARY_BYTES}>
      {(bytes) => <ArchiveListing {...props} bytes={bytes} />}
    </WithFileBytes>
  );
}

function ArchiveListing({ attachment, download, bytes }: PaneProps & { bytes: Uint8Array }) {
  const [state, setState] = useState<ListingState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const listing = await listArchive(attachment.name, bytes);
        if (!cancelled) setState({ status: "ready", listing });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attachment.name, bytes]);

  if (state.status === "loading") return <PaneSkeleton />;
  if (state.status === "error") {
    return (
      <ViewerFallback
        attachment={attachment}
        download={download}
        message={`Couldn't read this archive: ${state.message}`}
      />
    );
  }
  return <ArchiveTable listing={state.listing} download={download} />;
}

function ArchiveTable({ listing, download }: { listing: Listing; download: string }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);

  const { sorted, files, folders, total } = useMemo(() => {
    const { compare } = new Intl.Collator(undefined, { numeric: true });
    const sorted = [...listing.entries].sort((a, b) => compare(a.name, b.name));
    // Folders: explicit directory entries plus every parent path of a file (zips often omit them).
    const dirs = new Set<string>();
    let files = 0;
    let total = 0;
    for (const entry of sorted) {
      const path = entry.directory ? entry.name.replace(/\/+$/, "") : entry.name;
      if (entry.directory) {
        if (path) dirs.add(path);
      } else {
        files++;
        total += entry.size;
      }
      for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
        dirs.add(path.slice(0, slash));
      }
    }
    return { sorted, files, folders: dirs.size, total };
  }, [listing.entries]);

  const needle = deferredQuery.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? sorted.filter((entry) => entry.name.toLowerCase().includes(needle)) : sorted),
    [sorted, needle],
  );
  const rows = matches.slice(0, MAX_ROWS);

  return (
    <div className="flex size-full flex-col overflow-hidden bg-background">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground tabular-nums">
          {files === 1 ? "1 file" : `${files.toLocaleString()} files`} ·{" "}
          {folders === 1 ? "1 folder" : `${folders.toLocaleString()} folders`} · {formatSize(total)} total
          (uncompressed)
        </p>
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter files"
          aria-label="Filter files"
          className="h-11 w-full sm:w-64 md:h-8"
        />
      </div>
      <div
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        {listing.truncated && (
          <p className="border-b bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground">
            Very large archive: only the first {listing.entries.length.toLocaleString()} entries were read.
          </p>
        )}
        {sorted.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">This archive is empty.</p>
        ) : matches.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No files match “{deferredQuery.trim()}”.</p>
        ) : (
          <table className="w-full border-separate border-spacing-0 text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th scope="col" className="sticky top-0 z-10 border-b bg-background px-3 py-1.5 font-medium">
                  Name
                </th>
                <th scope="col" className="sticky top-0 z-10 border-b bg-background px-3 py-1.5 text-right font-medium">
                  Size
                </th>
                <th
                  scope="col"
                  className="sticky top-0 z-10 border-b bg-background px-3 py-1.5 font-medium max-md:hidden"
                >
                  Modified
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry, i) => (
                // Archives can repeat a path, so names aren't unique keys.
                <EntryRow key={i} entry={entry} />
              ))}
            </tbody>
          </table>
        )}
        {matches.length > MAX_ROWS && (
          <p className="px-3 py-2 text-center text-xs text-muted-foreground">
            Showing first {MAX_ROWS.toLocaleString()} of {matches.length.toLocaleString()} entries — refine the filter
          </p>
        )}
      </div>
      <p className="shrink-0 border-t px-3 py-1.5 text-xs text-muted-foreground">
        <a href={download} download="" className="underline underline-offset-2 hover:text-foreground">
          Download
        </a>{" "}
        the archive to extract files.
      </p>
    </div>
  );
}

function EntryRow({ entry }: { entry: ArchiveEntry }) {
  const path = entry.directory ? entry.name.replace(/\/+$/, "") : entry.name;
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const Icon = entry.directory ? FolderIcon : KIND_ICON[attachmentKind({ url: "", name: base })];
  const modified = entry.modifiedAt && !Number.isNaN(entry.modifiedAt.getTime()) ? entry.modifiedAt : null;
  return (
    <tr className="hover:bg-muted/50">
      <td className="border-b px-3 py-1.5">
        <span className="flex min-w-0 items-start gap-2">
          <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]" title={entry.name}>
            {dir && <span className="text-muted-foreground">{dir}</span>}
            {base}
            {entry.directory && "/"}
          </span>
        </span>
      </td>
      <td className="border-b px-3 py-1.5 text-right whitespace-nowrap text-muted-foreground tabular-nums">
        {entry.directory ? "—" : formatSize(entry.size)}
      </td>
      <td className="border-b px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular-nums max-md:hidden">
        {modified ? modified.toLocaleString() : "—"}
      </td>
    </tr>
  );
}
