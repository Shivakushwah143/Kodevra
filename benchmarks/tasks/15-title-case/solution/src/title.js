const SMALL_WORDS = new Set(["a", "an", "the", "of", "and", "or", "in", "on"]);
const ACRONYMS = new Set(["api", "http", "https", "html", "css", "json", "url", "uri", "id", "ui", "ip"]);

export function titleCase(text, exceptions = []) {
  const exact = new Map(exceptions.map((word) => [word.toLowerCase(), word]));

  return String(text)
    .split(" ")
    .map((word, index) => {
      if (!word) return word;
      const lower = word.toLowerCase();

      if (exact.has(lower)) return exact.get(lower);
      if (index > 0 && SMALL_WORDS.has(lower)) return lower;
      if (ACRONYMS.has(lower) || (word.length > 1 && word === word.toUpperCase())) return lower.toUpperCase();

      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
