import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { runAction } from "./index.js";

function createWriter() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(String(value));
    },
    toString() {
      return chunks.join("");
    },
  };
}

test("runAction uses explicit SETZKASTEN_CLI_PATH and writes outputs", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-action-test-"));
  const cliPath = path.join(tempDir, "fake-cli.js");
  writeFileSync(cliPath, "console.log('stub');\n", "utf8");
  const githubOutput = path.join(tempDir, "github-output.txt");
  writeFileSync(githubOutput, "", "utf8");

  let called = null;

  const result = runAction({
    cwd: tempDir,
    env: {
      INPUT_MANIFEST_PATH: "LICENSE_MANIFEST.json",
      INPUT_FAIL_ON: "warn",
      INPUT_FORMAT: "json",
      SETZKASTEN_CLI_PATH: "fake-cli.js",
      GITHUB_OUTPUT: githubOutput,
    },
    stdout: createWriter(),
    stderr: createWriter(),
    runCommand(command, args) {
      called = { command, args };
      return {
        status: 0,
        stdout: JSON.stringify({ decision: "allow", reasons: [] }),
        stderr: "",
      };
    },
  });

  rmSync(tempDir, { recursive: true, force: true });

  assert.ok(called);
  assert.equal(called.command, process.execPath);
  assert.equal(called.args[0].endsWith("fake-cli.js"), true);
  assert.equal(called.args.includes("policy"), true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.decision, "allow");
});

test("runAction returns non-zero and emits error annotation on policy failure", () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "setzkasten-action-test-"));
  mkdirSync(path.join(tempDir, "packages", "cli", "src"), { recursive: true });
  writeFileSync(path.join(tempDir, "packages", "cli", "src", "index.js"), "// placeholder\n", "utf8");

  const stderr = createWriter();

  const result = runAction({
    cwd: tempDir,
    env: {
      INPUT_MANIFEST_PATH: "LICENSE_MANIFEST.json",
      INPUT_FAIL_ON: "escalate",
      INPUT_FORMAT: "json",
    },
    stdout: createWriter(),
    stderr,
    runCommand() {
      return {
        status: 2,
        stdout: JSON.stringify({ decision: "escalate", reasons: [] }),
        stderr: "",
      };
    },
  });

  rmSync(tempDir, { recursive: true, force: true });

  assert.equal(result.exitCode, 2);
  assert.equal(result.decision, "escalate");
  assert.match(stderr.toString(), /::error title=Setzkasten policy failed::/);
});
