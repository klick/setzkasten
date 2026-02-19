import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { nowIso } from "../../core/src/index.js";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".setzkasten",
  "dist",
  "coverage",
  ".next",
  ".turbo",
]);

const TEXT_FILE_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".html",
  ".htm",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".txt",
]);

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeFonts(manifest) {
  return Array.isArray(manifest.fonts) ? manifest.fonts : [];
}

function shouldScanFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return TEXT_FILE_EXTENSIONS.has(extension);
}

async function collectScanFiles(rootPath) {
  const files = [];

  async function walk(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        if (entry.isDirectory() && !DEFAULT_IGNORED_DIRS.has(entry.name)) {
          await walk(path.join(dirPath, entry.name));
        }
        continue;
      }

      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(entry.name)) {
          await walk(fullPath);
        }
        continue;
      }

      if (!entry.isFile() || !shouldScanFile(fullPath)) {
        continue;
      }

      const fileStat = await stat(fullPath);
      if (fileStat.size > 2 * 1024 * 1024) {
        continue;
      }

      files.push(fullPath);
    }
  }

  await walk(rootPath);
  return files;
}

function relativeTo(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath.length > 0 ? relativePath : ".";
}

export async function scanProject(input) {
  const rootPath = path.resolve(input.rootPath);
  const maxMatchedPathsPerFont = input.maxMatchedPathsPerFont ?? 30;

  const fonts = normalizeFonts(input.manifest)
    .map((font) => ({
      font_id: typeof font.font_id === "string" ? font.font_id : "",
      family_name: typeof font.family_name === "string" ? font.family_name : "",
    }))
    .filter((font) => font.font_id.length > 0 && font.family_name.length > 0);

  const files = await collectScanFiles(rootPath);
  const matches = new Map();

  for (const font of fonts) {
    matches.set(font.font_id, {
      font_id: font.font_id,
      family_name: font.family_name,
      match_count: 0,
      matched_paths: [],
    });
  }

  for (const filePath of files) {
    let content;

    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }

    const lowerContent = content.toLowerCase();

    for (const font of fonts) {
      if (!lowerContent.includes(font.family_name.toLowerCase())) {
        continue;
      }

      const entry = matches.get(font.font_id);
      if (!entry) {
        continue;
      }

      entry.match_count += 1;
      if (entry.matched_paths.length < maxMatchedPathsPerFont) {
        entry.matched_paths.push(relativeTo(rootPath, filePath));
      }
    }
  }

  return {
    scanned_at: nowIso(),
    root_path: rootPath,
    scanned_files_count: files.length,
    font_matches: Object.fromEntries(Array.from(matches.entries())),
  };
}

export function applyScanResultToManifest(manifest, scanResult) {
  const draft = deepClone(manifest);
  const fonts = Array.isArray(draft.fonts) ? draft.fonts : [];

  for (const font of fonts) {
    const fontId = typeof font.font_id === "string" ? font.font_id : "";
    if (!fontId) {
      continue;
    }

    const match = scanResult.font_matches[fontId];
    const currentUsage =
      font.usage && typeof font.usage === "object" && !Array.isArray(font.usage) ? font.usage : {};

    font.usage = {
      ...currentUsage,
      scan: {
        scanned_at: scanResult.scanned_at,
        match_count: match?.match_count ?? 0,
        matched_paths: match?.matched_paths ?? [],
      },
    };
  }

  draft.fonts = fonts;
  return draft;
}
