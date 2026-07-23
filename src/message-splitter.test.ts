import { splitMessageForSlack } from "./message-splitter";

// Strip the "\n\n_[Part i/n]_" suffix so we can assert on chunk content.
const PART_RE = /\n\n_\[Part \d+\/\d+\]_$/;
const stripPart = (chunk: string) => chunk.replace(PART_RE, "");

describe("splitMessageForSlack", () => {
  describe("short messages", () => {
    it("returns a single chunk when text fits the budget", () => {
      expect(splitMessageForSlack("hello", 100)).toEqual(["hello"]);
    });

    it("returns a single chunk exactly at the budget with no part suffix", () => {
      const text = "a".repeat(30);
      const chunks = splitMessageForSlack(text, 30);
      expect(chunks).toEqual([text]);
      expect(chunks[0]).not.toContain("[Part");
    });
  });

  describe("part indicators", () => {
    it("suffixes every chunk when there is more than one", () => {
      const chunks = splitMessageForSlack("a".repeat(100), 30);
      expect(chunks.length).toBe(4); // 30 + 30 + 30 + 10
      chunks.forEach((chunk, i) => {
        expect(chunk).toContain(`[Part ${i + 1}/${chunks.length}]`);
      });
    });

    it("does not add a part indicator for a single chunk", () => {
      expect(splitMessageForSlack("short", 100)[0]).not.toContain("[Part");
    });

    it("keeps chunk budget separate from the part suffix", () => {
      const chunks = splitMessageForSlack("a".repeat(100), 30);
      // First chunk content is 30 chars; the suffix is added on top.
      expect(stripPart(chunks[0])).toBe("a".repeat(30));
    });
  });

  describe("break-point preference", () => {
    it("breaks on the last line break within budget", () => {
      const text = "line one\nline two\nline three is quite long indeed";
      const chunks = splitMessageForSlack(text, 20);
      expect(stripPart(chunks[0])).toBe("line one\nline two");
      // The line separator is consumed, not repeated.
      expect(stripPart(chunks[1]).startsWith("line three")).toBe(true);
    });

    it("falls back to a space when there is no line break", () => {
      const text = "alpha beta gamma delta epsilon zeta eta theta";
      const chunks = splitMessageForSlack(text, 20);
      expect(stripPart(chunks[0])).toBe("alpha beta gamma");
      // No chunk should start or end mid-word.
      chunks.forEach(chunk => {
        expect(stripPart(chunk)).not.toMatch(/^ | $/);
      });
    });
  });

  describe("word integrity", () => {
    it("never breaks mid-word when a break point exists", () => {
      const text = "word ".repeat(30).trim();
      const chunks = splitMessageForSlack(text, 24);
      chunks.forEach(chunk => {
        stripPart(chunk)
          .split(" ")
          .forEach(token => {
            if (token) expect(token).toBe("word");
          });
      });
    });

    it("breaks mid-word only when a lone token exceeds the budget", () => {
      const chunks = splitMessageForSlack("x".repeat(50), 20);
      expect(stripPart(chunks[0]).length).toBe(20);
      expect(stripPart(chunks[0])).toBe("x".repeat(20));
      // Reassembling the content reproduces the original token.
      expect(chunks.map(stripPart).join("")).toBe("x".repeat(50));
    });
  });

  describe("code fence balancing", () => {
    it("closes an open fence and reopens it in the next chunk", () => {
      const code = "const line = 1;\n".repeat(20);
      const text = "```\n" + code + "```";
      const chunks = splitMessageForSlack(text, 80);
      expect(chunks.length).toBeGreaterThan(1);
      chunks.forEach(chunk => {
        const content = stripPart(chunk);
        const fences = (content.match(/```/g) || []).length;
        // Each rendered chunk must have balanced (even) fences.
        expect(fences % 2).toBe(0);
      });
      // The first chunk should close its fence at the end.
      expect(stripPart(chunks[0]).endsWith("```")).toBe(true);
      // A middle/last chunk should reopen a fence at the start.
      expect(stripPart(chunks[1]).startsWith("```")).toBe(true);
    });

    it("leaves balanced fences untouched when a fence fits in one chunk", () => {
      const text = "```\nshort code\n```";
      expect(splitMessageForSlack(text, 100)).toEqual([text]);
    });
  });
});
