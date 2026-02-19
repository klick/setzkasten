import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_FILENAME = "LICENSE_MANIFEST.json";
export const EVENT_LOG_RELATIVE_PATH = ".setzkasten/events.log";
export const MANIFEST_VERSION = "1.0.0";
export const LICENSE_SPEC_VERSION = "1.0.0";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const sortedEntries = Object.keys(value)
    .sort((a, b) => a.localeCompare(b))
    .map((key) => [key, canonicalize(value[key])]);

  return Object.fromEntries(sortedEntries);
}

export function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function nowIso() {
  return new Date().toISOString();
}

export function makeEventId() {
  return randomUUID();
}

export function slugifyId(input, fallback = "project") {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  let result = normalized.length > 0 ? normalized : fallback;

  if (!/^[a-z0-9]/.test(result)) {
    result = `id-${result}`;
  }

  return result.slice(0, 128);
}

export function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export async function pathExists(filePath) {
  return existsSync(filePath);
}

export async function ensureDirectory(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function readJsonFile(filePath) {
  const content = await readFile(filePath, "utf8");
  return JSON.parse(content);
}

export async function writeJsonFileAtomic(filePath, value) {
  const dirPath = path.dirname(filePath);
  await ensureDirectory(dirPath);

  const tmpFilePath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const json = `${JSON.stringify(value, null, 2)}\n`;

  await writeFile(tmpFilePath, json, "utf8");
  await rename(tmpFilePath, filePath);
}

export async function appendLine(filePath, value) {
  const dirPath = path.dirname(filePath);
  await ensureDirectory(dirPath);
  await appendFile(filePath, `${value}\n`, "utf8");
}

export function findUp(fileName, startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, fileName);

    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

export function parseListFlag(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => parseListFlag(entry));
  }

  if (!value) {
    return [];
  }

  return String(value)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
