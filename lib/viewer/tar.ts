// Read-only tar (and tar.gz) listing for the file viewer. Headers are read straight from the (optionally
// gunzipped) byte stream and entry data is skipped, so a large .tgz never has to sit fully decompressed in
// memory. Pure TS (no DOM APIs) so it runs in the browser and in Node tests.
import type { ArchiveEntry } from "./zip";

const BLOCK = 512;

const utf8 = new TextDecoder("utf-8");

/** Sequential byte source: `read` returns fewer than `length` bytes only at the end of the data. */
interface ByteSource {
  read(length: number): Promise<Uint8Array>;
  skip(length: number): Promise<void>;
  close(): Promise<void>;
}

/** Source over bytes already in memory. */
function bytesSource(bytes: Uint8Array): ByteSource {
  let position = 0;
  return {
    async read(length) {
      const chunk = bytes.subarray(position, position + length);
      position += chunk.length;
      return chunk;
    },
    async skip(length) {
      position = Math.min(bytes.length, position + length);
    },
    async close() {},
  };
}

/** Source pulling chunks from a stream (the gzip decompressor) as the parser advances. */
function streamSource(stream: ReadableStream<Uint8Array>): ByteSource {
  const reader = stream.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let position = 0;
  let done = false;

  /** Ensure unread bytes are buffered; false once the stream is exhausted. */
  async function fill(): Promise<boolean> {
    while (position >= chunk.length) {
      if (done) return false;
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Couldn't decompress gzip data: ${reason}`);
      }
      if (result.done) {
        done = true;
        return false;
      }
      chunk = result.value;
      position = 0;
    }
    return true;
  }

  return {
    async read(length) {
      if (!(await fill())) return new Uint8Array(0);
      if (chunk.length - position >= length) {
        const out = chunk.subarray(position, position + length);
        position += length;
        return out;
      }
      const out = new Uint8Array(length);
      let filled = 0;
      while (filled < length && (await fill())) {
        const take = Math.min(length - filled, chunk.length - position);
        out.set(chunk.subarray(position, position + take), filled);
        position += take;
        filled += take;
      }
      return out.subarray(0, filled);
    },
    async skip(length) {
      let remaining = length;
      while (remaining > 0 && (await fill())) {
        const take = Math.min(remaining, chunk.length - position);
        position += take;
        remaining -= take;
      }
    },
    async close() {
      if (!done) await reader.cancel().catch(() => {});
    },
  };
}

/** NUL-terminated string field. */
function field(header: Uint8Array, offset: number, length: number): string {
  const raw = header.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return utf8.decode(end < 0 ? raw : raw.subarray(0, end));
}

/** Numeric field: octal text, or GNU base-256 (high bit set) for values that don't fit. NaN when empty/invalid. */
function numeric(header: Uint8Array, offset: number, length: number): number {
  const first = header[offset];
  if (first & 0x80) {
    if (first === 0xff) return NaN; // negative values are meaningless for sizes/times
    let value = first & 0x7f;
    for (let index = offset + 1; index < offset + length; index++) value = value * 256 + header[index];
    return value;
  }
  const text = field(header, offset, length).trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : NaN;
}

/** Header checksum: sum of all bytes with the checksum field itself read as spaces. */
function checksumMatches(header: Uint8Array): boolean {
  const expected = numeric(header, 148, 8);
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum === expected;
}

/** pax extended header records: "<length> <key>=<value>\n", length counted in bytes. */
function parsePax(data: Uint8Array): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    let space = position;
    while (space < data.length && data[space] !== 0x20) space++;
    const length = parseInt(utf8.decode(data.subarray(position, space)), 10);
    if (!(length > 0) || position + length > data.length) break;
    const record = utf8.decode(data.subarray(space + 1, position + length - 1));
    const equals = record.indexOf("=");
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1));
    position += length;
  }
  return records;
}

/** List a tar archive (optionally gzip-compressed: `gzip: true`, decompress with DecompressionStream("gzip")).
 *  Supports ustar prefix, GNU long names (type 'L'), pax headers (path=, size=). Stops after `maxEntries` (default 10000) and reports `truncated`. */
export async function listTar(
  bytes: Uint8Array,
  options?: { gzip?: boolean; maxEntries?: number },
): Promise<{ entries: ArchiveEntry[]; truncated: boolean }> {
  const maxEntries = options?.maxEntries ?? 10000;
  const source = options?.gzip
    ? streamSource(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")))
    : bytesSource(bytes);
  const entries: ArchiveEntry[] = [];
  let truncated = false;
  // Overrides carried from GNU long-name / pax pseudo-entries to the entry that follows them.
  let longName: string | null = null;
  let pax = new Map<string, string>();

  try {
    for (let offset = 0; ; offset += BLOCK) {
      const header = await source.read(BLOCK);
      if (header.length < BLOCK) {
        if (offset === 0) throw new Error("Not a tar archive");
        break; // archives missing their end-of-archive blocks
      }
      if (header.every((byte) => byte === 0)) break; // end-of-archive marker
      if (!checksumMatches(header)) {
        throw new Error(offset === 0 ? "Not a tar archive" : `Corrupt tar header at offset ${offset}`);
      }

      const type = String.fromCharCode(header[156]);
      const headerSize = numeric(header, 124, 12);
      if (type === "L" || type === "x") {
        const size = Number.isFinite(headerSize) ? headerSize : 0;
        const padded = Math.ceil(size / BLOCK) * BLOCK;
        const data = (await source.read(padded)).subarray(0, size);
        if (type === "L") {
          const end = data.indexOf(0);
          longName = utf8.decode(end < 0 ? data : data.subarray(0, end));
        } else {
          pax = parsePax(data);
        }
        offset += padded;
        continue;
      }

      // Links, devices, directories and FIFOs carry no data whatever their size field says.
      const dataless = "123456".includes(type);
      const paxSize = pax.has("size") ? Number(pax.get("size")) : NaN;
      const size = dataless
        ? 0
        : Number.isFinite(paxSize) && paxSize >= 0
          ? paxSize
          : Number.isFinite(headerSize)
            ? headerSize
            : 0;
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      await source.skip(padded);
      offset += padded;
      // Global pax headers, GNU long link names and volume labels describe no entry of their own.
      if (type === "g" || type === "K" || type === "V") continue;

      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      let name = pax.get("path") ?? longName;
      if (name === null || name === undefined) {
        name = field(header, 0, 100);
        // POSIX ustar ("ustar\0") stores long paths split across prefix + name; GNU reuses that area.
        if (field(header, 257, 6) === "ustar") {
          const prefix = field(header, 345, 155);
          if (prefix) name = `${prefix}/${name}`;
        }
      }
      const directory = type === "5" || type === "D" || name.endsWith("/");
      if (directory && !name.endsWith("/")) name += "/";
      const paxTime = pax.has("mtime") ? Number(pax.get("mtime")) : NaN;
      const mtime = Number.isFinite(paxTime) ? paxTime : numeric(header, 136, 12);
      entries.push({
        name,
        directory,
        size: directory ? 0 : size,
        modifiedAt: Number.isFinite(mtime) && mtime > 0 ? new Date(mtime * 1000) : null,
      });
      longName = null;
      pax = new Map();
    }
  } finally {
    await source.close();
  }
  return { entries, truncated };
}
