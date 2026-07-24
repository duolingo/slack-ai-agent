/**
 * Smarter Slack message splitting.
 *
 * Slack has a hard ~3001 character limit per message. When a response is
 * longer than that we need to break it into multiple messages. Naively slicing
 * every `maxLength` characters produces ugly output: words get cut in half and
 * triple-backtick code fences end up unbalanced (the rest of the message
 * renders as code, or not).
 *
 * `splitMessageForSlack` packs the text into chunks that:
 *   - prefer to break on a line break (`\n`), then a space, all within the
 *     length budget;
 *   - never break in the middle of a word unless a single token is itself
 *     longer than the budget;
 *   - keep code fences balanced — if a chunk ends inside a ``` fence it is
 *     closed at the end of the chunk and reopened at the start of the next one;
 *   - are suffixed with `\n\n_[Part i/n]_` when there is more than one chunk.
 */

const PART_SUFFIX = (i: number, n: number) => `\n\n_[Part ${i}/${n}]_`;
const FENCE = "```";

/**
 * Determine where to cut `text` so the first chunk fits within `max`.
 * Returns the exclusive end index of the chunk and the start index of the
 * remainder (which may skip a separator like a space or newline).
 */
function findCut(text: string, max: number): { end: number; next: number } {
  const window = text.substring(0, max);

  // Prefer a line break, then a space — but only if it makes real progress
  // (index > 0).
  const line = window.lastIndexOf("\n");
  if (line > 0) {
    return { end: line, next: line + 1 };
  }
  const space = window.lastIndexOf(" ");
  if (space > 0) {
    return { end: space, next: space + 1 };
  }

  // No natural break point within budget: hard split (a lone token longer than
  // the budget).
  return { end: max, next: max };
}

/**
 * Pack `text` into chunks whose content length stays within `maxLength`
 * (except for indivisible tokens that exceed it on their own).
 */
function packChunks(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    if (rest.length <= maxLength) {
      chunks.push(rest);
      break;
    }
    const { end, next } = findCut(rest, maxLength);
    chunks.push(rest.substring(0, end));
    rest = rest.substring(next);
  }

  return chunks;
}

/**
 * Balance triple-backtick code fences across chunk boundaries. If a chunk ends
 * while a fence is open, close it with a trailing ``` and reopen the fence at
 * the start of the following chunk.
 */
function balanceCodeFences(chunks: string[]): string[] {
  let openAcrossBoundary = false;
  return chunks.map(chunk => {
    const prefix = openAcrossBoundary ? `${FENCE}\n` : "";
    const fenceCount = (chunk.match(/```/g) || []).length;
    const togglesOdd = fenceCount % 2 === 1;
    // Whether we end inside a fence, accounting for an inherited open fence.
    const endsOpen = openAcrossBoundary !== togglesOdd;
    const suffix = endsOpen ? `\n${FENCE}` : "";
    openAcrossBoundary = endsOpen;
    return prefix + chunk + suffix;
  });
}

/**
 * Split `text` into Slack-sized chunks. See the module docblock for the rules.
 *
 * @param text      The message to split.
 * @param maxLength The per-chunk content budget (defaults to 2900, leaving
 *                  headroom under Slack's ~3001 limit for the part suffix and
 *                  any code-fence markers).
 */
export function splitMessageForSlack(
  text: string,
  maxLength: number = 2900,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const rawChunks = packChunks(text, maxLength);
  const fenced = balanceCodeFences(rawChunks);

  if (fenced.length <= 1) {
    return fenced;
  }

  const n = fenced.length;
  return fenced.map((chunk, index) => chunk + PART_SUFFIX(index + 1, n));
}
