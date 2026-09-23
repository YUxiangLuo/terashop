export const mediaExtensions = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

export interface MediaRequest {
  request_id: string;
  content_type: keyof typeof mediaExtensions;
  byte_size: number;
  sha256: string;
}
export interface ManagedMedia extends MediaRequest {
  id: string;
  state: "uploading" | "staged" | "retained" | "discard_prepared" | "discarded";
  upload_status: "not_started" | "pending" | "settled";
  published: boolean;
}
const uuid = (value: unknown) =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    value,
  );

export function isMediaRequest(value: unknown): value is MediaRequest {
  if (!value || typeof value !== "object") return false;
  const v = value as MediaRequest;
  return (
    uuid(v.request_id) &&
    Object.hasOwn(mediaExtensions, v.content_type) &&
    Number.isInteger(v.byte_size) &&
    v.byte_size > 0 &&
    v.byte_size <= 1048576 &&
    typeof v.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(v.sha256)
  );
}

export function sameMedia(a: MediaRequest, b: MediaRequest): boolean {
  return (
    a.request_id === b.request_id &&
    a.content_type === b.content_type &&
    a.byte_size === b.byte_size &&
    a.sha256 === b.sha256
  );
}

export function mediaReceipt(
  value: unknown,
  request: MediaRequest,
): ManagedMedia {
  const v = value as ManagedMedia;
  if (
    !isMediaRequest(value) ||
    !uuid(v.id) ||
    !sameMedia(v, request) ||
    ![
      "uploading",
      "staged",
      "retained",
      "discard_prepared",
      "discarded",
    ].includes(v.state) ||
    !["not_started", "pending", "settled"].includes(v.upload_status) ||
    typeof v.published !== "boolean" ||
    (v.published && v.state !== "retained") ||
    (["discard_prepared", "discarded"].includes(v.state) &&
      v.upload_status !== "settled")
  ) {
    throw Error(
      "Unconfirmed media receipt. Check current state using the retained request ID.",
    );
  }
  return v;
}

export async function mediaFile(file: File, requestId: string) {
  if (
    !Object.hasOwn(mediaExtensions, file.type) ||
    file.size < 1 ||
    file.size > 1048576
  )
    throw Error("Choose a non-empty JPEG, PNG or WebP image up to 1 MiB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
  const request: MediaRequest = {
    request_id: requestId,
    content_type: file.type as MediaRequest["content_type"],
    byte_size: bytes.length,
    sha256,
  };
  // Chunking avoids a spread-argument stack overflow for a 1 MiB image.
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { request, data_base64: btoa(binary) };
}
