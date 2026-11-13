// Minimal read-only zip reader for the file viewer: lists the central directory and inflates single
// entries on demand. Pure TS (no DOM APIs) so it runs in the browser and in Node tests.

export interface ArchiveEntry {
  /** Path inside the archive, "/"-separated; directories end with "/". */
  name: string;
  directory: boolean;
  /** Uncompressed size in bytes. */
  size: number;
  modifiedAt: Date | null;
}

export interface ZipArchive {
  entries: ArchiveEntry[];
  /** Whether an entry exists (exact name). */
  has(name: string): boolean;
  /** Uncompressed bytes of an entry (stored or deflate). Throws Error for missing/unsupported/encrypted entries. */
  read(name: string): Promise<Uint8Array>;
  /** UTF-8 text of an entry. */
  readText(name: string): Promise<string>;
}

const EOCD_SIG = 0x06054b50;
const EOCD64_LOCATOR_SIG = 0x07064b50;
const EOCD64_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;

const FLAG_ENCRYPTED = 0x1;
const FLAG_UTF8 = 0x800;

/** Central directory facts needed to extract an entry later. */
interface ZipRecord {
  entry: ArchiveEntry;
  flags: number;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** CP437 glyphs for bytes 0x80-0xFF (the legacy zip name encoding). */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0";

const utf8 = new TextDecoder("utf-8");
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function notZip(): Error {
  return new Error("Not a zip archive");
}

/** Read a little-endian 64-bit size/offset as a JS number (exact up to 2^53). */
function getUint64(view: DataView, offset: number): number {
  return view.getUint32(offset, true) + view.getUint32(offset + 4, true) * 0x100000000;
}

/** Entry names: UTF-8 when flagged (or when the bytes happen to be valid UTF-8), else CP437. */
function decodeName(raw: Uint8Array, utf8Flag: boolean): string {
  if (utf8Flag) return utf8.decode(raw);
  try {
    return strictUtf8.decode(raw);
  } catch {
    let out = "";
    for (const byte of raw) out += byte < 0x80 ? String.fromCharCode(byte) : CP437_HIGH[byte - 0x80];
    return out;
  }
}

/** MS-DOS date/time fields (local time); null when unset or out of range. */
function dosDateTime(date: number, time: number): Date | null {
  if (date === 0) return null;
  const day = date & 0x1f;
  const month = (date >> 5) & 0xf;
  const year = 1980 + (date >> 9);
  if (day < 1 || month < 1 || month > 12) return null;
  const seconds = (time & 0x1f) * 2;
  const minutes = (time >> 5) & 0x3f;
  const hours = time >> 11;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

/** Offset of the End Of Central Directory record, scanning backwards over a possible comment. */
function findEocd(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let offset = last; offset >= first; offset--) {
    if (view.getUint32(offset, true) !== EOCD_SIG) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_SIZE + commentLength <= view.byteLength) return offset;
  }
  return -1;
}

/** Parse a zip from its full bytes (End of Central Directory + central directory; ZIP64 supported for sizes/offsets). Throws Error("Not a zip archive") when invalid. */
export function openZip(bytes: Uint8Array): ZipArchive {
  if (bytes.byteLength < EOCD_SIZE) throw notZip();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view);
  if (eocd < 0) throw notZip();

  let count = view.getUint16(eocd + 10, true);
  let cdSize = view.getUint32(eocd + 12, true);
  let cdOffset = view.getUint32(eocd + 16, true);
  let zip64 = false;

  const locator = eocd - 20;
  if (locator >= 0 && view.getUint32(locator, true) === EOCD64_LOCATOR_SIG) {
    const record = getUint64(view, locator + 8);
    if (record + 56 > view.byteLength || view.getUint32(record, true) !== EOCD64_SIG) throw notZip();
    count = getUint64(view, record + 32);
    cdSize = getUint64(view, record + 40);
    cdOffset = getUint64(view, record + 48);
    zip64 = true;
  }

  // Data prepended to the archive (self-extractors) shifts every recorded offset by the same amount.
  let shift = 0;
  if (!zip64 && count > 0 && cdOffset + cdSize <= eocd) {
    const actual = eocd - cdSize;
    if (actual !== cdOffset && view.getUint32(actual, true) === CENTRAL_SIG) shift = actual - cdOffset;
  }

  const records = new Map<string, ZipRecord>();
  const entries: ArchiveEntry[] = [];
  let offset = cdOffset + shift;
  for (let index = 0; index < count; index++) {
    if (offset + CENTRAL_SIZE > view.byteLength || view.getUint32(offset, true) !== CENTRAL_SIG) throw notZip();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const time = view.getUint16(offset + 12, true);
    const date = view.getUint16(offset + 14, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localOffset = view.getUint32(offset + 42, true);
    const nameStart = offset + CENTRAL_SIZE;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > view.byteLength) throw notZip();

    // ZIP64 extended information: only the fields saturated in the fixed header are present, in order.
    for (let extra = extraStart; extra + 4 <= extraStart + extraLength; ) {
      const id = view.getUint16(extra, true);
      const length = view.getUint16(extra + 2, true);
      if (id === 0x0001) {
        let field = extra + 4;
        const end = field + length;
        if (size === 0xffffffff && field + 8 <= end) {
          size = getUint64(view, field);
          field += 8;
        }
        if (compressedSize === 0xffffffff && field + 8 <= end) {
          compressedSize = getUint64(view, field);
          field += 8;
        }
        if (localOffset === 0xffffffff && field + 8 <= end) localOffset = getUint64(view, field);
        break;
      }
      extra += 4 + length;
    }

    const name = decodeName(bytes.subarray(nameStart, extraStart), (flags & FLAG_UTF8) !== 0);
    const entry: ArchiveEntry = {
      name,
      directory: name.endsWith("/"),
      size,
      modifiedAt: dosDateTime(date, time),
    };
    entries.push(entry);
    if (!records.has(name)) {
      records.set(name, { entry, flags, method, compressedSize, localOffset: localOffset + shift });
    }
    offset = next;
  }

  async function read(name: string): Promise<Uint8Array> {
    const record = records.get(name);
    if (!record) throw new Error(`No entry "${name}" in the archive`);
    if (record.flags & FLAG_ENCRYPTED) throw new Error(`"${name}" is encrypted`);
    if (record.method !== 0 && record.method !== 8) {
      throw new Error(`Unsupported compression method ${record.method} for "${name}"`);
    }
    const local = record.localOffset;
    if (local + LOCAL_SIZE > view.byteLength || view.getUint32(local, true) !== LOCAL_SIG) {
      throw new Error(`Corrupt zip entry "${name}"`);
    }
    // Sizes come from the central directory (local headers may defer them to a data descriptor).
    const start = local + LOCAL_SIZE + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const end = start + record.compressedSize;
    if (end > view.byteLength) throw new Error(`"${name}" is truncated`);
    const data = bytes.subarray(start, end);
    if (record.method === 0) return data;
    try {
      const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Couldn't decompress "${name}": ${reason}`);
    }
  }

  return {
    entries,
    has: (name) => records.has(name),
    read,
    readText: async (name) => utf8.decode(await read(name)),
  };
}
