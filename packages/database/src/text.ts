export function toPostgresTextProjection(value: string): string {
  // PostgreSQL text cannot represent U+0000. Raw MIME and attachment objects
  // remain byte-for-byte canonical; only the searchable text projection uses
  // the Unicode replacement character for this unsupported code point.
  return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value;
}
