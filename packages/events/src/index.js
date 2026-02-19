import path from "node:path";
import {
  EVENT_LOG_RELATIVE_PATH,
  LICENSE_SPEC_VERSION,
  MANIFEST_VERSION,
  appendLine,
  canonicalStringify,
  makeEventId,
  nowIso,
  sha256Hex,
} from "../../core/src/index.js";

export function createEvent(input) {
  const payload = input.payload ?? {};

  return {
    event_id: makeEventId(),
    event_type: input.eventType,
    ts: nowIso(),
    actor: input.actor ?? "local_user",
    project_id: input.projectId,
    schema_versions: {
      manifest: input.schemaVersions?.manifest ?? MANIFEST_VERSION,
      license_spec: input.schemaVersions?.license_spec ?? LICENSE_SPEC_VERSION,
    },
    payload,
    payload_hash: sha256Hex(canonicalStringify(payload)),
  };
}

export async function appendEvent(projectRoot, event) {
  const eventLogPath = path.join(projectRoot, EVENT_LOG_RELATIVE_PATH);
  await appendLine(eventLogPath, JSON.stringify(event));
  return eventLogPath;
}

export async function appendProjectEvent(input) {
  const event = createEvent({
    eventType: input.eventType,
    actor: input.actor,
    projectId: input.projectId,
    payload: input.payload,
    schemaVersions: input.schemaVersions,
  });

  const eventLogPath = await appendEvent(input.projectRoot, event);

  return {
    eventLogPath,
    event,
  };
}
