/**
 * Squeezing the document before it crosses the wire.
 *
 * The whole budget goes up on every save, and it is JSON: thousands of
 * transactions all carrying the same twenty field names. That compresses to
 * roughly a tenth of its size, which is the difference between a household
 * budget fitting comfortably inside a free tier and not.
 *
 * Base64 rather than raw bytes, so the compressed form travels inside the same
 * JSON body everything else uses. That costs a third back, which still leaves
 * it six or seven times smaller and avoids a second content type, a second
 * parser and a second thing to get wrong.
 *
 * `CompressionStream` has been in every browser since 2023. Where it is
 * missing the callers fall back to sending the document as it always was, so
 * an old browser saves a large document rather than no document.
 */

export const canCompress = (): boolean =>
  typeof CompressionStream === "function" && typeof DecompressionStream === "function";

const toBase64 = (bytes: Uint8Array): string => {
  // In chunks: apply() on a megabyte of arguments overflows the call stack,
  // and this runs on documents that size.
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(out);
};

const fromBase64 = (b64: string): Uint8Array<ArrayBuffer> => {
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** Gzips text and returns it base64-encoded. */
export async function pack(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return toBase64(bytes);
}

/** The other way: base64 gzip back to the text it was made from. */
export async function unpack(b64: string): Promise<string> {
  const bytes = fromBase64(b64);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}
