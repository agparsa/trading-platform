import { describe, expect, it } from 'vitest';
import { sniffContentType } from './sniff';
import { ACCEPTED_CONTENT_TYPES } from './state';

const padded = (head: number[]): Uint8Array => {
  const out = new Uint8Array(32);
  out.set(head);
  return out;
};

describe('sniffing a document’s real type', () => {
  it('recognises the four accepted formats by their bytes', () => {
    expect(sniffContentType(padded([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffContentType(padded([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      'image/png',
    );
    expect(
      sniffContentType(padded([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50])),
    ).toBe('image/webp');
    expect(sniffContentType(padded([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]))).toBe('application/pdf');
  });

  it('only ever names a type the platform accepts', () => {
    for (const head of [
      [0xff, 0xd8, 0xff],
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      [0x25, 0x50, 0x44, 0x46, 0x2d],
    ]) {
      const type = sniffContentType(padded(head));
      expect(type).not.toBeNull();
      expect(ACCEPTED_CONTENT_TYPES.has(type ?? '')).toBe(true);
    }
  });

  it('refuses what it cannot identify, however it was labelled', () => {
    expect(sniffContentType(padded([0x3c, 0x73, 0x76, 0x67]))).toBeNull(); // <svg
    expect(sniffContentType(padded([0x3c, 0x68, 0x74, 0x6d, 0x6c]))).toBeNull(); // <html
    expect(sniffContentType(padded([0x47, 0x49, 0x46, 0x38]))).toBeNull(); // GIF8
    expect(sniffContentType(padded([0x4d, 0x5a]))).toBeNull(); // MZ, a Windows executable
    expect(sniffContentType(new Uint8Array(0))).toBeNull();
    expect(sniffContentType(new Uint8Array(5))).toBeNull();
  });

  it('is not fooled by a RIFF that is not WebP', () => {
    // A WAV file starts RIFF....WAVE.
    expect(
      sniffContentType(padded([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45])),
    ).toBeNull();
  });
});
