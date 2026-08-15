import { describe, expect, it } from "vitest";
import {
  extractSummary,
  resolveSummary,
  summaryContract,
  summaryEventData,
  summaryLine,
} from "../src/agent-summary.js";

const block = (text: string): string => ["```summary", text, "```"].join("\n");

describe("summaryContract", () => {
  it("names the fence the parser looks for", () => {
    const contract = summaryContract();
    expect(contract).toContain("```summary");
    expect(extractSummary(contract)).toBeDefined();
  });
});

describe("extractSummary", () => {
  it("reads the block out of surrounding prose", () => {
    const output = [
      "I read the spec and implemented it.",
      block("Added the token refresh endpoint. Reused the existing client."),
      "trailing chatter",
    ].join("\n\n");

    expect(extractSummary(output)).toBe(
      "Added the token refresh endpoint. Reused the existing client.",
    );
  });

  it("takes the last block, so an echoed contract does not win", () => {
    const output = [
      "Understood, I will end with:",
      block("Two to five sentences: what you did, the decisions you made."),
      "Done. Here is the real one:",
      block("Implemented WS-03 and left the rotation policy to WS-04."),
    ].join("\n\n");

    expect(extractSummary(output)).toBe(
      "Implemented WS-03 and left the rotation policy to WS-04.",
    );
  });

  it("tolerates CRLF output and trailing fence padding", () => {
    const output = "prelude\r\n```summary  \r\nDid the thing.\r\n```\r\n";
    expect(extractSummary(output)).toBe("Did the thing.");
  });

  it("returns undefined for a missing, empty, or unterminated block", () => {
    expect(extractSummary("no block at all")).toBeUndefined();
    expect(extractSummary(block("   "))).toBeUndefined();
    expect(extractSummary("```summary\nnever closed")).toBeUndefined();
  });

  it("does not confuse a json block for a summary block", () => {
    const output = '```json\n{ "findings": [] }\n```';
    expect(extractSummary(output)).toBeUndefined();
  });
});

describe("resolveSummary", () => {
  it("reports the agent's own words as available", () => {
    const resolved = resolveSummary(block("Split the helper into two files."));
    expect(resolved).toEqual({
      text: "Split the helper into two files.",
      available: true,
    });
  });

  it("falls back to an output tail rather than failing", () => {
    const resolved = resolveSummary("build finished, all green");
    expect(resolved.available).toBe(false);
    expect(resolved.text).toBe("build finished, all green");
  });

  it("keeps only the tail of a long unformatted reply", () => {
    const resolved = resolveSummary(`${"x".repeat(5000)}END`, 20);
    expect(resolved.available).toBe(false);
    expect(resolved.text).toHaveLength(20);
    expect(resolved.text.endsWith("END")).toBe(true);
  });

  it("degrades to a placeholder when the agent said nothing at all", () => {
    expect(resolveSummary("   ")).toEqual({
      text: "(no output)",
      available: false,
    });
  });
});

describe("summaryEventData", () => {
  it("records the role, the text, and the brief size", () => {
    const summary = resolveSummary(block("Implemented WS-01."));
    expect(summaryEventData("build", "a brief", summary)).toEqual({
      role: "build",
      summary: "Implemented WS-01.",
      summaryAvailable: true,
      promptBytes: 7,
    });
  });

  it("measures the brief in bytes, not characters", () => {
    const summary = resolveSummary(block("ok"));
    const data = summaryEventData("critic", "café", summary);
    expect(data.promptBytes).toBe(5);
  });
});

describe("summaryLine", () => {
  it("collapses a multi-line summary onto one line", () => {
    const summary = resolveSummary(block("First line.\n\n  Second line."));
    expect(summaryLine(summary)).toBe("First line. Second line.");
  });

  it("clips to the limit with an ellipsis", () => {
    const summary = resolveSummary(block("y".repeat(400)));
    const line = summaryLine(summary, 40);
    expect(line).toHaveLength(40);
    expect(line.endsWith("…")).toBe(true);
  });

  it("flags a fallback tail so it is never mistaken for a real summary", () => {
    expect(summaryLine(resolveSummary("exit 0"))).toBe(
      "(no summary block) exit 0",
    );
  });
});
