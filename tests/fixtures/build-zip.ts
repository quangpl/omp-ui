// Test fixture builders: small but spec-valid zip and ustar archives assembled in memory.
import { crc32, deflateRawSync } from "node:zlib";

/** Fixed timestamp of every built entry: 2024-01-02 03:04:06 local time (DOS time has 2 s precision). */
export const FIXTURE_DATE = new Date(2024, 0, 2, 3, 4, 6);
const DOS_TIME = (3 << 11) | (4 << 5) | (6 >> 1);
const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 2;

/** Tar mtime of every built entry (seconds since the epoch). */
export const FIXTURE_TAR_MTIME = 1_700_000_000;

const encoder = new TextEncoder();

function toBytes(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface BuildZipOptions {
  /** Deflate file entries (default true); directories are always stored. */
  compress?: boolean;
  /** Archive comment after the End Of Central Directory record. */
  comment?: string;
  /** Write sizes/offsets through ZIP64 extra fields and a ZIP64 End Of Central Directory. */
  zip64?: boolean;
  /** Leave local header sizes/CRC zero and append data descriptors (general purpose flag bit 3). */
  dataDescriptor?: boolean;
}

/** A zip with UTF-8 names (flag bit 11). Names ending in "/" become directory entries. */
export function buildZip(files: Record<string, string | Uint8Array>, options?: BuildZipOptions): Uint8Array {
  const compress = options?.compress ?? true;
  const zip64 = options?.zip64 ?? false;
  const descriptor = options?.dataDescriptor ?? false;
  const flags = 0x800 | (descriptor ? 0x8 : 0);
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const [name, content] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = toBytes(content);
    const deflate = compress && !name.endsWith("/");
    const stored = deflate ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, zip64 ? 45 : 20, true);
    local.setUint16(6, flags, true);
    local.setUint16(8, deflate ? 8 : 0, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    if (!descriptor) {
      local.setUint32(14, crc, true);
      local.setUint32(18, stored.length, true);
      local.setUint32(22, data.length, true);
    }
    local.setUint16(26, nameBytes.length, true);
    const localOffset = offset;
    parts.push(new Uint8Array(local.buffer), nameBytes, stored);
    offset += 30 + nameBytes.length + stored.length;
    if (descriptor) {
      const trailer = new DataView(new ArrayBuffer(16));
      trailer.setUint32(0, 0x08074b50, true);
      trailer.setUint32(4, crc, true);
      trailer.setUint32(8, stored.length, true);
      trailer.setUint32(12, data.length, true);
      parts.push(new Uint8Array(trailer.buffer));
      offset += 16;
    }

    const extra = new DataView(new ArrayBuffer(zip64 ? 28 : 0));
    if (zip64) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 24, true);
      extra.setBigUint64(4, BigInt(data.length), true);
      extra.setBigUint64(12, BigInt(stored.length), true);
      extra.setBigUint64(20, BigInt(localOffset), true);
    }
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, zip64 ? 45 : 20, true);
    header.setUint16(6, zip64 ? 45 : 20, true);
    header.setUint16(8, flags, true);
    header.setUint16(10, deflate ? 8 : 0, true);
    header.setUint16(12, DOS_TIME, true);
    header.setUint16(14, DOS_DATE, true);
    header.setUint32(16, crc, true);
    header.setUint32(20, zip64 ? 0xffffffff : stored.length, true);
    header.setUint32(24, zip64 ? 0xffffffff : data.length, true);
    header.setUint16(28, nameBytes.length, true);
    header.setUint16(30, extra.byteLength, true);
    header.setUint32(42, zip64 ? 0xffffffff : localOffset, true);
    central.push(new Uint8Array(header.buffer), nameBytes, new Uint8Array(extra.buffer));
  }

  const directory = concat(central);
  const count = Object.keys(files).length;
  const cdOffset = offset;
  parts.push(directory);
  offset += directory.length;

  if (zip64) {
    const record = new DataView(new ArrayBuffer(56));
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, BigInt(44), true);
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(24, BigInt(count), true);
    record.setBigUint64(32, BigInt(count), true);
    record.setBigUint64(40, BigInt(directory.length), true);
    record.setBigUint64(48, BigInt(cdOffset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(offset), true);
    locator.setUint32(16, 1, true);
    parts.push(new Uint8Array(record.buffer), new Uint8Array(locator.buffer));
  }

  const comment = encoder.encode(options?.comment ?? "");
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, zip64 ? 0xffff : count, true);
  end.setUint16(10, zip64 ? 0xffff : count, true);
  end.setUint32(12, zip64 ? 0xffffffff : directory.length, true);
  end.setUint32(16, zip64 ? 0xffffffff : cdOffset, true);
  end.setUint16(20, comment.length, true);
  parts.push(new Uint8Array(end.buffer), comment);
  return concat(parts);
}

