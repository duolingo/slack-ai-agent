import {
  passesSmartReplyStructuralFilter,
  buildClassifierPrompt,
  parseClassifierDecision,
} from "./smart-reply-filter";

describe("passesSmartReplyStructuralFilter", () => {
  it("rejects undefined and empty text", () => {
    expect(passesSmartReplyStructuralFilter(undefined)).toBe(false);
    expect(passesSmartReplyStructuralFilter("")).toBe(false);
    expect(passesSmartReplyStructuralFilter("   ")).toBe(false);
  });

  it("rejects very short chatter", () => {
    expect(passesSmartReplyStructuralFilter("thanks!")).toBe(false);
    expect(passesSmartReplyStructuralFilter("lgtm")).toBe(false);
  });

  it("accepts a short question so the classifier can weigh in", () => {
    expect(passesSmartReplyStructuralFilter("What is 5*0?")).toBe(true);
    // Even without a question mark, a short genuine ask clears the lowered bar.
    expect(passesSmartReplyStructuralFilter("what is 5*0")).toBe(true);
  });

  it("accepts a substantive question", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "why is the prod deploy failing on the migration step?",
      ),
    ).toBe(true);
  });

  it("accepts an actionable request even without a question mark", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "can someone make a PR to add a comment in this file",
      ),
    ).toBe(true);
  });

  it("does not strip markup: a pasted error in a code block is kept for the classifier", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "```\nTypeError: Cannot read properties of undefined (reading 'id')\n```",
      ),
    ).toBe(true);
  });

  it("keeps a request whose substance is a link", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "how do i use <https://example.com/docs|this api> here",
      ),
    ).toBe(true);
  });

  it("accepts a normal request that happens to lead with a mention", () => {
    expect(
      passesSmartReplyStructuralFilter(
        "<@user> can you look at the failing build please",
      ),
    ).toBe(true);
  });
});

describe("parseClassifierDecision", () => {
  it("treats a clean YES as help", () => {
    expect(parseClassifierDecision("YES")).toBe(true);
    expect(parseClassifierDecision(" yes ")).toBe(true);
  });

  it("ignores trailing punctuation and markdown around YES", () => {
    expect(parseClassifierDecision("YES.")).toBe(true);
    expect(parseClassifierDecision("**YES**")).toBe(true);
  });

  it("treats NO and anything ambiguous as no help", () => {
    expect(parseClassifierDecision("NO")).toBe(false);
    expect(parseClassifierDecision("no, this is chatter")).toBe(false);
    expect(parseClassifierDecision("maybe")).toBe(false);
    expect(parseClassifierDecision("")).toBe(false);
    expect(parseClassifierDecision(undefined)).toBe(false);
  });
});

describe("buildClassifierPrompt", () => {
  it("embeds the candidate message and asks for a YES/NO answer", () => {
    const prompt = buildClassifierPrompt("can someone open a PR for me");
    expect(prompt).toContain("can someone open a PR for me");
    expect(prompt).toContain("YES or NO");
  });
});
