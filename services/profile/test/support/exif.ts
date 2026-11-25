/**
 * A minimal EXIF reader for tests: finds the EXIF block in a JPEG (APP1), PNG (eXIf) or WebP
 * (EXIF chunk) and reports whether its first IFD points at a GPS IFD (tag 0x8825). Written here,
 * independent of sharp, so the test does not trust the library it is checking.
 */
export function exifBlock(file: Buffer): Buffer | undefined {
  // JPEG: segments after SOI.
  if (file[0] === 0xff && file[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= file.length && file[at] === 0xff) {
      const marker = file[at + 1] ?? 0;
      if (marker === 0xda) break; // start of scan: no more metadata segments
      const length = file.readUInt16BE(at + 2);
      const body = file.subarray(at + 4, at + 2 + length);
      if (marker === 0xe1 && body.subarray(0, 6).toString('latin1') === 'Exif\0\0') {
        return body.subarray(6);
      }
      at += 2 + length;
    }
    return undefined;
  }
  // PNG: length, type, data, CRC.
  if (file.subarray(1, 4).toString('latin1') === 'PNG') {
    let at = 8;
    while (at + 8 <= file.length) {
      const length = file.readUInt32BE(at);
      const type = file.subarray(at + 4, at + 8).toString('latin1');
      if (type === 'eXIf') {
        const body = file.subarray(at + 8, at + 8 + length);
        return body.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? body.subarray(6) : body;
      }
      at += 12 + length;
    }
    return undefined;
  }
  // WebP: RIFF chunks after the 12-byte header, padded to even lengths.
  if (file.subarray(0, 4).toString('latin1') === 'RIFF') {
    let at = 12;
    while (at + 8 <= file.length) {
      const type = file.subarray(at, at + 4).toString('latin1');
      const length = file.readUInt32LE(at + 4);
      if (type === 'EXIF') {
        const body = file.subarray(at + 8, at + 8 + length);
        return body.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? body.subarray(6) : body;
      }
      at += 8 + length + (length % 2);
    }
  }
  return undefined;
}

/** True when the EXIF block's IFD0 has a GPS IFD pointer. */
export function hasGps(file: Buffer): boolean {
  const tiff = exifBlock(file);
  if (!tiff || tiff.length < 8) return false;
  const little = tiff.subarray(0, 2).toString('latin1') === 'II';
  const u16 = (o: number) => (little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o));
  const u32 = (o: number) => (little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o));
  const ifd = u32(4);
  const count = u16(ifd);
  for (let i = 0; i < count; i += 1) {
    if (u16(ifd + 2 + i * 12) === 0x8825) return true;
  }
  return false;
}
