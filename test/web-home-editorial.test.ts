import { describe, expect, test } from "bun:test";
import type { Category } from "../web/src/api.ts";

// The backend test tsconfig deliberately has no JSX/DOM libs. Bun loads these
// UI-only modules at runtime, without widening that config.
const uiPath = "../web/src/ui/home/";
const { CategoryIndex } = await import(`${uiPath}CategoryIndex.tsx`);
const { HomeTimeDisplay } = await import(`${uiPath}HomeTimeDisplay.tsx`);
const { NormComparison } = await import(`${uiPath}NormComparison.tsx`);

// Inspect the DOM-free components' VNodes without a DOM shim or new dependency.
type NodeProps = Record<string, unknown> & { children?: unknown };
interface TestNode { type: unknown; props: NodeProps }
function nodes(value: unknown): TestNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as TestNode;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) return text((value as TestNode).props.children);
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

describe("Editorial home presentation", () => {
  test("display numerals preserve exact rounded time, carry minutes and handle zero safely", () => {
    for (const [minutes, label, display] of [
      [0, "0m", "0m"], [45, "45m", "45m"], [120, "2h", "2h"],
      [122, "2h 2m", "2h02m"], [59.6, "1h", "1h"],
      [NaN, "0m", "0m"], [Infinity, "0m", "0m"], [-1, "0m", "0m"],
    ] as const) {
      const tree = HomeTimeDisplay({ minutes });
      expect(tree.props["aria-label"]).toBe(label);
      expect(text(tree)).toBe(display);
      expect(nodes(tree).find((node) => node.props.class === "home-time-typeset")?.props["aria-hidden"]).toBe("true");
    }
  });

  test("logged and usual rules share one scale including a norm higher than the actual", () => {
    const tree = NormComparison({ actual: 30, norm: 120, label: "Synthetic day" });
    expect(tree.props.role).toBe("img");
    expect(tree.props["aria-label"]).toContain("30m logged; usual 2h; 1h 30m less");
    const rules = nodes(tree).filter((node) => ["home-norm-actual", "home-norm-usual"].includes(String(node.props.class)));
    expect(rules.map((node) => node.props.style)).toEqual([{ width: "25%" }, { width: "100%" }]);
    const empty = NormComparison({ actual: 0, norm: 0, label: "Empty day" });
    expect(text(empty)).toContain("about usual");
    expect(nodes(empty).filter((node) => String(node.props.class).startsWith("home-norm-u") || node.props.class === "home-norm-actual").map((node) => node.props.style)).toEqual([{ width: "0%" }, { width: "0%" }]);
  });

  test("contents disclosure retains multi-selection, hidden selected categories and All reset", () => {
    let next: Category[] = [];
    const tree = CategoryIndex({
      selected: ["anime", "music"],
      totals: [{ category: "shortform", total_minutes: 47, works: 0, units: 0 }],
      availableCategories: [], onChange: (value: Category[]) => { next = value; },
    });
    expect(tree.type).toBe("details");
    expect(text(tree)).toContain("Anime / Music");
    expect(text(tree)).toContain("Short-form47m");
    const inputs = nodes(tree).filter((node) => node.type === "input");
    expect(inputs).toHaveLength(4); // All + anime + music + time-only short-form
    expect(inputs.map((input) => input.props.checked)).toEqual([false, true, true, false]);
    (inputs[3]!.props.onChange as () => void)();
    expect(next).toEqual(["anime", "music", "shortform"]);
    (inputs[1]!.props.onChange as () => void)();
    expect(next).toEqual(["music"]);
    (inputs[0]!.props.onChange as () => void)();
    expect(next).toEqual([]);
  });

  test("empty archives keep every category reachable", () => {
    const tree = CategoryIndex({ selected: [], totals: [], availableCategories: [], onChange: () => {} });
    const inputs = nodes(tree).filter((node) => node.type === "input");
    expect(inputs).toHaveLength(11);
    expect(inputs[0]!.props.checked).toBe(true);
    expect(nodes(tree).some((node) => node.type === "legend" && text(node).includes("select several"))).toBe(true);
  });

  test("Editorial text and the single accent meet AA on all five paper shades", async () => {
    const shell = await Bun.file(new URL("../web/src/styles/shell.css", import.meta.url)).text();
    const tokens = await Bun.file(new URL("../web/src/styles/tokens.css", import.meta.url)).text();
    function luminance(hex: string): number {
      const rgb = hex.slice(1).match(/../g)!.map((channel) => {
        const value = parseInt(channel, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return rgb[0]! * 0.2126 + rgb[1]! * 0.7152 + rgb[2]! * 0.0722;
    }
    const papers = [...shell.matchAll(/--bg-(?:canvas|surface|surface-raised): (#[\da-f]{6})/g)].map((match) => match[1]!);
    const inks = ["#f2ebdc", "#bcb4a5", "#a49c8e", ...[...tokens.matchAll(/--accent-primary: (#[\da-f]{6})/g)].map((match) => match[1]!)];
    expect(papers.length).toBeGreaterThanOrEqual(15);
    for (const paper of papers) for (const ink of inks) {
      expect((luminance(ink) + 0.05) / (luminance(paper) + 0.05)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
