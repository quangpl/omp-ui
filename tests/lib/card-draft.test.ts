import { describe, expect, it } from "vitest";
import { BRIEF_NOTE, DESCRIPTION_MAX, cardFromText } from "@/lib/card-draft";

describe("cardFromText", () => {
  it("uses one short line as the title, with no description", () => {
    expect(cardFromText("  Rename the save button \n")).toEqual({
      title: "Rename the save button",
      description: "",
      attached: false,
    });
  });

  it("titles a multi-line text with its first line and keeps the text as the description", () => {
    const text = "# Fix the login page\n\n- the button is misaligned\n- the error is unreadable";
    expect(cardFromText(`\n${text}  \n`)).toEqual({ title: "Fix the login page", description: text, attached: false });
    expect(cardFromText("- Add dark mode\nfollow the system setting").title).toBe("Add dark mode");
  });

  it("cuts a long first line to its first sentence, or clips it", () => {
    const sentence = "Make the board load faster on big projects.";
    const long = `${sentence} ${"It takes several seconds to show anything at all ".repeat(3)}`;
    expect(cardFromText(long).title).toBe(sentence);
    const card = cardFromText("word ".repeat(40));
    expect(card.title.length).toBeLessThanOrEqual(80);
    expect(card.title.endsWith("…")).toBe(true);
  });

  it("attaches a text longer than the description allows", () => {
    const text = `Rewrite the importer\n${"x".repeat(DESCRIPTION_MAX + 100)}`;
    const card = cardFromText(text);
    expect(card.attached).toBe(true);
    expect(card.title).toBe("Rewrite the importer");
    expect(card.description.endsWith(BRIEF_NOTE)).toBe(true);
    expect(card.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
  });

  it("pins the title and description boundaries", () => {
    const line100 = "a".repeat(100);
    expect(cardFromText(line100)).toEqual({ title: line100, description: "", attached: false });
    const line101 = "a".repeat(101);
    const clipped = cardFromText(line101);
    expect(clipped.title.length).toBeLessThanOrEqual(80);
    expect(clipped.description).toBe(line101);
    expect(clipped.attached).toBe(false);

    const atMax = `Title\n${"x".repeat(DESCRIPTION_MAX - 6)}`;
    expect(atMax.length).toBe(DESCRIPTION_MAX);
    expect(cardFromText(atMax)).toMatchObject({ description: atMax, attached: false });
    expect(cardFromText(`${atMax}x`).attached).toBe(true);
  });
});
