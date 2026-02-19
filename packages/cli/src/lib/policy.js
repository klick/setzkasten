function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asStringArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => typeof entry === "string" && entry.length > 0);
}

function readProjectDomains(manifest) {
  const project = asObject(manifest.project);
  if (!project) {
    return [];
  }

  return asStringArray(project.domains);
}

function makeOfferingKey(offeringId, offeringVersion) {
  return `${offeringId}@${offeringVersion}`;
}

function readRequiredModifications(fontUsage) {
  const usage = asObject(fontUsage);
  if (!usage) {
    return [];
  }

  const candidates = [
    usage.required_modifications,
    usage.modifications_required,
    usage.requiredModificationKinds,
  ];

  for (const candidate of candidates) {
    const values = asStringArray(candidate);
    if (values.length > 0) {
      return values;
    }
  }

  return [];
}

function isSelfHostingUsage(fontUsage) {
  const usage = asObject(fontUsage);
  if (!usage) {
    return false;
  }

  if (usage.self_hosting === true) {
    return true;
  }

  const hosting = usage.hosting;
  if (typeof hosting === "string") {
    return hosting === "self_hosting";
  }

  if (Array.isArray(hosting)) {
    return hosting.includes("self_hosting");
  }

  return false;
}

function findRight(rights, rightType) {
  return rights.find((right) => typeof right.right_type === "string" && right.right_type === rightType) ?? null;
}

function makeDecision(reasons) {
  if (reasons.some((reason) => reason.severity === "escalate")) {
    return "escalate";
  }

  if (reasons.some((reason) => reason.severity === "warn")) {
    return "warn";
  }

  return "allow";
}

function normalizeRights(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

export function evaluatePolicy(manifest) {
  const reasons = [];
  const evidenceRequired = new Set();

  const projectDomains = readProjectDomains(manifest);
  const fonts = Array.isArray(manifest.fonts) ? manifest.fonts : [];
  const instances = Array.isArray(manifest.license_instances) ? manifest.license_instances : [];
  const offerings = Array.isArray(manifest.license_offerings) ? manifest.license_offerings : [];

  const instancesById = new Map();
  for (const instance of instances) {
    const instanceId = asString(instance.license_id);
    if (instanceId) {
      instancesById.set(instanceId, instance);
    }
  }

  const offeringsByKey = new Map();
  for (const offering of offerings) {
    const offeringId = asString(offering.offering_id);
    const offeringVersion = asString(offering.offering_version);

    if (offeringId && offeringVersion) {
      offeringsByKey.set(makeOfferingKey(offeringId, offeringVersion), offering);
    }
  }

  for (const font of fonts) {
    const fontId = asString(font.font_id) ?? "unknown_font";
    const source = asObject(font.source);
    const sourceType = asString(source?.type);

    const instanceIds = asStringArray(font.license_instance_ids);
    const activeInstanceId = asString(font.active_license_instance_id) ?? instanceIds[0] ?? null;
    const instance = activeInstanceId ? instancesById.get(activeInstanceId) ?? null : null;

    if (sourceType === "byo") {
      if (!instance) {
        reasons.push({
          code: "BYO_NO_LICENSE_INSTANCE",
          severity: "warn",
          message: `BYO font '${fontId}' has no linked license instance.`,
          context: { font_id: fontId },
        });
        evidenceRequired.add("license_instances[].evidence[]");
      } else {
        const evidence = Array.isArray(instance.evidence) ? instance.evidence : [];
        if (evidence.length === 0) {
          reasons.push({
            code: "BYO_NO_EVIDENCE",
            severity: "warn",
            message: `BYO font '${fontId}' has no evidence attached.`,
            context: { font_id: fontId, license_id: activeInstanceId },
          });
          evidenceRequired.add("license_instances[].evidence[]");
        }
      }
    }

    if (!instance) {
      continue;
    }

    const status = asString(instance.status);
    if (status && status !== "active") {
      reasons.push({
        code: "LICENSE_STATUS_NOT_ACTIVE",
        severity: "escalate",
        message: `License instance '${activeInstanceId}' is '${status}', not active.`,
        context: { license_id: activeInstanceId, status },
      });
    }

    const scope = asObject(instance.scope);
    const scopeDomains = asStringArray(scope?.domains);

    if (projectDomains.length > 0 && scopeDomains.length > 0) {
      for (const domain of projectDomains) {
        if (!scopeDomains.includes(domain)) {
          reasons.push({
            code: "DOMAIN_OUT_OF_SCOPE",
            severity: "warn",
            message: `Project domain '${domain}' is not covered by license scope for '${activeInstanceId}'.`,
            context: { license_id: activeInstanceId, domain },
          });
        }
      }
    }

    const offeringRef = asObject(instance.offering_ref);
    const offeringId = asString(offeringRef?.offering_id);
    const offeringVersion = asString(offeringRef?.offering_version);

    let offering = null;
    if (offeringId && offeringVersion) {
      offering = offeringsByKey.get(makeOfferingKey(offeringId, offeringVersion)) ?? null;
      if (!offering) {
        reasons.push({
          code: "OFFERING_REFERENCE_MISSING",
          severity: "warn",
          message: `Offering '${offeringId}@${offeringVersion}' referenced by '${activeInstanceId}' is missing.`,
          context: { license_id: activeInstanceId, offering_id: offeringId, offering_version: offeringVersion },
        });
      }
    }

    if (!offering) {
      continue;
    }

    const rights = normalizeRights(offering.rights);

    if (isSelfHostingUsage(font.usage)) {
      const selfHostingRight = findRight(rights, "distribution_self_hosting");
      const cdnHostingRight = findRight(rights, "distribution_cdn_hosting");

      const selfHostingAllowed = selfHostingRight?.allowed === true;
      const cdnOnly = cdnHostingRight?.allowed === true && !selfHostingAllowed;

      if (cdnOnly) {
        reasons.push({
          code: "SELF_HOSTING_NOT_ALLOWED",
          severity: "warn",
          message: `Font '${fontId}' appears self-hosted but offering allows CDN-only distribution.`,
          context: { font_id: fontId, license_id: activeInstanceId },
        });
      }
    }

    const requiredModifications = readRequiredModifications(font.usage);
    if (requiredModifications.length > 0) {
      const modificationRight = findRight(rights, "modification");

      if (!modificationRight || modificationRight.allowed !== true) {
        reasons.push({
          code: "MODIFICATION_NOT_ALLOWED",
          severity: "escalate",
          message: `Font '${fontId}' requires modification but offering does not allow it.`,
          context: { font_id: fontId, license_id: activeInstanceId, required: requiredModifications },
        });
        continue;
      }

      const allowedKinds = asStringArray(modificationRight.modification_kinds);
      if (allowedKinds.length > 0) {
        const disallowedKinds = requiredModifications.filter((kind) => !allowedKinds.includes(kind));

        if (disallowedKinds.length > 0) {
          reasons.push({
            code: "MODIFICATION_KIND_NOT_ALLOWED",
            severity: "escalate",
            message: `Font '${fontId}' requires unsupported modification kinds.`,
            context: {
              font_id: fontId,
              license_id: activeInstanceId,
              required: requiredModifications,
              disallowed: disallowedKinds,
            },
          });
        }
      }
    }
  }

  return {
    decision: makeDecision(reasons),
    reasons,
    evidence_required: Array.from(evidenceRequired).sort((a, b) => a.localeCompare(b)),
  };
}
