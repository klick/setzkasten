import path from "node:path";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  findUp,
  readJsonFile,
  slugifyId,
  writeJsonFileAtomic,
} from "../../core/src/index.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LICENSEE_TYPES = new Set(["individual", "organization", "agency", "client", "other"]);
const SOURCE_TYPES = new Set(["oss", "byo"]);
const OFFERING_TYPES = new Set(["commercial", "trial"]);
const INSTANCE_STATUS = new Set(["active", "expired", "superseded", "revoked"]);
const ACQUISITION_SOURCES = new Set(["direct_foundry", "reseller", "marketplace", "legacy"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pushError(errors, pathName, message) {
  errors.push(`${pathName} ${message}`);
}

function validateString(errors, pathName, value, options = {}) {
  if (typeof value !== "string") {
    pushError(errors, pathName, "must be a string");
    return;
  }

  if (options.minLength && value.length < options.minLength) {
    pushError(errors, pathName, `must have length >= ${options.minLength}`);
  }

  if (options.maxLength && value.length > options.maxLength) {
    pushError(errors, pathName, `must have length <= ${options.maxLength}`);
  }

  if (options.pattern && !options.pattern.test(value)) {
    pushError(errors, pathName, "has invalid format");
  }

  if (options.enum && !options.enum.has(value)) {
    pushError(errors, pathName, `must be one of: ${Array.from(options.enum).join(", ")}`);
  }
}

function validateArray(errors, pathName, value, options = {}) {
  if (!Array.isArray(value)) {
    pushError(errors, pathName, "must be an array");
    return false;
  }

  if (typeof options.minItems === "number" && value.length < options.minItems) {
    pushError(errors, pathName, `must contain at least ${options.minItems} item(s)`);
  }

  return true;
}

function validateLicensee(errors, pathName, value) {
  if (!isObject(value)) {
    pushError(errors, pathName, "must be an object");
    return;
  }

  validateString(errors, `${pathName}.licensee_id`, value.licensee_id, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
  });
  validateString(errors, `${pathName}.type`, value.type, { enum: LICENSEE_TYPES });
  validateString(errors, `${pathName}.legal_name`, value.legal_name, { minLength: 1 });

  if (value.country !== undefined) {
    validateString(errors, `${pathName}.country`, value.country, { minLength: 2, maxLength: 2 });
  }

  if (value.contact_email !== undefined) {
    validateString(errors, `${pathName}.contact_email`, value.contact_email, { minLength: 3 });
  }
}

function validateFont(errors, pathName, value) {
  if (!isObject(value)) {
    pushError(errors, pathName, "must be an object");
    return;
  }

  validateString(errors, `${pathName}.font_id`, value.font_id, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
  });
  validateString(errors, `${pathName}.family_name`, value.family_name, { minLength: 1 });

  if (!isObject(value.source)) {
    pushError(errors, `${pathName}.source`, "must be an object");
  } else {
    validateString(errors, `${pathName}.source.type`, value.source.type, { enum: SOURCE_TYPES });

    if (value.source.uri !== undefined) {
      try {
        new URL(String(value.source.uri));
      } catch {
        pushError(errors, `${pathName}.source.uri`, "must be a valid URI");
      }
    }
  }

  const hasLicenseIds = validateArray(errors, `${pathName}.license_instance_ids`, value.license_instance_ids);
  if (hasLicenseIds) {
    for (let index = 0; index < value.license_instance_ids.length; index += 1) {
      validateString(
        errors,
        `${pathName}.license_instance_ids[${index}]`,
        value.license_instance_ids[index],
        {
          minLength: 1,
          maxLength: 128,
          pattern: ID_PATTERN,
        },
      );
    }
  }

  if (value.active_license_instance_id !== undefined) {
    validateString(errors, `${pathName}.active_license_instance_id`, value.active_license_instance_id, {
      minLength: 1,
      maxLength: 128,
      pattern: ID_PATTERN,
    });
  }
}

function validateMetricLimit(errors, pathName, value) {
  if (!isObject(value)) {
    pushError(errors, pathName, "must be an object");
    return;
  }

  validateString(errors, `${pathName}.metric_type`, value.metric_type, { minLength: 1 });

  if (typeof value.limit !== "number" || Number.isNaN(value.limit)) {
    pushError(errors, `${pathName}.limit`, "must be a number");
  }

  validateString(errors, `${pathName}.period`, value.period, { minLength: 1 });
}

