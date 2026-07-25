/**
 * Tests for src/transform.js — plain `node --test`, no dependencies.
 *
 *   node --test test/
 *
 * Fixtures in test/fixtures/ are verbatim Recollect API responses captured from
 * two cities that name their collection types differently. They are what keeps
 * the classifier honest: Sacramento sends `Garbage`/`Recycling`/`YardWaste`
 * with a null subject, Durham sends `garbage`/`recycling`/`GreenBin` with
 * subjects like "Blue Box".
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { run, classify, parseDay, localToday, humanize, ICON_ORDER } = require("../src/transform.js");

const sacramento = require("./fixtures/sacramento.json");
const durham = require("./fixtures/durham.json");

/** Freeze the clock so day-math assertions don't drift. */
function at(utcMs, fn) {
  const real = Date.now;
  Date.now = () => utcMs;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

const labels = (result) => result.next.types.map((t) => t.label);
const pickup = (day, name, extra) => ({
  day,
  flags: [{ name, event_type: "pickup", ...extra }],
});

test("classifies US city types (subject is null, names are CamelCase)", () => {
  const result = at(Date.UTC(2026, 6, 24), () => run(sacramento));
  assert.deepEqual(labels(result), ["Garbage", "Recycling", "Yard Waste"]);
  assert.equal(result.area, "Sacramento");
});

test("prefers the city's own vocabulary when it supplies a subject", () => {
  const result = at(Date.UTC(2026, 6, 24), () => run(durham));
  assert.deepEqual(labels(result), ["Garbage", "Blue Box", "Green Bin", "Yard Waste"]);
  assert.equal(result.area, "Durham");
});

test("regional vocabulary falls out of flag.name when subject is absent", () => {
  const cases = {
    // Canada
    GreenBin: "Green Bin",
    GreenCart: "Green Cart",
    BlueBox: "Blue Box",
    BlueBin: "Blue Bin",
    BlueCart: "Blue Cart",
    // US
    Organics: "Organics",
    FoodScraps: "Organics",
    Compost: "Organics",
    Recycling: "Recycling",
    // "green waste" means yard waste in the US — must beat "green" -> organics
    GreenWaste: "Yard Waste",
    "Green Waste": "Yard Waste",
    YardWaste: "Yard Waste",
    Leaves: "Yard Waste",
    // Refuse, by any name
    Garbage: "Garbage",
    Trash: "Garbage",
    SolidWaste: "Garbage",
    Refuse: "Garbage",
  };

  for (const [name, expected] of Object.entries(cases)) {
    const result = run({ events: [pickup("2099-01-01", name)] });
    assert.equal(result.next.types[0].label, expected, `${name} -> ${expected}`);
  }
});

test("unknown types keep the city's name, humanized", () => {
  const result = run({ events: [pickup("2099-01-01", "BulkyItemPickup")] });
  assert.equal(result.next.types[0].label, "Bulky Item Pickup");
  assert.equal(result.next.types[0].icon, 5, "falls back to the neutral icon");
});

test("every icon index is within the shared.liquid table", () => {
  for (const fixture of [sacramento, durham]) {
    for (const type of at(Date.UTC(2026, 6, 24), () => run(fixture)).next.types) {
      assert.ok(type.icon >= 0 && type.icon < ICON_ORDER.length, `icon ${type.icon} out of range`);
    }
  }
});

test("ICON_ORDER matches the icon table in shared.liquid", () => {
  // The transform ships a numeric index; shared.liquid holds the icons. This
  // is the coupling both files warn about — make a mismatch fail loudly here
  // instead of silently drawing the wrong bin on the device.
  const shared = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/shared.liquid"),
    "utf8",
  );
  const capture = /\{%-\s*capture icons_joined\s*-%\}([\s\S]*?)\{%-\s*endcapture\s*-%\}/.exec(shared);
  assert.ok(capture, "shared.liquid must define the icons_joined capture");
  const table = [...capture[1].matchAll(/icon_([a-z]+)/g)].map((m) => m[1]);
  // "other" has no icon of its own; it reuses recycling as the neutral stand-in.
  const expected = ICON_ORDER.map((key) => (key === "other" ? "recycling" : key));
  assert.deepEqual(table, expected, "reorder either side and this fails instead of drawing the wrong bin");
});

