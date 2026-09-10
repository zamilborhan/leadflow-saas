/** Join class names, skipping falsy values. Single place for conditional classes. */
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
