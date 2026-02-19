import { canonicalStringify, nowIso, roundMoney, sha256Hex } from "./core.js";

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value;
}

function asString(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  return null;
}

function asMetricLimits(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry) => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
}

function matchesWhen(when, instance) {
  const metricType = asString(when.metric_type);
  const period = asString(when.period);

  const limits = asMetricLimits(instance.metric_limits).filter((limit) => {
    const limitMetricType = asString(limit.metric_type);
    const limitPeriod = asString(limit.period);

    if (metricType && limitMetricType !== metricType) {
      return false;
    }

    if (period && limitPeriod !== period) {
      return false;
    }

    return true;
  });

  if ((metricType || period) && limits.length === 0) {
    return false;
  }

  const gte = asNumber(when.gte);
  const gt = asNumber(when.gt);
  const lte = asNumber(when.lte);
  const lt = asNumber(when.lt);
  const eq = asNumber(when.eq);

  if (gte === null && gt === null && lte === null && lt === null && eq === null) {
    return true;
  }

  const candidates = limits.length > 0 ? limits : asMetricLimits(instance.metric_limits);

  return candidates.some((candidate) => {
    const value = asNumber(candidate.limit);
    if (value === null) {
      return false;
    }

    if (gte !== null && value < gte) {
      return false;
    }

    if (gt !== null && value <= gt) {
      return false;
    }

    if (lte !== null && value > lte) {
      return false;
    }

    if (lt !== null && value >= lt) {
      return false;
    }

    if (eq !== null && value !== eq) {
      return false;
    }

    return true;
  });
}

function makeOfferingKey(offeringId, offeringVersion) {
  return `${offeringId}@${offeringVersion}`;
}

function evaluateAmountForInstance(instance, offering) {
  const priceFormula = asObject(offering.price_formula);
  if (!priceFormula) {
    throw new Error("price_formula missing for offering.");
  }

  const currency = asString(priceFormula.currency);
  const basePrice = asNumber(priceFormula.base_price);

  if (!currency || basePrice === null) {
    throw new Error("price_formula must include currency and base_price.");
  }

  let amount = basePrice;

  const rules = Array.isArray(priceFormula.rules)
    ? priceFormula.rules.filter((rule) => {
        return Boolean(rule) && typeof rule === "object" && !Array.isArray(rule);
      })
    : [];

  for (const rule of rules) {
    const when = asObject(rule.when);

    if (when && !matchesWhen(when, instance)) {
      continue;
    }

    const multiplier = asNumber(rule.multiplier) ?? 1;
    const add = asNumber(rule.add) ?? 0;

    amount = roundMoney(amount * multiplier + add);
  }

  return {
    currency,
    amount: roundMoney(amount),
  };
}

export function generateQuote(manifest) {
  const offerings = Array.isArray(manifest.license_offerings) ? manifest.license_offerings : [];
  const instances = Array.isArray(manifest.license_instances) ? manifest.license_instances : [];

  const offeringsByKey = new Map();

  for (const offering of offerings) {
    const offeringId = asString(offering.offering_id);
    const offeringVersion = asString(offering.offering_version);

    if (offeringId && offeringVersion) {
      offeringsByKey.set(makeOfferingKey(offeringId, offeringVersion), offering);
    }
  }

  const lineItems = [];
  const skipped = [];

  for (const instance of instances) {
    const licenseId = asString(instance.license_id);
    if (!licenseId) {
      continue;
    }

    const status = asString(instance.status);
    if (status && status !== "active") {
      skipped.push(`${licenseId}:status=${status}`);
      continue;
    }

    const offeringRef = asObject(instance.offering_ref);
    const offeringId = asString(offeringRef?.offering_id);
    const offeringVersion = asString(offeringRef?.offering_version);

    if (!offeringId || !offeringVersion) {
      skipped.push(`${licenseId}:offering_ref_missing`);
      continue;
    }

    const offering = offeringsByKey.get(makeOfferingKey(offeringId, offeringVersion));
    if (!offering) {
      skipped.push(`${licenseId}:offering_not_found`);
      continue;
    }

    const evaluated = evaluateAmountForInstance(instance, offering);

    lineItems.push({
      license_id: licenseId,
      offering_id: offeringId,
      offering_version: offeringVersion,
      currency: evaluated.currency,
      amount: evaluated.amount,
    });
  }

  lineItems.sort((a, b) => a.license_id.localeCompare(b.license_id));

  const totals = {};
  for (const lineItem of lineItems) {
    const previous = totals[lineItem.currency] ?? 0;
    totals[lineItem.currency] = roundMoney(previous + lineItem.amount);
  }

  skipped.sort((a, b) => a.localeCompare(b));

  const fingerprintTarget = {
    totals,
    line_items: lineItems,
    skipped,
  };

  return {
    generated_at: nowIso(),
    totals,
    line_items: lineItems,
    skipped,
    deterministic_hash: sha256Hex(canonicalStringify(fingerprintTarget)),
  };
}
