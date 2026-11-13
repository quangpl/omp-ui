import { describe, expect, it } from "vitest";
import { readDocx, readEpub, readPptx, readXlsx } from "@/lib/viewer/office";
import { openZip } from "@/lib/viewer/zip";
import { buildZip } from "../fixtures/build-zip";

const open = (files: Record<string, string>) => openZip(buildZip(files));
const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const rels = (entries: string) =>
  xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`);
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

describe("readDocx", () => {
  const p = (inner: string, pPr = "") => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${inner}</w:p>`;
  const r = (text: string, rPr = "") => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
  const list = (numId: number, ilvl: number) => `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;

  const document = xml(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL}">
<w:body>
  ${p(r("Report"), '<w:pStyle w:val="Heading1"/>')}
  ${p(r("Styled heading"), '<w:pStyle w:val="Custom2"/>')}
  ${p(r("Big title"), '<w:pStyle w:val="Title"/>')}
  <w:p/>
  ${p("<w:r><w:t> </w:t></w:r>")}
  ${p(
    `${r("Plain ")}${r("bold", "<w:b/>")}${r(" text", "<w:b/>")}${r(" and ", '<w:i w:val="0"/>')}` +
      `<w:hyperlink r:id="rId5">${r("a link", '<w:u w:val="single"/>')}</w:hyperlink>` +
      `<w:hyperlink r:id="rId6">${r(" unsafe")}</w:hyperlink>${r(" gone", '<w:strike w:val="false"/><w:u w:val="none"/>')}`,
  )}
  ${p(`${r("npm test", '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>')}<w:r><w:tab/><w:t>x</w:t><w:br/><w:t>y</w:t></w:r>`)}
  ${p(r("Bullet one"), list(1, 0))}
  ${p(r("Nested bullet"), list(1, 1))}
  ${p(r("Step one"), list(2, 0))}
  ${p(r("Not a list"), list(0, 0))}
  <w:tbl>
    <w:tblPr/>
    <w:tr><w:tc>${p(r("H1", "<w:b/>"))}</w:tc><w:tc>${p(r("H2"))}</w:tc></w:tr>
    <w:tr><w:tc>${p(r("one"))}${p(r("two"))}</w:tc><w:tc><w:p/></w:tc></w:tr>
  </w:tbl>
  ${p('<w:r><w:drawing><wp:inline><wp:docPr id="1" name="Picture 1" descr="A chart"/></wp:inline></w:drawing></w:r>')}
  <w:sectPr/>
</w:body>
</w:document>`);

  const files = {
    "[Content_Types].xml": xml("<Types/>"),
    "word/document.xml": document,
    "word/_rels/document.xml.rels": rels(
      `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>` +
        `<Relationship Id="rId5" Type="${REL}/hyperlink" Target="https://example.com/" TargetMode="External"/>` +
        `<Relationship Id="rId6" Type="${REL}/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>`,
    ),
    "word/styles.xml": xml(`<w:styles>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Custom2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
</w:styles>`),
    "word/numbering.xml": xml(`<w:numbering>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`),
  };

  it("extracts headings, formatted runs, links, lists, tables and images in order", async () => {
    expect(await readDocx(open(files))).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "Report" }] },
      { kind: "heading", level: 2, runs: [{ text: "Styled heading" }] },
      { kind: "heading", level: 1, runs: [{ text: "Big title" }] },
      {
        kind: "paragraph",
        runs: [
          { text: "Plain " },
          { text: "bold text", bold: true },
          { text: " and " },
          { text: "a link", underline: true, href: "https://example.com/" },
          { text: " unsafe gone" },
        ],
      },
      { kind: "paragraph", runs: [{ text: "npm test", code: true }, { text: "\tx\ny" }] },
      { kind: "list-item", ordered: false, level: 0, runs: [{ text: "Bullet one" }] },
      { kind: "list-item", ordered: false, level: 1, runs: [{ text: "Nested bullet" }] },
      { kind: "list-item", ordered: true, level: 0, runs: [{ text: "Step one" }] },
      { kind: "paragraph", runs: [{ text: "Not a list" }] },
      {
        kind: "table",
        rows: [
          [[{ text: "H1", bold: true }], [{ text: "H2" }]],
          [[{ text: "one\ntwo" }], []],
        ],
      },
      { kind: "image", alt: "A chart" },
    ]);
  });

  it("rejects a package without word/document.xml", async () => {
    await expect(readDocx(open({ "word/styles.xml": xml("<w:styles/>") }))).rejects.toThrow(
      "Not a Word document (word/document.xml is missing)",
    );
  });
});

