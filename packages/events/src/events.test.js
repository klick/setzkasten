import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { appendEvent, createEvent } from "./index.js";

test("appendEvent writes NDJSON in append-only order", async () => {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "setzkasten-events-"));

  const firstEvent = createEvent({
    eventType: "manifest.created",
    projectId: "proj_1",
    payload: { step: 1 },
  });

  const eventLogPath = await appendEvent(projectRoot, firstEvent);
  const sizeAfterFirst = (await stat(eventLogPath)).size;

  const secondEvent = createEvent({
    eventType: "manifest.font_added",
    projectId: "proj_1",
    payload: { step: 2 },
  });

  await appendEvent(projectRoot, secondEvent);
  const sizeAfterSecond = (await stat(eventLogPath)).size;

  assert.ok(sizeAfterSecond > sizeAfterFirst, "expected second append to increase file size");

  const lines = (await readFile(eventLogPath, "utf8")).trim().split("\n");
  assert.equal(lines.length, 2);

  const parsedFirst = JSON.parse(lines[0]);
  const parsedSecond = JSON.parse(lines[1]);

  assert.equal(parsedFirst.event_type, "manifest.created");
  assert.equal(parsedFirst.payload.step, 1);
  assert.equal(parsedSecond.event_type, "manifest.font_added");
  assert.equal(parsedSecond.payload.step, 2);
});
