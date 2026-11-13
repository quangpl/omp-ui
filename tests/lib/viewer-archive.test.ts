import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { listTar } from "@/lib/viewer/tar";
import { attr, childElements, findAll, findFirst, localName, parseXml, textContent } from "@/lib/viewer/xml";
import { openZip } from "@/lib/viewer/zip";
import { buildTar, buildZip, FIXTURE_DATE, FIXTURE_TAR_MTIME } from "@/tests/fixtures/build-zip";

const decoder = new TextDecoder();

/** Offset of the first central directory header in a built zip. */
function centralOffset(bytes: Uint8Array): number {
  for (let index = 0; index + 4 <= bytes.length; index++) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x01 && bytes[index + 3] === 0x02) {
      return index;
    }
  }
  throw new Error("no central directory header");
}

describe("openZip", () => {
  const long = "lorem ipsum ".repeat(500);
  const files = {
    "docs/": "",
    "docs/readme.txt": "hello zip",
    "docs/long.txt": long,
    "naïve/日本語.md": "# unicode",
    "bin.dat": new Uint8Array([0, 1, 2, 255]),
  };

  for (const compress of [true, false]) {
    it(`round-trips ${compress ? "deflated" : "stored"} entries`, async () => {
      const zip = openZip(buildZip(files, { compress }));
      expect(zip.entries.map((entry) => entry.name)).toEqual(Object.keys(files));
      expect(zip.entries[0]).toEqual({ name: "docs/", directory: true, size: 0, modifiedAt: FIXTURE_DATE });
      expect(zip.entries[2]).toMatchObject({ name: "docs/long.txt", directory: false, size: long.length });
      expect(zip.has("docs/readme.txt")).toBe(true);
      expect(zip.has("readme.txt")).toBe(false);
      expect(await zip.readText("docs/readme.txt")).toBe("hello zip");
      expect(await zip.readText("docs/long.txt")).toBe(long);
      expect(await zip.readText("naïve/日本語.md")).toBe("# unicode");
      expect(Array.from(await zip.read("bin.dat"))).toEqual([0, 1, 2, 255]);
    });
  }

  it("finds the end record behind an archive comment", async () => {
    const zip = openZip(buildZip({ "a.txt": "A" }, { comment: "c".repeat(1000) }));
    expect(await zip.readText("a.txt")).toBe("A");
  });

  it("reads ZIP64 sizes/offsets and data-descriptor entries", async () => {
    const zip = openZip(buildZip({ "x/": "", "x/a.txt": "zip64 body" }, { zip64: true, dataDescriptor: true }));
    expect(zip.entries).toEqual([
      { name: "x/", directory: true, size: 0, modifiedAt: FIXTURE_DATE },
      { name: "x/a.txt", directory: false, size: 10, modifiedAt: FIXTURE_DATE },
    ]);
    expect(await zip.readText("x/a.txt")).toBe("zip64 body");
  });

  it("reads entries when data is prepended to the archive", async () => {
    const zip = buildZip({ "a.txt": "shifted" });
    const shifted = new Uint8Array(zip.length + 64);
    shifted.set(zip, 64);
    expect(await openZip(shifted).readText("a.txt")).toBe("shifted");
  });

  it("works on a subarray view", async () => {
    const zip = buildZip({ "a.txt": "view" });
    const host = new Uint8Array(zip.length + 20);
    host.set(zip, 10);
    expect(await openZip(host.subarray(10, 10 + zip.length)).readText("a.txt")).toBe("view");
  });

  it("rejects bytes that aren't a zip", () => {
    expect(() => openZip(new Uint8Array([1, 2, 3]))).toThrow("Not a zip archive");
    expect(() => openZip(new TextEncoder().encode("x".repeat(500)))).toThrow("Not a zip archive");
    const truncated = buildZip({ "a.txt": "A" });
    expect(() => openZip(truncated.subarray(40))).toThrow("Not a zip archive");
  });

  it("rejects missing, encrypted and unsupported entries on read", async () => {
    const zip = openZip(buildZip({ "a.txt": "A" }));
    await expect(zip.read("b.txt")).rejects.toThrow('No entry "b.txt"');

    const unsupported = buildZip({ "x": "X" }, { compress: false });
    new DataView(unsupported.buffer).setUint16(centralOffset(unsupported) + 10, 12, true);
    await expect(openZip(unsupported).read("x")).rejects.toThrow('Unsupported compression method 12 for "x"');

    const encrypted = buildZip({ "x": "X" });
    const view = new DataView(encrypted.buffer);
    const flags = centralOffset(encrypted) + 8;
    view.setUint16(flags, view.getUint16(flags, true) | 1, true);
    await expect(openZip(encrypted).read("x")).rejects.toThrow('"x" is encrypted');
  });
});