test("days_until is measured against the user's local date, not the server's", () => {
  // 2026-07-25 01:00 UTC is still the evening of the 24th in Sacramento.
  const clock = Date.UTC(2026, 6, 25, 1, 0, 0);
  const events = [pickup("2026-07-25", "Garbage")];

  const utc = at(clock, () => run({ events }));
  const local = at(clock, () => run({ events, trmnl: { user: { utc_offset: -25200 } } }));

  assert.equal(utc.next.days_until, 0, "server clock alone reads 'today'");
  assert.equal(local.next.days_until, 1, "user's clock correctly reads 'tomorrow'");
});

test("utc_offset is accepted in seconds or hours, and is optional", () => {
  const clock = Date.UTC(2026, 6, 25, 1, 0, 0);
  const today = (trmnl) => at(clock, () => run({ events: [], trmnl })).today;

  assert.equal(today({ user: { utc_offset: -25200 } }), "2026-07-24");
  assert.equal(today({ user: { utc_offset: -7 } }), "2026-07-24");
  assert.equal(today({ user: { utc_offset: "-25200" } }), "2026-07-24");
  assert.equal(today(undefined), "2026-07-25", "falls back to UTC");
});

test("day math counts whole days across a DST boundary", () => {
  // US spring-forward was 2026-03-08; a naive (t2 - t1) / 86400 loses an hour
  // here and floors to 3.
  const result = at(Date.UTC(2026, 2, 6, 12), () =>
    run({ events: [pickup("2026-03-10", "Garbage")] }),
  );
  assert.equal(result.next.days_until, 4);
});

test("collapses a collection day split across events, and drops the past", () => {
  const result = run({
    events: [
      pickup("2099-01-01", "Garbage"),
      pickup("2099-01-01", "garbage"), // same type, different casing
      pickup("2000-01-01", "Recycling"), // long past
    ],
  });
  assert.equal(result.next.types.length, 1);
  assert.equal(result.upcoming.length, 0);
});

test("separates pickups, holidays and dated notices", () => {
  const result = at(Date.UTC(2026, 6, 24), () => run(sacramento));
  // Street sweeping is notification_with_date — a date to know, not a bin.
  assert.equal(result.notices[0].label, "Street Sweeping");
  assert.ok(!labels(result).includes("Street Sweeping"));

  const withHoliday = at(Date.UTC(2026, 6, 24), () => run(durham));
  assert.equal(withHoliday.holidays[0].label, "Civic Holiday");
});

test("a holiday that still lists pickups keeps both", () => {
  const result = run({
    events: [
      {
        day: "2099-01-01",
        is_holiday: 1,
        flags: [
          { name: "holiday", subject: "Labour Day" },
          { name: "Garbage", event_type: "pickup" },
        ],
      },
    ],
  });
  assert.equal(result.holidays[0].label, "Labour Day");
  assert.deepEqual(labels(result), ["Garbage"], "the pickup must not be swallowed");

  // A holiday day whose only flags are pickups: nothing names it, so the
  // label falls back to "Holiday" — and no pickup flag is consumed as it.
  const shifted = run({
    events: [
      { day: "2099-01-01", is_holiday: 1, flags: [{ name: "Garbage", event_type: "pickup" }] },
    ],
  });
  assert.equal(shifted.holidays[0].label, "Holiday");
  assert.deepEqual(labels(shifted), ["Garbage"]);
});

test('is_holiday is honored as 1, "1", or true', () => {
  for (const value of [1, "1", true]) {
    const result = run({
      events: [{ day: "2099-01-01", is_holiday: value, flags: [{ name: "holiday", subject: "X" }] }],
    });
    assert.equal(result.holidays.length, 1, `is_holiday: ${JSON.stringify(value)}`);
    assert.equal(result.has_pickups, false);
  }
});

test("a malformed event or flag is skipped, not fatal", () => {
  // One bad element must cost that element, never the render — a throw here
  // is a blank e-ink screen until the next poll.
  const result = run({
    events: [
      null,
      42,
      "not an event",
      { day: 12345, flags: [{ name: "Garbage", event_type: "pickup" }] },
      {
        day: "2099-01-05",
        flags: [null, "bad", 7, { name: "Recycling", event_type: "pickup", area_name: "Testville" }],
      },
    ],
  });
  assert.equal(result.has_pickups, true, "the good event still renders");
  assert.deepEqual(labels(result), ["Recycling"]);
  assert.equal(result.area, "Testville");
});

