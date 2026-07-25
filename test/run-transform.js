#!/usr/bin/env node
/**
 * Run src/transform.js against a saved API response and print the merge data
 * the views would receive.
 *
 *   node test/run-transform.js test/fixtures/durham.json
 *   node test/run-transform.js test/fixtures/durham.json -25200   # UTC offset
 *
 * This lives here, not in the transform itself: transform.js is executed as the
 * main module by the runtime, which attaches its own stdin reader, so it must
 * never touch process.stdin.
 */

const fs = require("node:fs");
const { run } = require("../src/transform.js");

const [file, offset] = process.argv.slice(2);
if (!file) {
  console.error("usage: node test/run-transform.js <response.json> [utc_offset_seconds]");
  process.exit(1);
}

const input = JSON.parse(fs.readFileSync(file, "utf8"));
if (offset !== undefined) {
  input.trmnl = { ...input.trmnl, user: { ...(input.trmnl || {}).user, utc_offset: Number(offset) } };
}

console.log(JSON.stringify(run(input), null, 2));
