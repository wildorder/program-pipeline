import { describe, expect, it } from "vitest";
import {
  at,
  because,
  countBySeverity,
  fingerprint,
  haltsConvergence,
  isGateFailing,
  measured,
  sortBySeverity,
  type Finding,
} from "../src/findings.js";
import {
  applySeverityPolicy,
  citesCause,
  summarizePolicy,
} from "../src/severity-policy.js";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "major",
    category: "test-quality",
    subject: "Tests case 4",
    message: "The assertion only checks that a mock was called.",
    evidence: [at("tasks/alpha/ws-01.md", 42)],
    workstreamId: "WS-01",
    ...overrides,
  };
}

describe("fingerprint", () => {
  it("is stable when the critic rewords the same objection", () => {
    const first = finding({ message: "Test 4 asserts on a mock, not behavior." });
    const second = finding({
      message:
        "Case 4 does not discriminate: a wrong implementation would still pass.",
    });
    expect(fingerprint(second)).toBe(fingerprint(first));
  });

  it("is stable when severity changes between rounds", () => {
    expect(fingerprint(finding({ severity: "blocker" }))).toBe(
      fingerprint(finding({ severity: "minor" })),
    );
  });

  it("is stable when the cited line shifts after an edit", () => {
    const before = finding({ evidence: [at("tasks/alpha/ws-01.md", 42)] });
    const after = finding({ evidence: [at("tasks/alpha/ws-01.md", 96)] });
    expect(fingerprint(after)).toBe(fingerprint(before));
  });

  it("ignores incidental formatting in the subject", () => {
    expect(fingerprint(finding({ subject: "`AuthToken` interface" }))).toBe(
      fingerprint(finding({ subject: "AuthToken Interface" })),
    );
  });

  it("separates distinct subjects in the same workstream", () => {
    expect(fingerprint(finding({ subject: "Tests case 4" }))).not.toBe(
      fingerprint(finding({ subject: "Tests case 7" })),
    );
  });

  it("separates the same subject across categories", () => {
    expect(fingerprint(finding({ category: "test-quality" }))).not.toBe(
      fingerprint(finding({ category: "redundancy" })),
    );
  });

  it("separates the same subject across workstreams", () => {
    expect(fingerprint(finding({ workstreamId: "WS-01" }))).not.toBe(
      fingerprint(finding({ workstreamId: "WS-02" })),
    );
  });
});

describe("severity policy", () => {
  it("downgrades a finding whose only evidence is a line count", () => {
    const [result] = applySeverityPolicy([
      finding({
        category: "scope-structure",
        severity: "major",
        subject: "WS-04 spec length",
        message: "This spec is 800 lines.",
        evidence: [measured("lineCount", 800)],
      }),
    ]);
    expect(result?.severity).toBe("advisory");
    expect(result?.downgradedFrom).toBe("major");
  });

  it("downgrades a finding whose only evidence is a file count", () => {
    const [result] = applySeverityPolicy([
      finding({
        category: "scope-structure",
        evidence: [measured("fileCount", 14)],
      }),
    ]);
    expect(result?.severity).toBe("advisory");
  });

  it("downgrades a finding that cites no evidence at all", () => {
    const [result] = applySeverityPolicy([finding({ evidence: [] })]);
    expect(result?.severity).toBe("advisory");
  });

  it("keeps a split recommendation that names the bundled concerns", () => {
    const [result] = applySeverityPolicy([
      finding({
        category: "scope-structure",
        severity: "major",
        subject: "WS-04 scope",
        message: "WS-04 bundles auth and telemetry; split at step 12.",
        evidence: [
          because("unrelated concerns in one workstream", "auth + telemetry"),
          measured("lineCount", 800),
        ],
      }),
    ]);
    expect(result?.severity).toBe("major");
    expect(result?.downgradedFrom).toBeUndefined();
  });

  it("keeps a redundancy finding that locates the duplicated prose", () => {
    const [result] = applySeverityPolicy([
      finding({
        category: "redundancy",
        severity: "major",
        subject: "WS-04 background section",
        message: "Lines 210-340 are verbatim from the program document.",
        evidence: [at("tasks/alpha/ws-04.md", 210, 340)],
      }),
    ]);
    expect(result?.severity).toBe("major");
  });

  it("leaves findings that already sit at advisory untouched", () => {
    const [result] = applySeverityPolicy([
      finding({ severity: "advisory", evidence: [] }),
    ]);
    expect(result?.downgradedFrom).toBeUndefined();
  });

  it("reports every downgrade rather than applying it silently", () => {
    const summary = summarizePolicy(
      applySeverityPolicy([
        finding({ subject: "WS-04 spec length", evidence: [measured("lineCount", 800)] }),
        finding({ subject: "WS-05 scope", evidence: [because("mixed concerns")] }),
      ]),
    );
    expect(summary.downgraded).toHaveLength(1);
    expect(summary.downgraded[0]?.subject).toBe("WS-04 spec length");
    expect(summary.downgraded[0]?.from).toBe("major");
  });

  it("treats location and concern as causes but measurement as not", () => {
    expect(citesCause([at("a.md", 1)])).toBe(true);
    expect(citesCause([because("mixed concerns")])).toBe(true);
    expect(citesCause([measured("lineCount", 900)])).toBe(false);
    expect(citesCause([])).toBe(false);
  });
});

describe("gate and convergence predicates", () => {
  it("fails the gate on blockers regardless of strict", () => {
    expect(isGateFailing(finding({ severity: "blocker" }), false)).toBe(true);
  });

  it("fails the gate on majors only under strict", () => {
    expect(isGateFailing(finding({ severity: "major" }), false)).toBe(false);
    expect(isGateFailing(finding({ severity: "major" }), true)).toBe(true);
  });

  it("never fails the gate on advisory, even under strict", () => {
    expect(isGateFailing(finding({ severity: "advisory" }), true)).toBe(false);
  });

  it("keeps the loop running for blockers and majors but not minors", () => {
    expect(haltsConvergence(finding({ severity: "blocker" }))).toBe(true);
    expect(haltsConvergence(finding({ severity: "major" }))).toBe(true);
    expect(haltsConvergence(finding({ severity: "minor" }))).toBe(false);
    expect(haltsConvergence(finding({ severity: "advisory" }))).toBe(false);
  });
});

describe("reporting helpers", () => {
  it("counts every severity bucket", () => {
    const counts = countBySeverity([
      finding({ severity: "blocker" }),
      finding({ severity: "major" }),
      finding({ severity: "major" }),
      finding({ severity: "advisory" }),
    ]);
    expect(counts).toEqual({ blocker: 1, major: 2, minor: 0, advisory: 1 });
  });

  it("orders findings most severe first", () => {
    const sorted = sortBySeverity([
      finding({ severity: "advisory" }),
      finding({ severity: "blocker" }),
      finding({ severity: "minor" }),
      finding({ severity: "major" }),
    ]);
    expect(sorted.map(({ severity }) => severity)).toEqual([
      "blocker",
      "major",
      "minor",
      "advisory",
    ]);
  });
});
