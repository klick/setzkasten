import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { nowIso, sha256Hex, slugifyId } from "../../core/src/index.js";

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

const FONT_FILE_EXTENSIONS = new Set([".woff2", ".woff", ".ttf", ".otf", ".otc"]);
const LICENSE_FILE_EXTENSIONS = new Set(["", ".txt", ".md", ".pdf", ".rtf", ".html", ".htm"]);
const LICENSE_FILE_NAME_PATTERN = /(license|licence|eula|ofl|fontlog|copying|copyright)/i;

const STYLE_TOKENS = new Set([
  "regular",
  "italic",
  "bold",
  "black",
  "light",
  "thin",
  "medium",
  "semibold",
  "extrabold",
  "ultrabold",
  "book",
  "display",
  "condensed",
  "narrow",
  "expanded",
  "variable",
  "var",
  "vf",
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

function shouldDiscoverFontFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return FONT_FILE_EXTENSIONS.has(extension);
}

function shouldDiscoverLicenseFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();

  if (!LICENSE_FILE_EXTENSIONS.has(extension)) {
    return false;
  }

  return LICENSE_FILE_NAME_PATTERN.test(fileName);
}

function isLikelyTextLicenseFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return extension === "" || extension === ".txt" || extension === ".md" || extension === ".html" || extension === ".htm";
}

async function collectProjectFiles(rootPath) {
  const textFiles = [];
  const fontFiles = [];
  const licenseFiles = [];

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

      if (!entry.isFile()) {
        continue;
      }

      if (shouldScanFile(fullPath)) {
        const fileStat = await stat(fullPath);
        if (fileStat.size <= 2 * 1024 * 1024) {
          textFiles.push(fullPath);
        }
      }

      if (shouldDiscoverFontFile(fullPath)) {
        fontFiles.push(fullPath);
      }

      if (shouldDiscoverLicenseFile(fullPath)) {
        licenseFiles.push(fullPath);
      }
    }
  }

  await walk(rootPath);

  return {
    textFiles,
    fontFiles,
    licenseFiles,
  };
}

function relativeTo(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  return relativePath.length > 0 ? relativePath : ".";
}