function validateEvidence(errors, pathName, value) {
  if (!isObject(value)) {
    pushError(errors, pathName, "must be an object");
    return;
  }

  validateString(errors, `${pathName}.evidence_id`, value.evidence_id, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
  });
  validateString(errors, `${pathName}.type`, value.type, { minLength: 1 });
  validateString(errors, `${pathName}.document_hash`, value.document_hash, {
    pattern: /^[A-Fa-f0-9]{64}$/,
  });
}

function validateLicenseOffering(errors, pathName, value) {
  if (!isObject(value)) {
    pushError(errors, pathName, "must be an object");
    return;
  }

  if (value.kind !== "offering") {
    pushError(errors, `${pathName}.kind`, "must equal 'offering'");
  }

  validateString(errors, `${pathName}.offering_id`, value.offering_id, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
  });
  validateString(errors, `${pathName}.offering_version`, value.offering_version, {
    pattern: SEMVER_PATTERN,
  });
  validateString(errors, `${pathName}.offering_type`, value.offering_type, {
    enum: OFFERING_TYPES,
  });
  validateString(errors, `${pathName}.name`, value.name, { minLength: 1 });

  const hasRights = validateArray(errors, `${pathName}.rights`, value.rights, { minItems: 1 });
  if (hasRights) {
    for (let index = 0; index < value.rights.length; index += 1) {
      const right = value.rights[index];
      if (!isObject(right)) {
        pushError(errors, `${pathName}.rights[${index}]`, "must be an object");
        continue;
      }

      validateString(errors, `${pathName}.rights[${index}].right_id`, right.right_id, {
        minLength: 1,
        maxLength: 128,
        pattern: ID_PATTERN,
      });
      validateString(errors, `${pathName}.rights[${index}].right_type`, right.right_type, { minLength: 1 });
    }
  }

  validateArray(errors, `${pathName}.metric_models`, value.metric_models);

  if (!isObject(value.price_formula)) {
    pushError(errors, `${pathName}.price_formula`, "must be an object");
  } else {
    validateString(errors, `${pathName}.price_formula.currency`, value.price_formula.currency, {
      minLength: 3,
      maxLength: 3,
    });

    if (
      typeof value.price_formula.base_price !== "number" ||
      Number.isNaN(value.price_formula.base_price) ||
      value.price_formula.base_price < 0
    ) {
      pushError(errors, `${pathName}.price_formula.base_price`, "must be a non-negative number");
    }
  }
}

