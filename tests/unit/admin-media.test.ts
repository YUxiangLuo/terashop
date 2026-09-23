import { expect, test } from 'bun:test';
import { isMediaRequest, mediaFile, mediaReceipt, sameMedia } from '../../admin/src/lib/media';

const request = {
  request_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  content_type: 'image/png' as const,
  byte_size: 3,
  sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
};
const receipt = {
  ...request,
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  state: 'staged',
  upload_status: 'settled',
  published: false,
} as const;
test('media file fingerprints retain the original byte identity and enforce the shared size limit', async () => {
  const result = await mediaFile(new File(['abc'], 'x.png', { type: 'image/png' }), request.request_id);
  expect(result).toEqual({ request, data_base64: 'YWJj' });
  const max = await mediaFile(
    new File([new Uint8Array(1048576)], 'x.webp', { type: 'image/webp' }),
    request.request_id,
  );
  expect(atob(max.data_base64).length).toBe(1048576);
  for (const [bytes, type] of [
    [0, 'image/png'],
    [1048577, 'image/png'],
    [1, 'image/svg+xml'],
  ] as const)
    await expect(
      mediaFile(new File([new Uint8Array(bytes)], 'x', { type }), request.request_id),
    ).rejects.toThrow('1 MiB');
});
test('media recovery rejects mismatched identities and inconsistent publication receipts', () => {
  expect(isMediaRequest(request)).toBe(true);
  expect(mediaReceipt(receipt, request)).toEqual(receipt);
  expect(mediaReceipt({ ...receipt, state: 'retained', published: true }, request).published).toBe(true);
  for (const changes of [
    { request_id: receipt.id },
    { sha256: '0'.repeat(64) },
    { byte_size: 4 },
    { content_type: 'image/jpeg' },
  ] as const) {
    expect(sameMedia({ ...request, ...changes }, request)).toBe(false);
    expect(() => mediaReceipt({ ...receipt, ...changes }, request)).toThrow('Unconfirmed');
  }
  for (const bad of [
    null,
    {},
    { ...receipt, id: '../../x' },
    { ...receipt, published: true },
    { ...receipt, state: 'discarded', upload_status: 'pending' },
    { ...receipt, upload_status: 'unknown' },
  ])
    expect(() => mediaReceipt(bad, request)).toThrow('Unconfirmed');
  expect(isMediaRequest({ ...request, byte_size: 1048577 })).toBe(false);
});
