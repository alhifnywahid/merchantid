import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const dataDirectory = mkdtempSync(join(tmpdir(), "merchid-lab-test-"));
process.env.MERCHID_LAB_DATA_DIR = dataDirectory;

afterAll(() => {
  rmSync(dataDirectory, { force: true, recursive: true });
  delete process.env.MERCHID_LAB_DATA_DIR;
});