function validateLicenseInstance(errors, pathName, value) {
  if (!isObject(value)) {
    pushError(errors, pathName, "must be an object");
    return;
  }

  if (value.kind !== "instance") {
    pushError(errors, `${pathName}.kind`, "must equal 'instance'");
  }

  validateString(errors, `${pathName}.license_id`, value.license_id, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
  });
  validateString(errors, `${pathName}.licensee_id`, value.licensee_id, {
    minLength: 1,
    maxLength: 128,
    pattern: ID_PATTERN,
  });

  if (!isObject(value.offering_ref)) {
    pushError(errors, `${pathName}.offering_ref`, "must be an object");
  } else {
    validateString(errors, `${pathName}.offering_ref.offering_id`, value.offering_ref.offering_id, {
      minLength: 1,
      maxLength: 128,
      pattern: ID_PATTERN,
    });
    validateString(
      errors,
      `${pathName}.offering_ref.offering_version`,
      value.offering_ref.offering_version,
      {
        pattern: SEMVER_PATTERN,
      },
    );
  }

  if (!isObject(value.scope)) {
    pushError(errors, `${pathName}.scope`, "must be an object");
  } else {
    validateString(errors, `${pathName}.scope.scope_type`, value.scope.scope_type, { minLength: 1 });
    validateString(errors, `${pathName}.scope.scope_id`, value.scope.scope_id, {
      minLength: 1,
      maxLength: 128,
      pattern: ID_PATTERN,
    });
  }

  const hasFontRefs = validateArray(errors, `${pathName}.font_refs`, value.font_refs, { minItems: 1 });
  if (hasFontRefs) {
    for (let index = 0; index < value.font_refs.length; index += 1) {
      const fontRef = value.font_refs[index];
      if (!isObject(fontRef)) {
        pushError(errors, `${pathName}.font_refs[${index}]`, "must be an object");
        continue;
      }

      validateString(errors, `${pathName}.font_refs[${index}].font_id`, fontRef.font_id, {
        minLength: 1,
        maxLength: 128,
        pattern: ID_PATTERN,
      });
      validateString(errors, `${pathName}.font_refs[${index}].family_name`, fontRef.family_name, {
        minLength: 1,
      });
    }
  }

  const hasActivatedRights = validateArray(
    errors,
    `${pathName}.activated_right_ids`,
    value.activated_right_ids,
    { minItems: 1 },
  );
  if (hasActivatedRights) {
    for (let index = 0; index < value.activated_right_ids.length; index += 1) {
      validateString(
        errors,
        `${pathName}.activated_right_ids[${index}]`,
        value.activated_right_ids[index],
        {
          minLength: 1,
          maxLength: 128,
          pattern: ID_PATTERN,
        },
      );
    }
  }

  validateString(errors, `${pathName}.status`, value.status, { enum: INSTANCE_STATUS });

  const hasEvidence = validateArray(errors, `${pathName}.evidence`, value.evidence, { minItems: 1 });
  if (hasEvidence) {
    for (let index = 0; index < value.evidence.length; index += 1) {
      validateEvidence(errors, `${pathName}.evidence[${index}]`, value.evidence[index]);
    }
  }

  validateString(errors, `${pathName}.acquisition_source`, value.acquisition_source, {
    enum: ACQUISITION_SOURCES,
  });

  if (value.metric_limits !== undefined) {
    const hasMetricLimits = validateArray(errors, `${pathName}.metric_limits`, value.metric_limits);
    if (hasMetricLimits) {
      for (let index = 0; index < value.metric_limits.length; index += 1) {
        validateMetricLimit(errors, `${pathName}.metric_limits[${index}]`, value.metric_limits[index]);
      }
    }
  }
}

