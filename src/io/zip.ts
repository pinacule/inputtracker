/**
 * Minimal ZIP archive reader (and test archive builder).
 *
 * Reads the Central Directory at the end of the archive, supports stored (0)
 * and deflate (8) compression via `node:zlib` `inflateRawSync`, enforces entry
 * and total uncompressed size limits, verifies CRC-32 checksums, and cleanly
 * rejects path traversal, encrypted entries, multi-disk archives, and ZIP64.
 */

import { deflateRawSync, inflateRawSync } from "node:zlib";

const LOCAL_FILE_HEADER_SIG = 0x04034b50;
const CENTRAL_DIR_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EXTRA_HEADER_ID = 0x0001;

const MAX_COMMENT_BYTES = 0xffff;
const MIN_EOCD_BYTES = 22;
const CENTRAL_HEADER_FIXED_BYTES = 46;
const LOCAL_HEADER_FIXED_BYTES = 30;

/** Default maximum compressed archive size: 50 MB. */
export const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
/** Default maximum uncompressed single entry size: 25 MB. */
export const DEFAULT_MAX_ENTRY_BYTES = 25 * 1024 * 1024;
/** Default maximum total uncompressed size across all entries: 50 MB. */
export const DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
/** Default maximum number of entries in an archive: 256. */
export const DEFAULT_MAX_ENTRIES = 256;

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

export interface ZipEntry {
  /** Validated relative path inside the archive (forward slashes, no leading slash). */
  name: string;
  /** Final filename component (e.g. `"anime.csv"`). */
  baseName: string;
  /** Uncompressed file bytes. */
  data: Uint8Array;
  /** Decode `data` as UTF-8 text. */
  text(): string;
}

export interface ReadZipOptions {
  maxArchiveBytes?: number;
  maxEntryBytes?: number;
  maxTotalUncompressedBytes?: number;
  maxEntries?: number;
}

/** Precomputed IEEE 802.3 CRC-32 lookup table. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/** Compute standard unsigned 32-bit CRC-32 checksum. */
export function computeCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Quick magic-bytes check for a ZIP archive (`PK\x03\x04` local header or
 * `PK\x05\x06` empty archive EOCD).
 */
export function isZipBytes(input: Uint8Array | ArrayBuffer): boolean {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < 4) {
    return false;
  }
  return (
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06))
  );
}

/**
 * Validate a ZIP entry path, rejecting absolute paths, drive letters,
 * backslashes, null bytes, and `.` / `..` traversal segments.
 */
export function validateZipEntryPath(rawPath: string): string {
  if (rawPath.length === 0) {
    throw new ZipError("Invalid zip entry: empty filename");
  }
  if (rawPath.includes("\0")) {
    throw new ZipError("Invalid zip entry path: contains null byte");
  }
  if (rawPath.includes("\\")) {
    throw new ZipError(`Invalid zip entry path '${rawPath}': backslashes are not allowed`);
  }
  if (rawPath.startsWith("/")) {
    throw new ZipError(`Invalid zip entry path '${rawPath}': absolute paths are not allowed`);
  }
  if (/^[a-zA-Z]:/.test(rawPath)) {
    throw new ZipError(`Invalid zip entry path '${rawPath}': drive letters are not allowed`);
  }

  const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (trimmed.length === 0) {
    throw new ZipError(`Invalid zip entry path '${rawPath}'`);
  }

  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg === "" || seg === "." || seg === "..") {
      throw new ZipError(`Unsafe zip entry path '${rawPath}': path traversal is not allowed`);
    }
  }

  return rawPath;
}

function hasZip64ExtraField(extra: Uint8Array): boolean {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const headerId = view.getUint16(offset, true);
    const dataSize = view.getUint16(offset + 2, true);
    if (headerId === ZIP64_EXTRA_HEADER_ID) {
      return true;
    }
    offset += 4 + dataSize;
  }
  return false;
}

function findEocdOffset(bytes: Uint8Array, view: DataView): number {
  const minOffset = Math.max(0, bytes.byteLength - MIN_EOCD_BYTES - MAX_COMMENT_BYTES);
  const maxOffset = bytes.byteLength - MIN_EOCD_BYTES;

  for (let pos = maxOffset; pos >= minOffset; pos--) {
    if (view.getUint32(pos, true) === EOCD_SIG) {
      const commentLen = view.getUint16(pos + 20, true);
      if (pos + MIN_EOCD_BYTES + commentLen === bytes.byteLength) {
        return pos;
      }
    }
  }
  return -1;
}

