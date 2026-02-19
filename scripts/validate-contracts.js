/* eslint-disable no-console */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function readJson(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  return JSON.parse(content);
}

function collectJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }

  return fs
    .readdirSync(dirPath)
    .filter((entry) => entry.toLowerCase().endsWith(".json"))
    .map((entry) => path.join(dirPath, entry));
}

async function main() {
  const rootDir = process.cwd();

  // Ensure schema files are valid JSON and present.
  const manifestSchemaPath = path.join(rootDir, "contracts", "manifest", "schema.json");
  const licenseSchemaPath = path.join(rootDir, "contracts", "license-spec", "schema.json");
  readJson(manifestSchemaPath);
  readJson(licenseSchemaPath);

  const manifestLibPath = path.join(rootDir, "packages", "manifest-lib", "src", "index.js");
  const manifestLib = await import(pathToFileURL(manifestLibPath).href);

  const manifestExamples = collectJsonFiles(path.join(rootDir, "contracts", "manifest", "examples"));
  const licenseExamples = collectJsonFiles(path.join(rootDir, "contracts", "license-spec", "examples"));

  const errors = [];

  for (const filePath of manifestExamples) {
    const document = readJson(filePath);
    const result = await manifestLib.validateManifestDocument(document);

    if (!result.valid) {
      for (const issue of result.errors) {
        errors.push(`- ${filePath}: ${issue}`);
      }
    }
  }

  for (const filePath of licenseExamples) {
    const document = readJson(filePath);
    const result = await manifestLib.validateLicenseDocument(document);

    if (!result.valid) {
      for (const issue of result.errors) {
        errors.push(`- ${filePath}: ${issue}`);
      }
    }
  }

  if (errors.length > 0) {
    console.error("Contract validation failed.");
    for (const issue of errors) {
      console.error(issue);
    }
    process.exit(1);
  }

  console.log(`Validated ${manifestExamples.length + licenseExamples.length} contract example(s).`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
