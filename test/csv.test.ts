import { describe, expect, test } from "bun:test";
import {
  CsvParseError,
  escapeCsvField,
  parseCsvObjects,
  parseCsvRows,
  splitCsvList,
} from "../src/io/csv.ts";

describe("src/io/csv.ts", () => {
  test("parses RFC 4180 CSV with commas, doubled quotes, embedded newlines, CRLF and BOM", () => {
    const csv =
      '\uFEFFtitle,author,notes\r\n' +
      '"Synthetic, Book","Author ""A"" Name","Line 1\r\nLine 2"\r\n' +
      "Plain Title,Plain Author,\r\n";

    const rows = parseCsvRows(csv);
    expect(rows).toEqual([
      ["title", "author", "notes"],
      ["Synthetic, Book", 'Author "A" Name', "Line 1\nLine 2"],
      ["Plain Title", "Plain Author", ""],
    ]);

    const table = parseCsvObjects(csv);
    expect(table.headers).toEqual(["title", "author", "notes"]);
    expect(table.rows).toEqual([
      {
        title: "Synthetic, Book",
        author: 'Author "A" Name',
        notes: "Line 1\nLine 2",
      },
      {
        title: "Plain Title",
        author: "Plain Author",
        notes: "",
      },
    ]);
  });

  test("splits semicolon-separated lists inside a field", () => {
    expect(splitCsvList("Action; Adventure; Drama")).toEqual([
      "Action",
      "Adventure",
      "Drama",
    ]);
    expect(splitCsvList("Wit Studio; MAPPA ; Wit Studio")).toEqual([
      "Wit Studio",
      "MAPPA",
    ]);
    expect(splitCsvList("")).toEqual([]);
    expect(splitCsvList(null)).toEqual([]);
    expect(splitCsvList(undefined)).toEqual([]);
  });

  test("rejects unclosed quotes and mismatched column counts", () => {
    expect(() => parseCsvRows('a,b\n"unclosed,1\n')).toThrow(CsvParseError);
    expect(() => parseCsvObjects("a,b,c\n1,2\n")).toThrow(CsvParseError);
  });

  test("escapeCsvField round-trips special characters", () => {
    expect(escapeCsvField('Hello, "World"\nNext')).toBe('"Hello, ""World""\nNext"');
  });
});
