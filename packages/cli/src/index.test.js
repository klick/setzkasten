import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("./index.js", import.meta.url));

function runCli(entryPath, args, options = {}) {
  return spawnSync(process.execPath, [entryPath, ...args], {
    encoding: "utf8",
    cwd: options.cwd,
  });
}

test("runs and prints help when invoked directly", () => {
  const result = runCli(scriptPath, ["--help"]);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Setzkasten CLI \(V1\)/);
});

test("scan --discover prints discovered font files", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-cli-discover-"));
  mkdirSync(path.join(tempDir, "assets", "fonts"), { recursive: true });
  writeFileSync(path.join(tempDir, "assets", "fonts", "Inter-Regular.woff2"), "font-binary");

  const initResult = runCli(scriptPath, ["init", "--name", "Demo"], { cwd: tempDir });
  assert.equal(initResult.status, 0);

  const addResult = runCli(
    scriptPath,
    ["add", "--font-id", "inter", "--family", "Inter", "--source", "oss"],
    { cwd: tempDir },
  );
  assert.equal(addResult.status, 0);

  const scanResult = runCli(scriptPath, ["scan", "--path", ".", "--discover"], { cwd: tempDir });
  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(scanResult.status, 0);

  const parsed = JSON.parse(scanResult.stdout);
  assert.equal(parsed.command, "scan");
  assert.ok(Array.isArray(parsed.result.discovered_font_files));
  assert.ok(parsed.result.discovered_font_files.length >= 1);
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
