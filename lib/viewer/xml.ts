// Forgiving single-pass XML parser for office/ebook previews (docx, xlsx, pptx, epub XHTML). Pure TS (no
// DOMParser) so it runs in the browser and in Node tests. Whitespace text is kept: office formats rely on
// xml:space="preserve".

export interface XmlElement {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export interface XmlText {
  type: "text";
  text: string;
}
export type XmlNode = XmlElement | XmlText;

/** XML's predefined entities plus the HTML ones common in XHTML ebooks. */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  times: "×",
  euro: "€",
};

const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(ENTITY, (match, body: string) => {
    if (body[0] !== "#") return NAMED_ENTITIES[body] ?? match;
    const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
  });
}

/** Characters that end a tag or attribute name. */
function isNameEnd(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "/" || char === ">" || char === "=";
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** Forgiving XML parser: elements, attributes (single/double quotes), text, CDATA, entity decoding
 *  (&lt; &gt; &amp; &quot; &apos; &#N; &#xN;, plus common HTML named entities like &nbsp; for XHTML), skips
 *  <?…?>, <!--…-->, <!DOCTYPE…>. Names keep their prefix ("w:p"). Unclosed tags are closed at end. Returns a synthetic root element named "#document". */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { type: "element", name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const length = source.length;
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;

  /** Append text, merging with a preceding text node (e.g. text next to CDATA). */
  const addText = (text: string) => {
    if (!text) return;
    const children = stack[stack.length - 1].children;
    const last = children[children.length - 1];
    if (last?.type === "text") last.text += text;
    else children.push({ type: "text", text });
  };

  /** Index just past `terminator` searched from `from`, or the end of input when it's missing. */
  const skipPast = (terminator: string, from: number) => {
    const at = source.indexOf(terminator, from);
    return at < 0 ? length : at + terminator.length;
  };

  while (index < length) {
    const open = source.indexOf("<", index);
    if (open < 0) {
      addText(decodeEntities(source.slice(index)));
      break;
    }
    if (open > index) addText(decodeEntities(source.slice(index, open)));
    index = open;

    if (source.startsWith("<!--", index)) {
      index = skipPast("-->", index + 4);
    } else if (source.startsWith("<![CDATA[", index)) {
      const end = source.indexOf("]]>", index + 9);
      addText(source.slice(index + 9, end < 0 ? length : end));
      index = end < 0 ? length : end + 3;
    } else if (source.startsWith("<?", index)) {
      index = skipPast("?>", index + 2);
    } else if (source.startsWith("<!", index)) {
      // DOCTYPE and friends: skip to the closing ">", stepping over quoted strings and an internal [subset].
      let depth = 0;
      let quote = "";
      index += 2;
      while (index < length) {
        const char = source[index++];
        if (quote) {
          if (char === quote) quote = "";
        } else if (char === '"' || char === "'") quote = char;
        else if (char === "[") depth++;
        else if (char === "]") depth--;
        else if (char === ">" && depth <= 0) break;
      }
    } else if (source[index + 1] === "/") {
      const end = skipPast(">", index + 2);
      const name = source.slice(index + 2, end - 1).trim();
      index = end;
      // Pop back to the matching open element; a closer with no match is ignored.
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth].name === name) {
          stack.length = depth;
          break;
        }
      }
    } else {
      let cursor = index + 1;
      while (cursor < length && !isNameEnd(source[cursor])) cursor++;
      const name = source.slice(index + 1, cursor);
      if (!/^[A-Za-z_:\u00c0-\uffff]/.test(name)) {
        // Not a tag ("a < b"): keep the "<" as text.
        addText("<");
        index += 1;
        continue;
      }
      const element: XmlElement = { type: "element", name, attrs: {}, children: [] };
      stack[stack.length - 1].children.push(element);
      let selfClosing = false;
      while (cursor < length) {
        const char = source[cursor];
        if (char === ">") {
          cursor++;
          break;
        }
        if (char === "/" && source[cursor + 1] === ">") {
          selfClosing = true;
          cursor += 2;
          break;
        }
        if (isNameEnd(char)) {
          cursor++; // whitespace, stray "/" or "="
          continue;
        }
        const nameStart = cursor;
        while (cursor < length && !isNameEnd(source[cursor])) cursor++;
        const attrName = source.slice(nameStart, cursor);
        while (cursor < length && isSpace(source[cursor])) cursor++;
        let value = "";
        if (source[cursor] === "=") {
          cursor++;
          while (cursor < length && isSpace(source[cursor])) cursor++;
          const quote = source[cursor];
          if (quote === '"' || quote === "'") {
            const close = source.indexOf(quote, cursor + 1);
            const end = close < 0 ? length : close;
            value = source.slice(cursor + 1, end);
            cursor = end + 1;
          } else {
            const valueStart = cursor;
            while (cursor < length && !isSpace(source[cursor]) && source[cursor] !== ">") cursor++;
            value = source.slice(valueStart, cursor);
          }
        }
        if (!Object.hasOwn(element.attrs, attrName)) element.attrs[attrName] = decodeEntities(value);
      }
      index = cursor;
      if (!selfClosing) stack.push(element);
    }
  }
  return root;
}

/** Local name without prefix: "w:p" -> "p". */
export function localName(name: string): string {
  return name.slice(name.indexOf(":") + 1);
}

/** Direct children elements, optionally filtered by local name. */
export function childElements(el: XmlElement, local?: string): XmlElement[] {
  const out: XmlElement[] = [];
  for (const child of el.children) {
    if (child.type === "element" && (local === undefined || localName(child.name) === local)) out.push(child);
  }
  return out;
}

/** First descendant (depth-first) with that local name. */
export function findFirst(el: XmlElement, local: string): XmlElement | null {
  for (const child of el.children) {
    if (child.type !== "element") continue;
    if (localName(child.name) === local) return child;
    const found = findFirst(child, local);
    if (found) return found;
  }
  return null;
}

/** All descendants with that local name, document order. */
export function findAll(el: XmlElement, local: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (parent: XmlElement) => {
    for (const child of parent.children) {
      if (child.type !== "element") continue;
      if (localName(child.name) === local) out.push(child);
      visit(child);
    }
  };
  visit(el);
  return out;
}

/** Concatenated text of all descendant text nodes. */
export function textContent(node: XmlNode): string {
  if (node.type === "text") return node.text;
  let out = "";
  for (const child of node.children) out += textContent(child);
  return out;
}

/** Attribute by local name (ignores prefix): attr(el, "val") finds "w:val". */
export function attr(el: XmlElement, local: string): string | undefined {
  if (Object.hasOwn(el.attrs, local)) return el.attrs[local];
  for (const key in el.attrs) {
    if (localName(key) === local) return el.attrs[key];
  }
  return undefined;
}
