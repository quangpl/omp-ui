// The `## Report` section agents end their final message with ("Outcome: …", "Tests: …", …).
// Shared by the run report card and the generated PR/MR description.

/** `## Report` (any heading level) and the heading level that ends the section. */
const REPORT_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+report\b[^\n]*$/im;
const ANY_HEADING = /^[ \t]{0,3}(#{1,6})[ \t]+\S/;

/** `Name: value` line in a report (optionally bulleted or bold); `name` is a regex alternation. */
export function reportField(name: string): RegExp {
  return new RegExp(String.raw`^[ \t]*(?:[-*+][ \t]+)?\**(?:${name})\**[ \t]*:\**[ \t]*(.*\S)[ \t]*$`, "im");
}

/** Split the `## Report` section off the text. */
export function splitReport(text: string): { body: string; report: string | null } {
  const match = REPORT_HEADING.exec(text);
  if (!match || match.index === undefined) return { body: text, report: null };
  const level = match[1].length;
  const start = match.index;
  const afterHeading = start + match[0].length;
  const rest = text.slice(afterHeading);
  let end = text.length;
  let offset = afterHeading;
  let inFence = false;
  for (const line of rest.split("\n")) {
    if (/^[ \t]*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    const heading = inFence ? null : ANY_HEADING.exec(line);
    if (heading && heading[1].length <= level && offset > afterHeading) {
      end = offset;
      break;
    }
    offset += line.length + 1;
  }
  return {
    body: `${text.slice(0, start)}${text.slice(end)}`.trim(),
    report: text.slice(afterHeading, end).trim(),
  };
}
