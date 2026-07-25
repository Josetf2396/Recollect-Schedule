/**
 * Recollect Schedule — serverless transform.
 *
 * Runs once per poll, server-side. Whatever `run(input)` returns becomes the
 * template merge data, so this file does every bit of computation the four
 * views used to repeat on every render: filtering, sorting, day math, and
 * collection-type classification.
 *
 * Why this exists:
 *   - The raw Recollect payload is ~10 KB of mostly-unused flag metadata
 *     (colors, icon URIs, voice/html messages). We ship ~1 KB instead.
 *   - "Days until pickup" was computed in Liquid as (t2 - t1) / 86400 against
 *     `"now"`, which is the *server's* clock in UTC. For a user in Sacramento
 *     (UTC-7) that flips to "tomorrow" at 5 PM local, so an evening glance at
 *     the display could read "Today" for a pickup that is actually tomorrow.
 *     Here we resolve the user's local calendar date first, then subtract
 *     whole UTC-midnights — no seconds arithmetic, so DST can't skew it either.
 *
 * Contract with src/shared.liquid: each type carries an `icon` index into
 * ICON_ORDER. A unit test cross-checks this list against the icon table in
 * shared.liquid, so reordering either side fails CI instead of silently
 * drawing the wrong bin.
 */

const ICON_ORDER = ["garbage", "recycling", "organics", "yard", "pumpkin", "other"];

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const DAY_MS = 86400000;
const MAX_HOLIDAYS = 3;
const MAX_NOTICES = 3;
const MAX_UPCOMING = 4;

/** "2026-07-28" -> UTC-midnight epoch ms, or null if unparseable/impossible. */
function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const check = new Date(ms);
  // Date.UTC rolls impossible dates over silently ("2026-13-45" lands in
  // February 2027); round-trip and reject instead of misplacing the event.
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/**
 * Formatted forms of a date, matching what the views used to ask Liquid for:
 * "%A, %B %-d", "%a, %b %-d" and "%b %-d".
 * Built by hand rather than via toLocaleDateString so output can't shift with
 * the runtime's ICU data or ambient timezone.
 */
function formats(ms) {
  const date = new Date(ms);
  const weekday = WEEKDAYS[date.getUTCDay()];
  const month = MONTHS[date.getUTCMonth()];
  const day = date.getUTCDate();
  return {
    long: `${weekday}, ${month} ${day}`,
    medium: `${weekday.slice(0, 3)}, ${month.slice(0, 3)} ${day}`,
    short: `${month.slice(0, 3)} ${day}`,
  };
}

/**
 * The user's *local* calendar date as a UTC-midnight epoch ms.
 * TRMNL reports utc_offset in seconds; we accept hours too, since a value that
 * small can only be hours, and fall back to UTC when it's missing entirely.
 */
function localToday(trmnl) {
  const raw = trmnl && trmnl.user ? trmnl.user.utc_offset : undefined;
  const numeric = typeof raw === "string" ? Number(raw) : raw;
  let seconds = 0;
  if (typeof numeric === "number" && Number.isFinite(numeric)) {
    seconds = Math.abs(numeric) > 1000 ? numeric : numeric * 3600;
  }
  const shifted = new Date(Date.now() + seconds * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function includesAny(haystack, ...needles) {
  return needles.some((needle) => haystack.includes(needle));
}

/**
 * Flag names are machine identifiers ("StreetSweeping", "yard_waste"), and we
 * fall back to showing them when a city gives us no friendlier subject — so
 * split camelCase, swap separators for spaces, and title-case the result.
 * Never applied to flag.subject, which is already the city's display string.
 */
function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b[a-z]/g, (char) => char.toUpperCase());
}

/**
 * Recollect's flag.name is not standardized across cities:
 *   Sacramento -> Garbage, Recycling, YardWaste   (flag.subject: null)
 *   Durham     -> garbage, recycling, yardwaste, GreenBin
 *                 (flag.subject: "Garbage", "Blue Box", "Green Bin")
 * So classify on downcased keyword substrings, first match wins.
 *
 * Label resolution runs in three stages — flag.subject, then a label derived
 * from flag.name, then a neutral term — which is what keeps regional
 * vocabulary right: Canadian cities say "Green Bin"/"Blue Box", US cities say
 * "Organics"/"Recycling", and we echo whichever word the city itself used.
 *
 * Order matters in one place: "green waste" means *yard waste* in the US, so
 * it has to be caught before "green" -> organics.
 */
function classify(flag) {
  const name = String(flag.name || "").trim();
  const n = name.toLowerCase();
  let key;
  let label;

  if (includesAny(n, "yard", "leaf", "leav", "greenwaste", "green waste")) {
    key = "yard";
    label = "Yard Waste";
  } else if (n.includes("pumpkin")) {
    key = "pumpkin";
    label = "Pumpkins";
  } else if (includesAny(n, "green", "organ", "compost", "food")) {
    key = "organics";
    if (n.includes("green") && n.includes("cart")) label = "Green Cart";
    else if (n.includes("green")) label = "Green Bin";
    else label = "Organics";
  } else if (includesAny(n, "recycl", "blue")) {
    key = "recycling";
    if (n.includes("blue") && n.includes("cart")) label = "Blue Cart";
    else if (n.includes("blue") && n.includes("bin")) label = "Blue Bin";
    else if (n.includes("blue")) label = "Blue Box";
    else label = "Recycling";
  } else if (includesAny(n, "garbage", "trash", "refuse", "solid")) {
    key = "garbage";
    label = "Garbage";
  } else {
    // Unknown type: show the city's own name for it.
    key = "other";
    label = humanize(name);
  }

  const subject = String(flag.subject || "").trim();
  return { label: subject || label, icon: ICON_ORDER.indexOf(key) };
}

