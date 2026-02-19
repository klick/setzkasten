import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./index.js", import.meta.url));

function runCli(entryPath, args) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    encoding: "utf8",
  });
}

test("runs and prints help when invoked directly", () => {
  const result = runCli(scriptPath, ["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Setzkasten CLI \(V1\)/);
});

test("runs through symlinked entrypoint (npm bin-style execution)", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-link-"));
  const linkedScriptPath = path.join(tempDir, "setzkasten");

  symlinkSync(scriptPath, linkedScriptPath);

  const result = runCli(linkedScriptPath, ["--help"]);

  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Setzkasten CLI \(V1\)/);
});