describe("listTar", () => {
  const longDir = `${"deep/".repeat(25)}`;
  const files = {
    "src/": "",
    "src/index.ts": "export {};\n",
    [`${longDir}file.txt`]: "x".repeat(700),
    [`${"n".repeat(120)}.txt`]: "gnu",
    "émoji-😀.txt": "pax",
  };
  const expected = [
    { name: "src/", directory: true, size: 0 },
    { name: "src/index.ts", directory: false, size: 11 },
    { name: `${longDir}file.txt`, directory: false, size: 700 },
    { name: `${"n".repeat(120)}.txt`, directory: false, size: 3 },
    { name: "émoji-😀.txt", directory: false, size: 3 },
  ].map((entry) => ({ ...entry, modifiedAt: new Date(FIXTURE_TAR_MTIME * 1000) }));

  it("lists a plain tar with ustar prefix, GNU long names, pax paths and directories", async () => {
    expect(await listTar(buildTar(files))).toEqual({ entries: expected, truncated: false });
  });

  it("lists a gzip-compressed tar", async () => {
    expect(await listTar(gzipSync(buildTar(files)), { gzip: true })).toEqual({ entries: expected, truncated: false });
  });

  it("stops at maxEntries and reports truncation", async () => {
    const many = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`f${index}.txt`, `${index}`]));
    const tar = buildTar(many);
    const limited = await listTar(tar, { maxEntries: 3 });
    expect(limited.entries.map((entry) => entry.name)).toEqual(["f0.txt", "f1.txt", "f2.txt"]);
    expect(limited.truncated).toBe(true);
    expect((await listTar(tar, { maxEntries: 5 })).truncated).toBe(false);
    expect((await listTar(gzipSync(tar), { gzip: true, maxEntries: 2 })).truncated).toBe(true);
  });

  it("rejects bytes that aren't a tar", async () => {
    await expect(listTar(new TextEncoder().encode("not a tar".repeat(100)))).rejects.toThrow("Not a tar archive");
    await expect(listTar(new Uint8Array(10))).rejects.toThrow("Not a tar archive");
    await expect(listTar(new TextEncoder().encode("plain"), { gzip: true })).rejects.toThrow(/gzip/);
  });
});

describe("parseXml", () => {
  const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE doc [ <!ENTITY x "y"> ]>
<!-- leading comment -->
<w:document xmlns:w="urn:w" w:val='a > b' plain=unquoted>
  <w:p><w:r><w:t xml:space="preserve"> Tom &amp; Jerry &lt;3 &#169; &#x2014; &nbsp;&hellip;&unknown; </w:t></w:r></w:p>
  <w:p><w:br/><w:t><![CDATA[<raw> & stuff]]></w:t><!-- inner --></w:p>
  <w:tbl/>
</w:document>`;
  const root = parseXml(source);

  it("builds a tree under a #document root, keeping prefixes", () => {
    expect(root.name).toBe("#document");
    const doc = childElements(root, "document")[0];
    expect(doc.name).toBe("w:document");
    expect(childElements(doc).map((el) => el.name)).toEqual(["w:p", "w:p", "w:tbl"]);
    expect(childElements(doc, "p")).toHaveLength(2);
    expect(childElements(doc, "tbl")[0].children).toEqual([]);
  });

  it("parses attributes with quotes, > inside values, prefixes and unquoted values", () => {
    const doc = findFirst(root, "document")!;
    expect(doc.attrs).toEqual({ "xmlns:w": "urn:w", "w:val": "a > b", plain: "unquoted" });
    expect(attr(doc, "val")).toBe("a > b");
    expect(attr(doc, "plain")).toBe("unquoted");
    expect(attr(doc, "missing")).toBeUndefined();
  });

  it("decodes entities, keeps whitespace text and reads CDATA verbatim", () => {
    const texts = findAll(root, "t");
    expect(texts).toHaveLength(2);
    expect(textContent(texts[0])).toBe(" Tom & Jerry <3 © — \u00a0…&unknown; ");
    expect(textContent(texts[1])).toBe("<raw> & stuff");
    expect(findFirst(root, "br")).toEqual({ type: "element", name: "w:br", attrs: {}, children: [] });
    expect(findFirst(root, "nope")).toBeNull();
  });

  it("recovers from unclosed and stray tags", () => {
    const broken = parseXml("<a><b>one<c>two</b></x>three");
    const a = findFirst(broken, "a")!;
    expect(childElements(a).map((el) => el.name)).toEqual(["b"]);
    expect(textContent(a)).toBe("onetwothree");
    expect(textContent(parseXml("1 < 2 and <p>x</p>"))).toBe("1 < 2 and x");
  });

  it("strips prefixes in localName", () => {
    expect(localName("w:p")).toBe("p");
    expect(localName("p")).toBe("p");
  });
});