function flagsOf(event) {
  return Array.isArray(event.flags) ? event.flags : [];
}

function labelOf(flag, fallback) {
  const subject = String(flag.subject || "").trim();
  return subject || humanize(flag.name) || fallback;
}

function run(input) {
  const data = input && typeof input === "object" ? input : {};
  const trmnl = data.trmnl || {};
  const settings = trmnl.plugin_settings || {};
  const fields = settings.custom_fields_values || {};

  const events = Array.isArray(data.events) ? data.events : [];
  const todayMs = localToday(trmnl);

  const pickupsByDay = new Map();
  const holidays = [];
  const notices = [];
  let area = "";

  for (const event of events) {
    // Parsed JSON can still hold nulls and wrong types anywhere. A malformed
    // event costs us that one event, never the render — a throw here means a
    // blank e-ink screen until the next poll.
    if (!event || typeof event !== "object") continue;

    const ms = parseDay(event.day);
    // The poll window starts a day early (see polling_url in settings.yml):
    // `after` is rendered from the server's UTC clock, so for an evening user
    // whose UTC date has rolled over it would otherwise start tomorrow and
    // omit a pickup that is still "today" locally. Dropping everything before
    // the *local* date here is the other half of that contract.
    if (ms === null || ms < todayMs) continue;

    const flags = flagsOf(event).filter((flag) => flag && typeof flag === "object");

    if (!area) {
      const named = flags.find((flag) => flag.area_name);
      if (named) area = String(named.area_name).trim();
    }

    // Holiday-ness and pickup-ness are not exclusive: a city can flag a day as
    // a holiday and still run (or shift) collection on it. Record the holiday
    // and remember which flag described it, but keep processing the others —
    // `continue`-ing here would silently drop that day's pickups.
    let holidayFlag = null;
    if (Number(event.is_holiday) === 1) { // coerced: the API may say 1, "1", or true
      holidayFlag =
        flags.find(
          (flag) =>
            flag.event_type !== "pickup" &&
            String(flag.name || "").toLowerCase().includes("holiday"),
        ) ||
        flags.find(
          (flag) => flag.event_type !== "pickup" && flag.event_type !== "notification_with_date",
        ) ||
        null;
      holidays.push({ ms, label: labelOf(holidayFlag || {}, "Holiday") });
    }

    for (const flag of flags) {
      if (flag === holidayFlag) continue; // already recorded as the holiday
      if (flag.event_type === "pickup") {
        if (!pickupsByDay.has(ms)) pickupsByDay.set(ms, new Map());
        const types = pickupsByDay.get(ms);
        const type = classify(flag);
        // nomerge=1 splits one collection day across several events, and a day
        // can repeat a type; key by label so each bin is drawn once.
        if (!types.has(type.label)) types.set(type.label, type);
      } else if (flag.event_type === "notification_with_date") {
        // e.g. Sacramento's street sweeping — dated, but not a bin at the curb.
        notices.push({ ms, label: labelOf(flag, "Notice") });
      }
    }
  }

  const describe = (ms, extra) => ({
    date: new Date(ms).toISOString().slice(0, 10),
    ...formats(ms),
    days_until: Math.round((ms - todayMs) / DAY_MS),
    ...extra,
  });

  const pickupDays = [...pickupsByDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, types]) => describe(ms, { types: [...types.values()] }));

  const byDate = (a, b) => a.ms - b.ms;

  return {
    // Preserved so `trmnl.*` keeps working in the views — the return value
    // replaces the merge data wholesale.
    trmnl,
    address: String(data.address || fields.address || "").trim(),
    area,
    today: new Date(todayMs).toISOString().slice(0, 10),
    has_pickups: pickupDays.length > 0,
    next: pickupDays[0] || null,
    upcoming: pickupDays.slice(1, 1 + MAX_UPCOMING),
    holidays: holidays.sort(byDate).slice(0, MAX_HOLIDAYS).map((h) => describe(h.ms, { label: h.label })),
    notices: notices.sort(byDate).slice(0, MAX_NOTICES).map((n) => describe(n.ms, { label: n.label })),
  };
}

// `run` must stay a top-level function declaration: the runtime appends its
// own bootstrap to a copy of this file and calls it directly. Everything else
// is exported for direct unit tests only.
//
// Do NOT read process.stdin here: this file is executed as the main module, so
// a reader of our own races the runtime's for the same stream and one of them
// gets an empty string.
if (typeof module !== "undefined" && module.exports) {
  module.exports = { run, classify, parseDay, localToday, humanize, ICON_ORDER };
}