export async function validateManifestDocument(document) {
  const errors = [];

  if (!isObject(document)) {
    pushError(errors, "/", "must be an object");
    return { valid: false, errors };
  }

  if (document.manifest_version !== MANIFEST_VERSION) {
    pushError(errors, "/manifest_version", `must be '${MANIFEST_VERSION}'`);
  }

  if (!isObject(document.project)) {
    pushError(errors, "/project", "must be an object");
  } else {
    validateString(errors, "/project/project_id", document.project.project_id, {
      minLength: 1,
      maxLength: 128,
      pattern: ID_PATTERN,
    });
    validateString(errors, "/project/name", document.project.name, { minLength: 1 });

    if (document.project.domains !== undefined) {
      const hasDomains = validateArray(errors, "/project/domains", document.project.domains);
      if (hasDomains) {
        for (let index = 0; index < document.project.domains.length; index += 1) {
          validateString(errors, `/project/domains[${index}]`, document.project.domains[index], {
            minLength: 1,
          });
        }
      }
    }
  }

  const hasLicensees = validateArray(errors, "/licensees", document.licensees, { minItems: 1 });
  if (hasLicensees) {
    for (let index = 0; index < document.licensees.length; index += 1) {
      validateLicensee(errors, `/licensees[${index}]`, document.licensees[index]);
    }
  }

  const hasFonts = validateArray(errors, "/fonts", document.fonts);
  if (hasFonts) {
    for (let index = 0; index < document.fonts.length; index += 1) {
      validateFont(errors, `/fonts[${index}]`, document.fonts[index]);
    }
  }

  const hasInstances = validateArray(errors, "/license_instances", document.license_instances);
  if (hasInstances) {
    for (let index = 0; index < document.license_instances.length; index += 1) {
      validateLicenseInstance(errors, `/license_instances[${index}]`, document.license_instances[index]);
    }
  }

  if (document.license_offerings !== undefined) {
    const hasOfferings = validateArray(errors, "/license_offerings", document.license_offerings);
    if (hasOfferings) {
      for (let index = 0; index < document.license_offerings.length; index += 1) {
        validateLicenseOffering(errors, `/license_offerings[${index}]`, document.license_offerings[index]);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function validateLicenseDocument(document) {
  const errors = [];

  if (!isObject(document)) {
    pushError(errors, "/", "must be an object");
    return { valid: false, errors };
  }

  const kind = document.kind;

  if (kind === "offering") {
    validateLicenseOffering(errors, "/", document);
  } else if (kind === "instance") {
    validateLicenseInstance(errors, "/", document);
  } else {
    pushError(errors, "/kind", "must be either 'offering' or 'instance'");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function assertValidManifest(document) {
  const result = await validateManifestDocument(document);
  if (!result.valid) {
    throw new Error(`Manifest validation failed: ${result.errors.join("; ")}`);
  }
}

export async function assertValidLicense(document) {
  const result = await validateLicenseDocument(document);
  if (!result.valid) {
    throw new Error(`License validation failed: ${result.errors.join("; ")}`);
  }
}

export function resolveManifestPath(options = {}) {
  const cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();

  if (options.manifestPath) {
    return path.resolve(cwd, options.manifestPath);
  }

  const discoveredPath = findUp(MANIFEST_FILENAME, cwd);

  if (discoveredPath) {
    return discoveredPath;
  }

  if (options.required ?? true) {
    throw new Error(
      `Could not find ${MANIFEST_FILENAME} in ${cwd} or its parent directories. Run 'setzkasten init' first.`,
    );
  }

  return path.join(cwd, MANIFEST_FILENAME);
}

export async function loadManifest(options = {}) {
  const manifestPath = resolveManifestPath({
    cwd: options.cwd,
    manifestPath: options.manifestPath,
    required: true,
  });

  const manifest = await readJsonFile(manifestPath);
  await assertValidManifest(manifest);

  return {
    manifest,
    manifestPath,
    projectRoot: path.dirname(manifestPath),
  };
}

export async function saveManifest(manifestPath, manifest) {
  await assertValidManifest(manifest);
  await writeJsonFileAtomic(manifestPath, manifest);
}

export function createManifest(input) {
  const projectName = String(input.projectName ?? "").trim();
  if (projectName.length === 0) {
    throw new Error("projectName must not be empty.");
  }

  const projectId = input.projectId ?? slugifyId(projectName);
  const licenseeId = input.licenseeId ?? `${projectId}.owner`;

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    project: {
      project_id: projectId,
      name: projectName,
    },
    licensees: [
      {
        licensee_id: licenseeId,
        type: input.licenseeType ?? "organization",
        legal_name: input.licenseeLegalName ?? projectName,
      },
    ],
    fonts: [],
    license_instances: [],
  };

  if (input.projectRepo) {
    manifest.project.repo = input.projectRepo;
  }

  if (Array.isArray(input.projectDomains) && input.projectDomains.length > 0) {
    manifest.project.domains = input.projectDomains;
  }

  if (input.licenseeCountry) {
    manifest.licensees[0].country = input.licenseeCountry;
  }

  if (input.licenseeVatId) {
    manifest.licensees[0].vat_id = input.licenseeVatId;
  }

  if (input.licenseeContactEmail) {
    manifest.licensees[0].contact_email = input.licenseeContactEmail;
  }

  return manifest;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string");
}

export function addFontToManifest(manifest, font) {
  const draft = deepClone(manifest);
  const fonts = Array.isArray(draft.fonts) ? draft.fonts : [];

  if (fonts.some((entry) => isObject(entry) && entry.font_id === font.font_id)) {
    throw new Error(`Font with font_id '${font.font_id}' already exists in manifest.`);
  }

  fonts.push({
    font_id: font.font_id,
    family_name: font.family_name,
    source: font.source,
    usage: font.usage,
    active_license_instance_id: font.active_license_instance_id,
    license_instance_ids: normalizeStringArray(font.license_instance_ids),
  });

  draft.fonts = fonts;
  return draft;
}

export function removeFontFromManifest(manifest, fontId) {
  const draft = deepClone(manifest);
  const fonts = Array.isArray(draft.fonts) ? draft.fonts : [];

  const filteredFonts = fonts.filter((entry) => !isObject(entry) || entry.font_id !== fontId);

  draft.fonts = filteredFonts;

  return {
    manifest: draft,
    removed: filteredFonts.length !== fonts.length,
  };
}

export function getManifestProjectId(manifest) {
  if (!isObject(manifest.project)) {
    throw new Error("manifest.project must be an object.");
  }

  const projectId = manifest.project.project_id;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new Error("manifest.project.project_id is required.");
  }

  return projectId;
}

export function getManifestDomains(manifest) {
  if (!isObject(manifest.project)) {
    return [];
  }

  return normalizeStringArray(manifest.project.domains);
}
