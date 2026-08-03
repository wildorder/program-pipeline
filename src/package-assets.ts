import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
);

const packageMetadataSchema = z.object({
  version: z.string().min(1),
});

export async function packageVersion(): Promise<string> {
  const metadata: unknown = JSON.parse(
    await readFile(resolve(PACKAGE_ROOT, "package.json"), "utf8"),
  );
  return packageMetadataSchema.parse(metadata).version;
}