test("survives missing, empty and malformed payloads", () => {
  for (const input of [
    null,
    undefined,
    {},
    { events: "not an array" },
    { events: [] },
    { events: [{ day: "2099-01-01" }] }, // no flags
    { events: [pickup("not-a-date", "Garbage")] },
  ]) {
    const result = run(input);
    assert.equal(result.has_pickups, false, `input: ${JSON.stringify(input)}`);
    assert.equal(result.next, null);
    assert.deepEqual(result.upcoming, []);
  }
});

test("passes through the trmnl namespace and the address custom field", () => {
  const result = run({
    trmnl: {
      user: { name: "Jo" },
      plugin_settings: { custom_fields_values: { address: "1 King St" } },
    },
  });
  assert.deepEqual(result.trmnl.user, { name: "Jo" }, "views still read trmnl.*");
  assert.equal(result.address, "1 King St");
});

test("parseDay rejects impossible dates instead of rolling them over", () => {
  assert.equal(parseDay("2026-13-45"), null, "would otherwise land in Feb 2027");
  assert.equal(parseDay("2026-02-30"), null);
  assert.equal(parseDay("2026-00-10"), null);
  assert.equal(parseDay("2024-02-29"), Date.UTC(2024, 1, 29), "real leap day");
  assert.equal(parseDay("2026-07-28T00:00:00-07:00"), Date.UTC(2026, 6, 28), "datetime prefix");
  assert.equal(parseDay("garbage-day"), null);
  assert.equal(parseDay(null), null);
});

test("localToday understands seconds, hours, strings, and garbage", () => {
  at(Date.UTC(2026, 6, 25, 1, 0, 0), () => {
    const day = (utc_offset) =>
      new Date(localToday({ user: { utc_offset } })).toISOString().slice(0, 10);
    assert.equal(day(-25200), "2026-07-24", "seconds");
    assert.equal(day(-7), "2026-07-24", "hours");
    assert.equal(day("-25200"), "2026-07-24", "numeric string");
    assert.equal(day(-12600), "2026-07-24", "half-hour zone in seconds (UTC-3:30)");
    assert.equal(day(5.75), "2026-07-25", "fractional hours (UTC+5:45)");
    assert.equal(day("PDT"), "2026-07-25", "garbage falls back to UTC");
    assert.equal(new Date(localToday(undefined)).toISOString().slice(0, 10), "2026-07-25");
  });
});

test("classify pairs the right icon with the city's own label", () => {
  assert.equal(classify({ name: "GreenWaste" }).icon, ICON_ORDER.indexOf("yard"), "US green waste is yard, not organics");
  assert.equal(classify({ name: "GreenBin" }).icon, ICON_ORDER.indexOf("organics"));
  const blueBox = classify({ name: "recycling", subject: "Blue Box" });
  assert.equal(blueBox.label, "Blue Box", "subject wins the label");
  assert.equal(blueBox.icon, ICON_ORDER.indexOf("recycling"), "…but never changes the icon");
  assert.equal(classify({}).icon, ICON_ORDER.indexOf("other"));
});

test("humanize turns machine identifiers into display labels", () => {
  assert.equal(humanize("StreetSweeping"), "Street Sweeping");
  assert.equal(humanize("yard_waste"), "Yard Waste");
  assert.equal(humanize("bulky-item-pickup"), "Bulky Item Pickup");
  assert.equal(humanize(""), "");
});

test("never touches process.stdin", () => {
  // The runtime copies transform.js to a temp dir, runs it as the main module,
  // and appends its own stdin reader. A reader of ours races it for the same
  // stream and one side parses "" — which fails the whole render, not just a
  // view. Neither `trmnlp lint` nor the tests above would catch it, so assert
  // on the source directly.
  const source = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "../src/transform.js"),
    "utf8",
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/process\.stdin/.test(code), "transform.js must not read process.stdin");
});

test("emits the date formats the views ask for", () => {
  const result = at(Date.UTC(2026, 6, 24), () => run(sacramento));
  assert.equal(result.next.date, "2026-07-28");
  assert.equal(result.next.long, "Tuesday, July 28");
  assert.equal(result.next.medium, "Tue, Jul 28");
  assert.equal(result.next.short, "Jul 28");
});
