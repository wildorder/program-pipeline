import { describe, expect, it } from "vitest";
import {
  LEGACY_PLAN_GENERATION,
  specGeneration,
  stampSpecGeneration,
} from "../src/plan-generation.js";

describe("plan generation markers", () => {
  it("stamps and reads a generation without duplicating markers", () => {
    const stamped = stampSpecGeneration("# WS-01\n\nBody\n", "g-2");
    expect(specGeneration(stamped)).toBe("g-2");
    expect(stampSpecGeneration(stamped, "g-3").match(/plan-generation=/gu)).toHaveLength(1);
    expect(specGeneration(stampSpecGeneration(stamped, "g-3"))).toBe("g-3");
  });

  it("names the explicit legacy generation", () => {
    expect(LEGACY_PLAN_GENERATION).toBe("legacy");
  });
});