describe("readXlsx", () => {
  const files = {
    "xl/workbook.xml": xml(`<workbook xmlns:r="${REL}">
  <workbookPr/>
  <sheets>
    <sheet name="Data" sheetId="1" r:id="rId1"/>
    <sheet name="Notes" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`),
    "xl/_rels/workbook.xml.rels": rels(
      `<Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/second.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/>` +
        `<Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/>`,
    ),
    "xl/sharedStrings.xml": xml(`<sst count="3" uniqueCount="3">
  <si><t>Name</t><rPh sb="0" eb="1"><t>ignored</t></rPh></si>
  <si><r><rPr><b/></rPr><t>Rich</t></r><r><t xml:space="preserve"> text</t></r></si>
  <si><t>Date</t></si>
</sst>`),
    "xl/styles.xml": xml(`<styleSheet>
  <numFmts count="2">
    <numFmt numFmtId="164" formatCode="&quot;Total: &quot;0.00"/>
    <numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm"/>
  </numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/>
    <xf numFmtId="14" applyNumberFormat="1"/>
    <xf numFmtId="164" applyNumberFormat="1"/>
    <xf numFmtId="165" applyNumberFormat="1"/>
  </cellXfs>
</styleSheet>`),
    "xl/worksheets/sheet1.xml": xml(`<worksheet><sheetData>
  <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>2</v></c></row>
  <row r="2">
    <c r="A2" t="inlineStr"><is><t>Ada</t></is></c>
    <c r="B2" t="b"><v>1</v></c>
    <c r="D2" s="1"><v>45000</v></c>
    <c r="F2" s="1"/>
  </row>
  <row r="3">
    <c r="A3"><v>0.30000000000000004</v></c>
    <c r="B3" t="b"><v>0</v></c>
    <c r="C3" s="2"><v>2.5</v></c>
    <c r="D3" s="3"><v>45000.5</v></c>
  </row>
  <row r="5"><c r="A5"/></row>
</sheetData></worksheet>`),
    "xl/worksheets/second.xml": xml(`<worksheet><sheetData>
  <row r="2"><c r="B2" t="str"><f>"h"&amp;"i"</f><v>hi</v></c></row>
  <row r="1500"><c r="A1500" t="str"><v>far away</v></c></row>
</sheetData></worksheet>`),
  };

  it("reads sheets with shared/inline strings, booleans, dates, numbers and gaps", async () => {
    expect(await readXlsx(open(files))).toEqual([
      {
        name: "Data",
        rows: [
          ["Name", "Rich text", "", "Date"],
          ["Ada", "TRUE", "", "2023-03-15"],
          ["0.3", "FALSE", "2.5", "2023-03-15 12:00"],
        ],
        truncated: false,
      },
      { name: "Notes", rows: [["", ""], ["", "hi"]], truncated: true },
    ]);
  });

  it("honours the 1904 date system", async () => {
    const workbook = files["xl/workbook.xml"].replace("<workbookPr/>", '<workbookPr date1904="1"/>');
    const [data] = await readXlsx(open({ ...files, "xl/workbook.xml": workbook }));
    expect(data.rows[1][3]).toBe("2027-03-16");
  });

  it("rejects a package without a workbook", async () => {
    await expect(readXlsx(open({ "word/document.xml": xml("<w:document/>") }))).rejects.toThrow(/Not an Excel workbook/);
  });
});

