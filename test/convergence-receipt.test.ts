import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  convergenceReceiptPath,
  inspectConvergenceReceipt,
  writeConvergenceReceipt,
} from "../src/convergence-receipt.js";
import { pipelineConfigSchema } from "../src/pipeline-config.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

async function project(): Promise<{
  root: string;
  config: ReturnType<typeof pipelineConfigSchema.parse>;
}> {
  const root = await mkdtemp(join(tmpdir(), "program-pipeline-receipt-"));
  roots.push(root);
  await mkdir(join(root, "docs", "programs"), { recursive: true });
  await mkdir(join(root, "tasks", "alpha"), { recursive: true });
  const manifest = {
    program: { id: "alpha", name: "Alpha", status: "planning" },
    successCriteria: [{ id: "SC-01", description: "It works" }],
    workstreams: [
      {
        id: "WS-01",
        name: "Core",
        taskFile: "tasks/alpha/ws-01.md",
        status: "not_started",
        dependencies: [],
      },
    ],
  };
  await writeFile(
    join(root, "docs", "programs", "alpha-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await writeFile(
    join(root, "docs", "programs", "alpha-program.md"),
    "# Alpha\n",
  );
  await writeFile(join(root, "tasks", "alpha", "ws-01.md"), "# WS-01\n");
  await writeFile(join(root, "docs", "vision.md"), "# Vision\n");
  await writeFile(join(root, "AGENTS.md"), "# Rules\n");
  const config = pipelineConfigSchema.parse({
    schemaVersion: 1,
    pipelineVersion: "0.12.3",
    visionPath: "docs/vision.md",
    requireApprovalBeforeBuild: false,
  });
  return { root, config };
}

describe("convergence receipts", () => {
  it("writes and recognizes a receipt for the exact semantic inputs", async () => {
    const { root, config } = await project();
    const receipt = await writeConvergenceReceipt(
      root,
      "alpha",
      config,
      () => new Date("2026-08-17T12:00:00Z"),
    );

    expect(receipt.validatedAt).toBe("2026-08-17T12:00:00.000Z");
    await expect(inspectConvergenceReceipt(root, "alpha", config)).resolves.toMatchObject({
      valid: true,
      receipt: { inputHash: receipt.inputHash },
    });
    await expect(readFile(convergenceReceiptPath(root, "alpha"), "utf8")).resolves.toContain(
      receipt.inputHash,
    );
  });

  it("ignores mutable program and workstream status changes", async () => {
    const { root, config } = await project();
    await writeConvergenceReceipt(root, "alpha", config);
    const manifestPath = join(root, "docs", "programs", "alpha-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      program: { status: string };
      workstreams: Array<{ status: string }>;
    };
    manifest.program.status = "in_progress";
    manifest.workstreams[0]!.status = "failed";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(inspectConvergenceReceipt(root, "alpha", config)).resolves.toMatchObject({
      valid: true,
    });
  });

  it("becomes stale when a spec or semantic context changes", async () => {
    const { root, config } = await project();
    await writeConvergenceReceipt(root, "alpha", config);
    await writeFile(
      join(root, "tasks", "alpha", "ws-01.md"),
      "# WS-01\nchanged\n",
    );

    await expect(inspectConvergenceReceipt(root, "alpha", config)).resolves.toMatchObject({
      valid: false,
      reason: "stale",
    });
  });
});