/**
 * Parse and extract all file entries from a ZIP archive in memory.
 */
export function readZip(
  input: Uint8Array | ArrayBuffer,
  opts: ReadZipOptions = {}
): ZipEntry[] {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxArchiveBytes = opts.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const maxEntryBytes = opts.maxEntryBytes ?? DEFAULT_MAX_ENTRY_BYTES;
  const maxTotalUncompressedBytes =
    opts.maxTotalUncompressedBytes ?? DEFAULT_MAX_TOTAL_UNCOMPRESSED_BYTES;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;

  if (bytes.byteLength > maxArchiveBytes) {
    throw new ZipError(
      `Zip archive exceeds maximum allowed size (${bytes.byteLength} bytes, max ${maxArchiveBytes})`
    );
  }
  if (bytes.byteLength < MIN_EOCD_BYTES) {
    throw new ZipError("Invalid zip archive: file is too short");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEocdOffset(bytes, view);
  if (eocdOffset < 0) {
    throw new ZipError("Invalid zip archive: End of Central Directory record not found");
  }

  // Check for a ZIP64 End of Central Directory locator right before EOCD.
  if (
    eocdOffset >= 20 &&
    view.getUint32(eocdOffset - 20, true) === ZIP64_EOCD_LOCATOR_SIG
  ) {
    throw new ZipError("ZIP64 archives are not supported");
  }

  const diskNumber = view.getUint16(eocdOffset + 4, true);
  const cdStartDisk = view.getUint16(eocdOffset + 6, true);
  const entriesOnDisk = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const cdSize = view.getUint32(eocdOffset + 12, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  if (
    diskNumber === 0xffff ||
    cdStartDisk === 0xffff ||
    entriesOnDisk === 0xffff ||
    totalEntries === 0xffff ||
    cdSize === 0xffffffff ||
    cdOffset === 0xffffffff
  ) {
    throw new ZipError("ZIP64 archives are not supported");
  }

  if (diskNumber !== 0 || cdStartDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ZipError("Multi-disk zip archives are not supported");
  }

  if (totalEntries > maxEntries) {
    throw new ZipError(
      `Zip archive contains too many entries (${totalEntries}, max ${maxEntries})`
    );
  }

  if (cdOffset > eocdOffset || cdOffset + cdSize > eocdOffset) {
    throw new ZipError("Invalid zip archive: Central Directory is out of bounds");
  }

  const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let totalUncompressed = 0;
  let cdPos = cdOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (cdPos + CENTRAL_HEADER_FIXED_BYTES > cdOffset + cdSize) {
      throw new ZipError("Invalid zip archive: truncated Central Directory header");
    }

    const sig = view.getUint32(cdPos, true);
    if (sig === ZIP64_EOCD_SIG) {
      throw new ZipError("ZIP64 archives are not supported");
    }
    if (sig !== CENTRAL_DIR_HEADER_SIG) {
      throw new ZipError(
        `Invalid Central Directory file header signature: 0x${sig.toString(16)}`
      );
    }

    const flags = view.getUint16(cdPos + 8, true);
    const method = view.getUint16(cdPos + 10, true);
    const expectedCrc32 = view.getUint32(cdPos + 16, true);
    const compressedSize = view.getUint32(cdPos + 20, true);
    const uncompressedSize = view.getUint32(cdPos + 24, true);
    const nameLen = view.getUint16(cdPos + 28, true);
    const extraLen = view.getUint16(cdPos + 30, true);
    const commentLen = view.getUint16(cdPos + 32, true);
    const diskStart = view.getUint16(cdPos + 34, true);
    const externalAttrs = view.getUint32(cdPos + 38, true);
    const localHeaderOffset = view.getUint32(cdPos + 42, true);

    const headerEnd =
      cdPos + CENTRAL_HEADER_FIXED_BYTES + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize) {
      throw new ZipError("Invalid zip archive: Central Directory entry extends past directory");
    }

    // Bit 0: traditional/PKWARE encryption; Bit 6: strong encryption; method 99: WinZip AES.
    if ((flags & 0x0001) !== 0 || (flags & 0x0040) !== 0 || method === 99) {
      throw new ZipError("Encrypted zip entries are not supported");
    }

    const extraBytes = bytes.subarray(
      cdPos + CENTRAL_HEADER_FIXED_BYTES + nameLen,
      cdPos + CENTRAL_HEADER_FIXED_BYTES + nameLen + extraLen
    );
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart === 0xffff ||
      hasZip64ExtraField(extraBytes)
    ) {
      throw new ZipError("ZIP64 archives are not supported");
    }

    let rawName: string;
    try {
      rawName = utf8Decoder.decode(
        bytes.subarray(
          cdPos + CENTRAL_HEADER_FIXED_BYTES,
          cdPos + CENTRAL_HEADER_FIXED_BYTES + nameLen
        )
      );
    } catch {
      throw new ZipError("Invalid zip entry filename: not valid UTF-8");
    }

    const validatedPath = validateZipEntryPath(rawName);
    cdPos = headerEnd;

    // Reject symlinks (Unix mode S_IFLNK = 0o120000).
    const unixFileType = (externalAttrs >>> 16) & 0o170000;
    if (unixFileType === 0o120000) {
      throw new ZipError(`Symbolic links in zip are not supported: '${validatedPath}'`);
    }

    // Skip directory entries after validating their path.
    const isDirectory =
      validatedPath.endsWith("/") ||
      unixFileType === 0o040000 ||
      (externalAttrs & 0x10) !== 0;
    if (isDirectory && uncompressedSize === 0) {
      continue;
    }

    if (method !== 0 && method !== 8) {
      throw new ZipError(
        `Unsupported zip compression method ${method} for '${validatedPath}' (only stored and deflate are supported)`
      );
    }

    if (compressedSize > maxEntryBytes || uncompressedSize > maxEntryBytes) {
      throw new ZipError(
        `Zip entry '${validatedPath}' exceeds maximum entry size (${uncompressedSize} bytes, max ${maxEntryBytes})`
      );
    }

    if (totalUncompressed + uncompressedSize > maxTotalUncompressedBytes) {
      throw new ZipError(
        `Zip archive exceeds maximum total uncompressed size (${maxTotalUncompressedBytes} bytes)`
      );
    }

    // Validate corresponding Local File Header.
    if (localHeaderOffset + LOCAL_HEADER_FIXED_BYTES > cdOffset) {
      throw new ZipError(
        `Invalid zip archive: local file header out of bounds for '${validatedPath}'`
      );
    }

    const localSig = view.getUint32(localHeaderOffset, true);
    if (localSig !== LOCAL_FILE_HEADER_SIG) {
      throw new ZipError(
        `Invalid local file header signature for '${validatedPath}': 0x${localSig.toString(16)}`
      );
    }

    const localFlags = view.getUint16(localHeaderOffset + 6, true);
    const localMethod = view.getUint16(localHeaderOffset + 8, true);
    if ((localFlags & 0x0001) !== 0 || (localFlags & 0x0040) !== 0 || localMethod === 99) {
      throw new ZipError("Encrypted zip entries are not supported");
    }
    if (localMethod !== method) {
      throw new ZipError(
        `Compression method mismatch between central and local header for '${validatedPath}'`
      );
    }

    const localNameLen = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLen = view.getUint16(localHeaderOffset + 28, true);
    const dataStart =
      localHeaderOffset + LOCAL_HEADER_FIXED_BYTES + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;

    if (dataStart > cdOffset || dataEnd > cdOffset || dataEnd > bytes.byteLength) {
      throw new ZipError(
        `Invalid zip archive: compressed data out of bounds for '${validatedPath}'`
      );
    }

    const compressedData = bytes.subarray(dataStart, dataEnd);
    let data: Uint8Array;

    if (method === 0) {
      if (compressedSize !== uncompressedSize) {
        throw new ZipError(
          `Invalid stored zip entry '${validatedPath}': compressed size (${compressedSize}) != uncompressed size (${uncompressedSize})`
        );
      }
      data = new Uint8Array(compressedData);
    } else {
      const remainingBudget = Math.min(
        maxEntryBytes,
        maxTotalUncompressedBytes - totalUncompressed
      );
      try {
        const inflated = inflateRawSync(compressedData, {
          maxOutputLength: remainingBudget,
        });
        data = new Uint8Array(
          inflated.buffer,
          inflated.byteOffset,
          inflated.byteLength
        );
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (
          code === "ERR_BUFFER_TOO_LARGE" ||
          err instanceof RangeError ||
          /maxOutputLength|buffer/i.test(err instanceof Error ? err.message : "")
        ) {
          throw new ZipError(
            `Zip entry '${validatedPath}' exceeds maximum uncompressed size limit`
          );
        }
        throw new ZipError(
          `Corrupt deflate data in zip entry '${validatedPath}': ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }

      if (data.byteLength !== uncompressedSize) {
        throw new ZipError(
          `Uncompressed size mismatch for '${validatedPath}': expected ${uncompressedSize}, got ${data.byteLength}`
        );
      }
    }

    const actualCrc32 = computeCrc32(data);
    if (actualCrc32 !== expectedCrc32) {
      throw new ZipError(
        `CRC-32 checksum mismatch for '${validatedPath}' (expected 0x${expectedCrc32.toString(
          16
        )}, got 0x${actualCrc32.toString(16)})`
      );
    }

    totalUncompressed += data.byteLength;
    const segments = validatedPath.split("/");
    const baseName = segments[segments.length - 1]!;

    entries.push({
      name: validatedPath,
      baseName,
      data,
      text: () => new TextDecoder("utf-8").decode(data),
    });
  }

  if (cdPos !== cdOffset + cdSize) {
    throw new ZipError("Invalid zip archive: Central Directory size mismatch");
  }

  return entries;
}

export interface CreateZipInputEntry {
  name: string;
  data: string | Uint8Array;
  /** 0 = stored, 8 = deflate (default 8). */
  method?: 0 | 8;
}

/**
 * Build a standard ZIP archive in memory (used by tests).
 */
export function createZip(entries: readonly CreateZipInputEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const rawData =
      typeof entry.data === "string" ? encoder.encode(entry.data) : entry.data;
    const method = entry.method ?? 8;
    const crc = computeCrc32(rawData);

    let compData: Uint8Array;
    if (method === 0) {
      compData = rawData;
    } else {
      const deflated = deflateRawSync(rawData);
      compData = new Uint8Array(
        deflated.buffer,
        deflated.byteOffset,
        deflated.byteLength
      );
    }

    const localHeader = new Uint8Array(LOCAL_HEADER_FIXED_BYTES + nameBytes.byteLength);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, LOCAL_FILE_HEADER_SIG, true);
    lv.setUint16(4, 20, true); // version needed (2.0)
    lv.setUint16(6, 0x0800, true); // UTF-8 flag
    lv.setUint16(8, method, true);
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0x21, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compData.byteLength, true);
    lv.setUint32(22, rawData.byteLength, true);
    lv.setUint16(26, nameBytes.byteLength, true);
    lv.setUint16(28, 0, true); // extra len
    localHeader.set(nameBytes, LOCAL_HEADER_FIXED_BYTES);

    const centralHeader = new Uint8Array(
      CENTRAL_HEADER_FIXED_BYTES + nameBytes.byteLength
    );
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, CENTRAL_DIR_HEADER_SIG, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true); // UTF-8 flag
    cv.setUint16(10, method, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compData.byteLength, true);
    cv.setUint32(24, rawData.byteLength, true);
    cv.setUint16(28, nameBytes.byteLength, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    centralHeader.set(nameBytes, CENTRAL_HEADER_FIXED_BYTES);

    localParts.push(localHeader, compData);
    centralParts.push(centralHeader);
    offset += localHeader.byteLength + compData.byteLength;
  }

  const cdOffset = offset;
  const cdSize = centralParts.reduce((s, p) => s + p.byteLength, 0);

  const eocd = new Uint8Array(MIN_EOCD_BYTES);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIG, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // cd start disk
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);
  ev.setUint16(20, 0, true); // comment length

  const totalBytes = cdOffset + cdSize + MIN_EOCD_BYTES;
  const out = new Uint8Array(totalBytes);
  let pos = 0;
  for (const part of localParts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  for (const part of centralParts) {
    out.set(part, pos);
    pos += part.byteLength;
  }
  out.set(eocd, pos);
  return out;
}