function toTitleCaseToken(token) {
  if (token.length === 0) {
    return token;
  }

  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

function guessFamilyNameFromFile(filePath) {
  const extension = path.extname(filePath);
  const rawName = path.basename(filePath, extension);
  const normalized = rawName.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();

  if (normalized.length === 0) {
    return rawName;
  }

  const tokens = normalized.split(" ").map((token) => token.trim()).filter(Boolean);

  while (tokens.length > 1) {
    const lastToken = tokens[tokens.length - 1].toLowerCase();
    if (!STYLE_TOKENS.has(lastToken)) {
      break;
    }
    tokens.pop();
  }

  return tokens.map((token) => toTitleCaseToken(token)).join(" ");
}

function discoverFontFiles(rootPath, fontFiles, maxDiscoveredFiles) {
  return fontFiles
    .map((filePath) => {
      const extension = path.extname(filePath).toLowerCase();
      const relativePath = relativeTo(rootPath, filePath);
      const familyGuess = guessFamilyNameFromFile(filePath);

      return {
        path: relativePath,
        extension,
        file_name: path.basename(filePath),
        family_guess: familyGuess,
        font_id_guess: slugifyId(familyGuess || path.basename(filePath, extension), "font"),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, maxDiscoveredFiles);
}

function detectLicenseKind(fileName, contentLower) {
  if (contentLower) {
    if (
      contentLower.includes("sil open font license") ||
      contentLower.includes("ofl version 1.1") ||
      contentLower.includes("scripts.sil.org/ofl")
    ) {
      return "sil_ofl_1_1";
    }

    if (contentLower.includes("apache license") && contentLower.includes("version 2.0")) {
      return "apache_2_0";
    }

    if (contentLower.includes("mit license")) {
      return "mit";
    }

    if (contentLower.includes("gnu general public license")) {
      return "gpl";
    }

    if (contentLower.includes("mozilla public license")) {
      return "mpl";
    }

    if (contentLower.includes("eula") || contentLower.includes("end user license agreement")) {
      return "eula";
    }
  }

  if (fileName.toLowerCase().includes("ofl")) {
    return "sil_ofl_1_1";
  }

  if (fileName.toLowerCase().includes("eula")) {
    return "eula";
  }

  return null;
}

function matchFontIdsFromLicenseContent(fonts, contentLower) {
  if (!contentLower) {
    return [];
  }

  return fonts
    .filter((font) => contentLower.includes(font.family_name.toLowerCase()))
    .map((font) => font.font_id)
    .sort((a, b) => a.localeCompare(b));
}

async function discoverLicenseFiles(rootPath, licenseFiles, fonts, maxDiscoveredLicenseFiles) {
  const discovered = [];

  for (const filePath of licenseFiles) {
    let fileBuffer;
    let fileStat;

    try {
      fileBuffer = await readFile(filePath);
      fileStat = await stat(filePath);
    } catch {
      continue;
    }

    const extension = path.extname(filePath).toLowerCase();
    const fileName = path.basename(filePath);
    const relativePath = relativeTo(rootPath, filePath);
    const contentLower =
      isLikelyTextLicenseFile(filePath) && fileBuffer.length <= 512 * 1024
        ? fileBuffer.toString("utf8").toLowerCase()
        : null;

    discovered.push({
      path: relativePath,
      extension,
      file_name: fileName,
      size_bytes: fileStat.size,
      document_hash: sha256Hex(fileBuffer),
      detected_license: detectLicenseKind(fileName, contentLower),
      matched_font_ids: matchFontIdsFromLicenseContent(fonts, contentLower),
    });
  }

  return discovered
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, maxDiscoveredLicenseFiles);
}

export async function scanProject(input) {
  const rootPath = path.resolve(input.rootPath);
  const maxMatchedPathsPerFont = input.maxMatchedPathsPerFont ?? 30;
  const discover = input.discover === true;
  const maxDiscoveredFiles = input.maxDiscoveredFiles ?? 200;
  const maxDiscoveredLicenseFiles = input.maxDiscoveredLicenseFiles ?? 200;

  const fonts = normalizeFonts(input.manifest)
    .map((font) => ({
      font_id: typeof font.font_id === "string" ? font.font_id : "",
      family_name: typeof font.family_name === "string" ? font.family_name : "",
    }))
    .filter((font) => font.font_id.length > 0 && font.family_name.length > 0);

  const { textFiles, fontFiles, licenseFiles } = await collectProjectFiles(rootPath);
  const matches = new Map();

  for (const font of fonts) {
    matches.set(font.font_id, {
      font_id: font.font_id,
      family_name: font.family_name,
      match_count: 0,
      matched_paths: [],
    });
  }

  for (const filePath of textFiles) {
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

  const discoveredLicenseFiles = discover
    ? await discoverLicenseFiles(rootPath, licenseFiles, fonts, maxDiscoveredLicenseFiles)
    : [];

  return {
    scanned_at: nowIso(),
    root_path: rootPath,
    scanned_files_count: textFiles.length,
    font_matches: Object.fromEntries(Array.from(matches.entries())),
    discovered_font_files: discover ? discoverFontFiles(rootPath, fontFiles, maxDiscoveredFiles) : [],
    discovered_license_files: discoveredLicenseFiles,
  };
}

export function applyScanResultToManifest(manifest, scanResult) {
  const draft = deepClone(manifest);
  const fonts = Array.isArray(draft.fonts) ? draft.fonts : [];
  const licenseMatchesByFont = new Map();

  const discoveredLicenseFiles = Array.isArray(scanResult.discovered_license_files)
    ? scanResult.discovered_license_files
    : [];

  for (const licenseFile of discoveredLicenseFiles) {
    const matchedFontIds = Array.isArray(licenseFile.matched_font_ids) ? licenseFile.matched_font_ids : [];
    for (const fontId of matchedFontIds) {
      if (!licenseMatchesByFont.has(fontId)) {
        licenseMatchesByFont.set(fontId, []);
      }
      licenseMatchesByFont.get(fontId).push(licenseFile.path);
    }
  }

  for (const font of fonts) {
    const fontId = typeof font.font_id === "string" ? font.font_id : "";
    if (!fontId) {
      continue;
    }

    const match = scanResult.font_matches[fontId];
    const currentUsage =
      font.usage && typeof font.usage === "object" && !Array.isArray(font.usage) ? font.usage : {};

    const matchedLicensePaths = licenseMatchesByFont.get(fontId) ?? [];

    font.usage = {
      ...currentUsage,
      scan: {
        scanned_at: scanResult.scanned_at,
        match_count: match?.match_count ?? 0,
        matched_paths: match?.matched_paths ?? [],
        license_match_count: matchedLicensePaths.length,
        license_matched_paths: matchedLicensePaths.slice(0, 30),
      },
    };
  }

  draft.fonts = fonts;
  return draft;
}
