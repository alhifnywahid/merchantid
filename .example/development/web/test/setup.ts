import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dataDirectory = mkdtempSync(join(tmpdir(), "merchantid-lab-test-"));
process.env.MERCHANTID_LAB_DATA_DIR = dataDirectory;

afterAll(() => {
  rmSync(dataDirectory, { force: true, recursive: true });
  delete process.env.MERCHANTID_LAB_DATA_DIR;
});