/** Write `text` as a NUL-padded ASCII/UTF-8 field. */
function putString(block: Uint8Array, offset: number, length: number, text: string): void {
  block.set(encoder.encode(text).subarray(0, length), offset);
}

/** Write a zero-padded octal number field followed by a NUL. */
function putOctal(block: Uint8Array, offset: number, length: number, value: number): void {
  putString(block, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** One ustar header block. */
function tarHeader(name: string, size: number, type: string, prefix = ""): Uint8Array {
  const block = new Uint8Array(512);
  putString(block, 0, 100, name);
  putOctal(block, 100, 8, type === "5" ? 0o755 : 0o644);
  putOctal(block, 108, 8, 1000);
  putOctal(block, 116, 8, 1000);
  putOctal(block, 124, 12, size);
  putOctal(block, 136, 12, FIXTURE_TAR_MTIME);
  putString(block, 156, 1, type);
  putString(block, 257, 6, "ustar\0");
  putString(block, 263, 2, "00");
  putString(block, 345, 155, prefix);
  block.fill(0x20, 148, 156);
  const sum = block.reduce((total, byte) => total + byte, 0);
  putString(block, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

/** Entry data padded to whole 512-byte blocks. */
function tarData(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return padded;
}

/**
 * A ustar archive. Names ending in "/" become directories. Long ASCII names are split across the ustar
 * prefix when possible, otherwise written with a GNU 'L' long-name entry; non-ASCII names get a pax 'x' header.
 */
export function buildTar(files: Record<string, string | Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const directory = name.endsWith("/");
    const data = directory ? new Uint8Array(0) : toBytes(content);
    const type = directory ? "5" : "0";
    let header: Uint8Array;
    if (/[^\x20-\x7e]/.test(name)) {
      const record = (length: number) => `${length} path=${name}\n`;
      // The record length counts its own digits.
      let length = encoder.encode(record(0)).length;
      while (encoder.encode(record(length)).length !== length) length = encoder.encode(record(length)).length;
      const pax = encoder.encode(record(length));
      parts.push(tarHeader("PaxHeader", pax.length, "x"), tarData(pax));
      header = tarHeader("pax-entry", data.length, type);
    } else if (name.length <= 100) {
      header = tarHeader(name, data.length, type);
    } else {
      const split = name.lastIndexOf("/", name.length - 2);
      const prefix = name.slice(0, Math.max(split, 0));
      const rest = name.slice(split + 1);
      if (split > 0 && prefix.length <= 155 && rest.length <= 100) {
        header = tarHeader(rest, data.length, type, prefix);
      } else {
        const longName = encoder.encode(`${name}\0`);
        parts.push(tarHeader("././@LongLink", longName.length, "L"), tarData(longName));
        header = tarHeader(name.slice(0, 100), data.length, type);
      }
    }
    parts.push(header, tarData(data));
  }
  parts.push(new Uint8Array(1024));
  return concat(parts);
}
