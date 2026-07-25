# Recollect Schedule

A [TRMNL](https://trmnl.com) plugin that shows your next waste collection — garbage, recycling,
organics, and yard waste — on an ePaper display.

It works with **any city served by [Recollect](https://recollect.net)**, the collection-calendar
software used by hundreds of municipalities across the US and Canada. Nothing in the plugin is
tied to a particular city: the location, the service, the collection types, and even the city
name in the title bar all come out of the API response.

Connected by [GitHub Sync](https://help.trmnl.com/en/articles/15977899-github-sync): every save in
TRMNL lands here as a commit.

## Setup

The plugin asks for one thing — a **Calendar URL**:

1. Open your city's waste collection calendar page and look up your address.
2. Find the **Subscribe** / **Add to calendar** link and copy its URL. It looks like this:
   ```
   https://api.recollect.net/api/places/EE0C3310-C0C3-11E6-8A10-F4110BA3B673/services/340/events.en-US.ics?client_id=…
   ```
3. Paste it into the Calendar URL field.

Your place ID and service ID are parsed straight out of that link, so there is nothing else to
look up. The optional **Display Address** field overrides the city name shown in the title bar.

If your city doesn't use Recollect, the plugin won't find a schedule for your address.

### If you can't find the subscribe link

You can resolve an address to a place ID directly. `AreaName` is your city's Recollect area name —
spelling matters (`Durham` works, `DurhamRegion` doesn't), and you can usually read it off the
calendar page's embed:

```sh
curl 'https://api.recollect.net/api/areas/Sacramento/services/340/address-suggest?q=915+I+St&locale=en'
# => [{"place_id":"2D8DFBF4-…","service_id":340,"area_name":"Sacramento", …}]
```

Then assemble a Calendar URL by hand:
`https://api.recollect.net/api/places/<place_id>/services/<service_id>/events.en-US.ics`

## How it works

`polling_url` in [`src/settings.yml`](src/settings.yml) rewrites the pasted calendar link into the
JSON events endpoint, extracting both IDs with Liquid filters and requesting a 30-day window:

```
/api/places/{place_id}/services/{service_id}/events?nomerge=1&hide=reminder_only&after=…&before=…&locale=en
```

`after` starts a **day early** on purpose. It's rendered from the server's UTC clock, while
"today" on the display is the user's *local* date — so an evening poll in North America (where
UTC has already rolled over) would otherwise fetch a window starting tomorrow, and a pickup
that's still "today" for the user would never reach the transform. The transform drops anything
before the local date, so the extra day never shows stale events.

Two things worth knowing about the upstream API:

- **`client_id` is not required.** It's an ICS-only parameter; the JSON endpoint ignores it. It's
  harmless to leave in the pasted URL.
- **Use JSON, not `.ics`.** The `.ics` endpoint rate-limits aggressively (`429`); the JSON endpoint
  is what the plugin polls.

### Everything is computed once, in a transform

[`src/transform.js`](src/transform.js) is a serverless transform: it runs once per poll and its
return value becomes the template merge data. The four views are pure layout — they contain no
filtering, sorting, date math, or classification.

That buys two things:

- **A ~90% smaller payload.** The raw Recollect response is ~10 KB of mostly-unused flag metadata
  (colors, icon URIs, voice and HTML messages). The views receive ~1 KB.
- **A correct "days until pickup."** It used to be computed in Liquid as `(t2 - t1) / 86400`
  against `"now"` — the *server's* clock, in UTC. For a user in Sacramento (UTC-7) that rolls over
  at 5 PM local, so an evening glance at the display could read "Today" for a pickup that's
  actually tomorrow. The transform resolves the user's local calendar date from
  `trmnl.user.utc_offset` first, then subtracts whole UTC-midnights, so DST can't skew it either.

What the views get:

```jsonc
{
  "has_pickups": true,
  "area": "Durham",                  // from the API, used when Display Address is blank
  "today": "2026-07-24",             // the user's local date
  "next":     { "date": "2026-07-30", "long": "Thursday, July 30", "medium": "Thu, Jul 30",
                "short": "Jul 30", "days_until": 6,
                "types": [{ "label": "Blue Box", "icon": 1 }] },
  "upcoming": [ /* the next few collection days, same shape */ ],
  "holidays": [ /* dated, may shift collection */ ],
  "notices":  [ /* notification_with_date, e.g. street sweeping */ ]
}
```

`icon` is an index into the table at the top of [`src/shared.liquid`](src/shared.liquid), so a view
draws a bin with `{{ icons[type.icon] }}` and does no lookup work. If you reorder that table,
reorder `ICON_ORDER` in the transform to match — a unit test cross-checks the two and fails on
any mismatch, so you can't get it wrong silently.

### Collection types are detected, not hardcoded

Recollect's `flag.name` is **not** standardized across cities:

| | Sacramento, CA | Durham, ON |
|---|---|---|
| `flag.name` | `Garbage`, `Recycling`, `YardWaste` | `garbage`, `recycling`, `yardwaste`, `GreenBin` |
| `flag.subject` | `null` | `"Garbage"`, `"Blue Box"`, `"Green Bin"` |

So the transform classifies each type by downcased keyword substrings rather than exact names, and
resolves a label in three stages:
`flag.subject` → a label derived from `flag.name` → a neutral fallback.

That last part handles regional vocabulary. Canadian cities say "Green Bin" and "Blue Box"; US
cities say "Organics" and "Recycling" — whichever word the city itself used wins:

| `flag.name` (when `subject` is null) | Label | Icon |
|---|---|---|
| `GreenBin` / `GreenCart` | Green Bin / Green Cart | organics |
| `Organics`, `FoodScraps`, `Compost` | Organics | organics |
| `YardWaste`, `Leaves`, `GreenWaste` | Yard Waste | yard waste |
| `BlueBox` / `BlueBin` / `BlueCart` | Blue Box / Bin / Cart | recycling |
| `Recycling` | Recycling | recycling |
| `Garbage`, `Trash`, `SolidWaste`, `Refuse` | Garbage | garbage |
| anything else | the city's own name for it | recycling |

Note the ordering: `green waste` means *yard waste* in the US, so it's matched before `green` →
organics. That one collision is why the keyword chain is order-sensitive — first match wins.

To support another collection type, add a branch to `classify()` in the transform and an icon to
the table in `shared.liquid`. That chain is the single place that knows about types.

## Develop locally

Templates and settings live in [`src/`](src/), ready for
[trmnlp](https://github.com/usetrmnl/trmnlp):

```sh
gem install trmnl_preview
trmnlp serve
```

[`.trmnlp.yml`](.trmnlp.yml) is preloaded with a Sacramento address so the preview has real data.
Swap `calendar_url` for any Recollect city's link to test another municipality, and set
`variables.trmnl.user.utc_offset` to your own offset so the day math matches your timezone.

Views: `full`, `half_horizontal`, `half_vertical`, `quadrant`.

### Tests

The transform is covered by [`node --test`](test/transform.test.js) — no dependencies, and CI runs
it before linting or pushing:

```sh
node --test test/*.test.js
```

[`test/fixtures/`](test/fixtures/) holds verbatim API responses from Sacramento and Durham. They're
what keeps the classifier honest across the naming differences above, so prefer adding a fixture
from a new city over hand-writing a mock. You can capture one with:

```sh
curl -H 'user-agent: TRMNL-Recollect-Schedule/1.0' \
  'https://api.recollect.net/api/places/<place_id>/services/<service_id>/events?nomerge=1&hide=reminder_only&after=2026-07-24&before=2026-08-24&locale=en'
```

You can also run the transform standalone against any saved response, to see exactly what the
views would receive:

```sh
node test/run-transform.js test/fixtures/durham.json
node test/run-transform.js test/fixtures/durham.json -18000   # as a UTC-5 user
```

### Discoverability

Add the `trmnl` topic to this repo so other TRMNL plugin builders can find it.
