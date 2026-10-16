/** Lowercase without accents, so "sesion" finds "Sesión". */
const normalize = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

/** Every word of the query appears somewhere in the text, in any order. */
export function matches(query: string, haystack: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const text = normalize(haystack);
  return words.every((word) => text.includes(word));
}