describe("readPptx", () => {
  const sp = (ph: string, paragraphs: string) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Shape"/><p:cNvSpPr/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr/>` +
    `<p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;
  const ap = (text: string, pPr = "", rPrAttrs = "") => `<a:p>${pPr}<a:r><a:rPr lang="en-US"${rPrAttrs}/><a:t>${text}</a:t></a:r></a:p>`;
  const slide = (shapes: string) =>
    xml(`<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="${REL}">
<p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${shapes}</p:spTree></p:cSld></p:sld>`);

  const files = {
    "ppt/presentation.xml": xml(`<p:presentation xmlns:r="${REL}">
  <p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
</p:presentation>`),
    "ppt/_rels/presentation.xml.rels": rels(
      `<Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/>` +
        `<Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/>`,
    ),
    "ppt/slides/slide2.xml": slide(
      sp('<p:ph type="ctrTitle"/>', ap("Welcome")) + sp('<p:ph type="subTitle" idx="1"/>', ap("Intro deck")),
    ),
    "ppt/slides/slide1.xml": slide(
      sp('<p:ph type="title"/>', ap("Agenda")) +
        sp(
          '<p:ph idx="1"/>',
          ap("First point", "", ' b="1"') +
            `<a:p><a:r><a:rPr><a:hlinkClick r:id="rId9"/></a:rPr><a:t>Docs</a:t></a:r><a:r><a:rPr i="1" u="sng"/><a:t> here</a:t></a:r></a:p>` +
            ap("Sub point", '<a:pPr lvl="1"/>') +
            ap("Step", '<a:pPr><a:buAutoNum type="arabicPeriod"/></a:pPr>') +
            ap("Plain", "<a:pPr><a:buNone/></a:pPr>"),
        ) +
        sp('<p:ph type="sldNum" idx="12"/>', ap("2")) +
        sp("", ap("Free text", "", ' strike="sngStrike"')) +
        `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 4" descr="Diagram"/></p:nvPicPr></p:pic>` +
        `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>` +
        `<a:tr><a:tc><a:txBody>${ap("Cell A")}</a:txBody></a:tc><a:tc><a:txBody>${ap("Cell B")}</a:txBody></a:tc></a:tr>` +
        `</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
    ),
    "ppt/slides/_rels/slide1.xml.rels": rels(
      `<Relationship Id="rId1" Type="${REL}/notesSlide" Target="../notesSlides/notesSlide1.xml"/>` +
        `<Relationship Id="rId9" Type="${REL}/hyperlink" Target="https://omp.dev/docs" TargetMode="External"/>`,
    ),
    "ppt/notesSlides/notesSlide1.xml": xml(`<p:notes xmlns:r="${REL}"><p:cSld><p:spTree>
  <p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr></p:sp>
  ${sp('<p:ph type="body" idx="1"/>', ap("Remember to smile"))}
  ${sp('<p:ph type="sldNum" idx="5"/>', ap("2"))}
</p:spTree></p:cSld></p:notes>`),
  };

  it("reads slides in sldIdLst order with titles, bullets, links, pictures, tables and notes", async () => {
    expect(await readPptx(open(files))).toEqual([
      { index: 1, title: "Welcome", blocks: [{ kind: "paragraph", runs: [{ text: "Intro deck" }] }], notes: [] },
      {
        index: 2,
        title: "Agenda",
        blocks: [
          { kind: "list-item", ordered: false, level: 0, runs: [{ text: "First point", bold: true }] },
          {
            kind: "list-item",
            ordered: false,
            level: 0,
            runs: [{ text: "Docs", href: "https://omp.dev/docs" }, { text: " here", italic: true, underline: true }],
          },
          { kind: "list-item", ordered: false, level: 1, runs: [{ text: "Sub point" }] },
          { kind: "list-item", ordered: true, level: 0, runs: [{ text: "Step" }] },
          { kind: "paragraph", runs: [{ text: "Plain" }] },
          { kind: "paragraph", runs: [{ text: "Free text", strike: true }] },
          { kind: "image", alt: "Diagram" },
          { kind: "table", rows: [[[{ text: "Cell A" }], [{ text: "Cell B" }]]] },
        ],
        notes: [{ kind: "paragraph", runs: [{ text: "Remember to smile" }] }],
      },
    ]);
  });

  it("rejects a package without a presentation part", async () => {
    await expect(readPptx(open({ "ppt/slides/slide1.xml": xml("<p:sld/>") }))).rejects.toThrow(/Not a PowerPoint presentation/);
  });
});

describe("readEpub", () => {
  const xhtml = (body: string) =>
    xml(`<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Ignored</title><style>p { color: red; }</style></head>
<body>${body}</body>
</html>`);

  const files = {
    mimetype: "application/epub+zip",
    "META-INF/container.xml": xml(`<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/content.opf": xml(`<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Sample Book</dc:title>
    <dc:creator>Jane Doe</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="text/chapter%201.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="empty" href="text/empty.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="ch1"/><itemref idref="ch2"/><itemref idref="empty"/></spine>
</package>`),
    "OEBPS/nav.xhtml": xhtml(`<nav epub:type="landmarks"><ol><li><a href="text/ch2.xhtml">Wrong</a></li></ol></nav>
<nav epub:type="toc"><ol><li><a href="text/chapter%201.xhtml#start">Opening</a></li></ol></nav>`),
    "OEBPS/text/chapter 1.xhtml": xhtml(`<h1 id="start">Chapter One</h1>
<p>Hello <b>bold</b> and <a href="https://x.org/">link</a> <a href="javascript:alert(1)">bad</a>.</p>
<p>Line one<br/>
  Line two</p>
<ul><li>Item<ul><li>Sub</li></ul></li></ul>
<ol><li><em>First</em></li></ol>
<pre>code
  line</pre>
<div><img src="cover.jpg" alt="Cover"/></div>
<hr/>
<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td><code>x</code></td><td>y</td></tr></tbody></table>
<script>alert(1)</script>
<blockquote><p>Quote&nbsp;me</p></blockquote>`),
    "OEBPS/text/ch2.xhtml": xhtml("<section><h2>Second Part</h2><p>More text.</p></section>"),
    "OEBPS/text/empty.xhtml": xhtml("  "),
  };

  it("reads metadata and spine chapters with nav titles and converted blocks", async () => {
    const book = await readEpub(open(files));
    expect(book.title).toBe("Sample Book");
    expect(book.author).toBe("Jane Doe");
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["Opening", "Second Part"]);
    expect(book.chapters[0].blocks).toEqual([
      { kind: "heading", level: 1, runs: [{ text: "Chapter One" }] },
      {
        kind: "paragraph",
        runs: [{ text: "Hello " }, { text: "bold", bold: true }, { text: " and " }, { text: "link", href: "https://x.org/" }, { text: " bad." }],
      },
      { kind: "paragraph", runs: [{ text: "Line one\nLine two" }] },
      { kind: "list-item", ordered: false, level: 0, runs: [{ text: "Item" }] },
      { kind: "list-item", ordered: false, level: 1, runs: [{ text: "Sub" }] },
      { kind: "list-item", ordered: true, level: 0, runs: [{ text: "First", italic: true }] },
      { kind: "code", text: "code\n  line" },
      { kind: "image", alt: "Cover" },
      { kind: "rule" },
      {
        kind: "table",
        rows: [
          [[{ text: "A" }], [{ text: "B" }]],
          [[{ text: "x", code: true }], [{ text: "y" }]],
        ],
      },
      { kind: "paragraph", runs: [{ text: "Quote\u00a0me" }] },
    ]);
    expect(book.chapters[1].blocks).toEqual([
      { kind: "heading", level: 2, runs: [{ text: "Second Part" }] },
      { kind: "paragraph", runs: [{ text: "More text." }] },
    ]);
  });

  it("falls back to NCX titles for EPUB 2", async () => {
    const opf = files["OEBPS/content.opf"]
      .replace('properties="nav"', "")
      .replace('<item id="css"', '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css"')
      .replace("<spine>", '<spine toc="ncx">');
    const book = await readEpub(
      open({
        ...files,
        "OEBPS/content.opf": opf,
        "OEBPS/toc.ncx": xml(`<ncx><navMap>
  <navPoint id="p1"><navLabel><text>From NCX</text></navLabel><content src="text/ch2.xhtml#top"/></navPoint>
</navMap></ncx>`),
      }),
    );
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(["Chapter One", "From NCX"]);
  });

  it("rejects a zip without META-INF/container.xml", async () => {
    await expect(readEpub(open({ "index.html": "<p>hi</p>" }))).rejects.toThrow(/Not an EPUB/);
  });
});
