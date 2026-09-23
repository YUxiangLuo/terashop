// Stream byte limits, independent of Content-Length and upstream JSON schemas.
// Auth/introspection/credential receipts fit in 64 KiB; business lists opt into
// a larger bound. Reject whole responses rather than returning truncated data.
export async function readBackendJson(response: Response, maxBytes = 64 * 1024): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('response body unavailable');
  const bytes = new Uint8Array(maxBytes);
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - length) throw new Error('response body too large');
      bytes.set(value, length);
      length += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, length)));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
