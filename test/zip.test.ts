import { describe, expect, test } from "bun:test";
import { deflateRawSync } from "node:zlib";
import {
  computeCrc32,
  createZip,
  isZipBytes,
  readZip,
  validateZipEntryPath,
  ZipError,
} from "../src/io/zip.ts";

describe("src/io/zip.ts", () => {
  test("computeCrc32 matches standard IEEE 802.3 test vector", () => {
    const bytes = new TextEncoder().encode("123456789");
    expect(computeCrc32(bytes)).toBe(0xcbf43926);
    expect(computeCrc32(new Uint8Array(0))).toBe(0);
  });

  test("reads stored (method 0) and deflate (method 8) entries from central directory", () => {
    const zipBytes = createZip([
      {
        name: "achriom-library-2026-10-18/anime.csv",
        data: "title,episodes\nSynthetic Saga,24\n",
        method: 8,
      },
      {
        name: "achriom-library-2026-10-18/books.csv",
        data: "title,author\nSynthetic Book,Author Name\n",
        method: 0,
      },
      {
        name: "empty.csv",
        data: "",
        method: 0,
      },
    ]);

    expect(isZipBytes(zipBytes)).toBe(true);
    expect(isZipBytes(new Uint8Array([1, 2, 3, 4]))).toBe(false);

    const entries = readZip(zipBytes);
    expect(entries).toHaveLength(3);

    expect(entries[0]?.name).toBe("achriom-library-2026-10-18/anime.csv");
    expect(entries[0]?.baseName).toBe("anime.csv");
    expect(entries[0]?.text()).toBe("title,episodes\nSynthetic Saga,24\n");

    expect(entries[1]?.name).toBe("achriom-library-2026-10-18/books.csv");
    expect(entries[1]?.baseName).toBe("books.csv");
    expect(entries[1]?.text()).toBe("title,author\nSynthetic Book,Author Name\n");

    expect(entries[2]?.name).toBe("empty.csv");
    expect(entries[2]?.text()).toBe("");
  });

  test("rejects path traversal, absolute paths, drive letters, backslashes and null bytes", () => {
    const unsafePaths = [
      "../anime.csv",
      "achriom/../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "folder\\anime.csv",
      "folder//anime.csv",
      "./anime.csv",
      "folder/./anime.csv",
      "anime\0.csv",
      "",
    ];

    for (const badPath of unsafePaths) {
      expect(() => validateZipEntryPath(badPath)).toThrow(ZipError);
      const badZip = createZip([{ name: badPath || "..", data: "x", method: 0 }]);
      expect(() => readZip(badZip)).toThrow(ZipError);
    }
  });

  test("enforces archive size, single entry size, total uncompressed size, and entry count limits", () => {
    const bigText = "A".repeat(10_000);
    const zip = createZip([
      { name: "one.csv", data: bigText, method: 8 },
      { name: "two.csv", data: bigText, method: 8 },
    ]);

    // Archive size limit
    expect(() => readZip(zip, { maxArchiveBytes: 50 })).toThrow(/maximum allowed size/i);

    // Single entry uncompressed limit
    expect(() => readZip(zip, { maxEntryBytes: 5_000 })).toThrow(/exceeds maximum/i);

    // Total uncompressed limit across entries (each is 10_000, total 20_000 > 15_000)
    expect(() =>
      readZip(zip, { maxEntryBytes: 12_000, maxTotalUncompressedBytes: 15_000 })
    ).toThrow(/maximum total uncompressed size/i);

    // Entry count limit
    expect(() => readZip(zip, { maxEntries: 1 })).toThrow(/too many entries/i);
  });

  test("stops inflateRawSync immediately when a deflate stream expands past maxEntryBytes even if header lies", () => {
    const raw = new Uint8Array(20_000).fill(65);
    const compressed = new Uint8Array(deflateRawSync(raw));
    const zip = createZip([{ name: "bomb.csv", data: raw, method: 8 }]);

    // Tamper the central directory and local header to lie that uncompressedSize = 100
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    // Local header uncompressed size is at offset 22
    view.setUint32(22, 100, true);
    // Central directory starts at 30 + nameLen (8) + compressed.byteLength
    const cdOffset = 38 + compressed.byteLength;
    view.setUint32(cdOffset + 24, 100, true);

    expect(() => readZip(zip, { maxEntryBytes: 1_000 })).toThrow(ZipError);
  });

  test("rejects encrypted zip entries", () => {
    const zip = createZip([{ name: "anime.csv", data: "title\nA\n", method: 0 }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

    // Set bit 0 (encrypted) in Central Directory general purpose bit flag
    // Local header (30 + 9) + data (8) = 47
    const cdOffset = view.getUint32(zip.byteLength - 6, true);
    view.setUint16(cdOffset + 8, 0x0001, true);

    expect(() => readZip(zip)).toThrow(/encrypted/i);
  });

  test("rejects ZIP64 archives cleanly", () => {
    // 1. EOCD with 0xffff total entries sentinel
    const zip1 = createZip([{ name: "anime.csv", data: "title\nA\n", method: 0 }]);
    const view1 = new DataView(zip1.buffer, zip1.byteOffset, zip1.byteLength);
    view1.setUint16(zip1.byteLength - 12, 0xffff, true);
    expect(() => readZip(zip1)).toThrow(/ZIP64/i);

    // 2. Central directory entry with 0xffffffff uncompressed size sentinel
    const zip2 = createZip([{ name: "anime.csv", data: "title\nA\n", method: 0 }]);
    const view2 = new DataView(zip2.buffer, zip2.byteOffset, zip2.byteLength);
    const cdOffset2 = view2.getUint32(zip2.byteLength - 6, true);
    view2.setUint32(cdOffset2 + 24, 0xffffffff, true);
    expect(() => readZip(zip2)).toThrow(/ZIP64/i);
  });

  test("rejects corrupted CRC-32 checksums and unsupported compression methods", () => {
    const zip = createZip([{ name: "anime.csv", data: "title\nA\n", method: 0 }]);
    // Flip a byte in the stored file payload
    zip[39] = zip[39]! ^ 0xff;
    expect(() => readZip(zip)).toThrow(/CRC-32/i);

    // Unsupported compression method (e.g. 12 = BZIP2)
    const zipMethod = createZip([{ name: "anime.csv", data: "title\nA\n", method: 0 }]);
    const view = new DataView(zipMethod.buffer, zipMethod.byteOffset, zipMethod.byteLength);
    const cdOffset = view.getUint32(zipMethod.byteLength - 6, true);
    view.setUint16(8, 12, true);
    view.setUint16(cdOffset + 10, 12, true);
    expect(() => readZip(zipMethod)).toThrow(/compression method/i);
  });
});
