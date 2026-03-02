import { existsSync, appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function readInput(env, name, fallback = "") {
  const envName = `INPUT_${name.toUpperCase()}`;
  const value = env[envName];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return fallback;
}

function writeGithubOutput(env, key, value) {
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  appendFileSync(outputPath, `${key}=${String(value)}\n`, "utf8");
}

function parseDecisionFromStdout(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    if (typeof parsed?.decision === "string") {
      return parsed.decision;
    }
  } catch {
    return null;
  }

  return null;
}

function resolveCliCommand(workspaceRoot, env) {
  const explicitCliPath = env.SETZKASTEN_CLI_PATH;
  if (typeof explicitCliPath === "string" && explicitCliPath.trim().length > 0) {
    const resolvedCliPath = path.resolve(workspaceRoot, explicitCliPath.trim());
    return {
      command: process.execPath,
      prefixArgs: [resolvedCliPath],
    };
  }

  const localBinPath = path.join(workspaceRoot, "node_modules", ".bin", "setzkasten");
  if (existsSync(localBinPath)) {
    return {
      command: localBinPath,
      prefixArgs: [],
    };
  }

  const workspaceCliPath = path.join(workspaceRoot, "packages", "cli", "src", "index.js");
  if (existsSync(workspaceCliPath)) {
    return {
      command: process.execPath,
      prefixArgs: [workspaceCliPath],
    };
  }

  return {
    command: "npx",
    prefixArgs: ["--yes", "@setzkasten/cli@latest"],
  };
}

export function runAction(options = {}) {
  const env = options.env ?? process.env;
  const workspaceRoot = path.resolve(options.cwd ?? process.cwd());
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const runCommand = options.runCommand ?? spawnSync;

  const workingDirectoryInput = readInput(env, "WORKING_DIRECTORY", ".");
  const workingDirectory = path.resolve(workspaceRoot, workingDirectoryInput);
  const manifestPath = readInput(env, "MANIFEST_PATH", "LICENSE_MANIFEST.json");
  const failOn = readInput(env, "FAIL_ON", "escalate");
  const format = readInput(env, "FORMAT", "json");

  const cli = resolveCliCommand(workspaceRoot, env);
  const policyArgs = [
    ...cli.prefixArgs,
    "policy",
    "--manifest",
    manifestPath,
    "--fail-on",
    failOn,
    "--format",
    format,
  ];

  stdout.write(`Running: ${cli.command} ${policyArgs.join(" ")}\n`);

  const result = runCommand(cli.command, policyArgs, {
    cwd: workingDirectory,
    encoding: "utf8",
  });

  if (result.stdout) {
    stdout.write(result.stdout);
  }

  if (result.stderr) {
    stderr.write(result.stderr);
  }

  if (result.error) {
    stderr.write(`::error title=Setzkasten action error::${result.error.message}\n`);
    writeGithubOutput(env, "exit_code", 1);
    writeGithubOutput(env, "policy_decision", "unknown");
    return {
      exitCode: 1,
      decision: "unknown",
      command: cli.command,
      args: policyArgs,
    };
  }

  const exitCode = typeof result.status === "number" ? result.status : 1;
  const decision = parseDecisionFromStdout(result.stdout ?? "") ?? "unknown";

  writeGithubOutput(env, "exit_code", exitCode);
  writeGithubOutput(env, "policy_decision", decision);

  if (exitCode !== 0) {
    stderr.write(
      `::error title=Setzkasten policy failed::Policy command exited with code ${exitCode} (fail_on=${failOn}).\n`,
    );
  }

  return {
    exitCode,
    decision,
    command: cli.command,
    args: policyArgs,
  };
}

function main() {
  const result = runAction();
  process.exit(result.exitCode);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
