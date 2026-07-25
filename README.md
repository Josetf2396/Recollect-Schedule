# Recollect Schedule

A [TRMNL](https://trmnl.com) plugin that shows your next waste collection — garbage, recycling,
organics, yard waste — for any city served by [Recollect](https://recollect.net). Nothing is
city-specific: location, services, labels, and the title-bar city name all come from the API.

Connected by [GitHub Sync](https://help.trmnl.com/en/articles/15977899-github-sync): every save in
TRMNL lands here as a commit.

## Setup

1. Look up your address on your city's collection calendar page.
2. Copy the **Subscribe** / **Add to calendar** URL:
   ```
   https://api.recollect.net/api/places/EE0C3310-C0C3-11E6-8A10-F4110BA3B673/services/340/events.en-US.ics?client_id=…
   ```
3. Paste it into the plugin's Calendar URL field.

Place and service IDs are parsed from the link. The optional Display Address field overrides the
title-bar city name. If your city doesn't use Recollect, no schedule will be found.

No subscribe link? Resolve your address directly (the area name is spelling-sensitive: `Durham`
works, `DurhamRegion` doesn't):

```sh
curl 'https://api.recollect.net/api/areas/Sacramento/services/340/address-suggest?q=915+I+St&locale=en'
# => [{"place_id":"2D8DFBF4-…","service_id":340,"area_name":"Sacramento", …}]
```

Then build the URL: `https://api.recollect.net/api/places/<place_id>/services/<service_id>/events.en-US.ics`

## How it works

`polling_url` in [`src/settings.yml`](src/settings.yml) rewrites the pasted link into the JSON
events endpoint:

```
/api/places/{place_id}/services/{service_id}/events?nomerge=1&hide=reminder_only&after=…&before=…&locale=en
```

- The window starts a day early: `after` uses the server's UTC clock, so an evening poll in North
  America would otherwise miss a pickup that's still "today" locally.
- It extends 120 days out so seasonal services show up at all — Nashville's brush pickup runs
  about three times a year.
- `client_id` is ICS-only; the JSON endpoint ignores it.
- The plugin polls JSON. The `.ics` endpoint rate-limits hard.

[`src/transform.js`](src/transform.js) runs once per poll and its return value becomes the
template merge data, so the views are pure layout. The ~10 KB API response shrinks to ~1.5 KB,
and "days until pickup" is computed against the user's local date (from `trmnl.user.utc_offset`),
not the server's UTC clock.

```jsonc
{
  "has_pickups": true,
  "area": "Durham",              // used when Display Address is blank
  "today": "2026-07-24",         // the user's local date
  "next":     { "date": "2026-07-30", "long": "Thursday, July 30", "medium": "Thu, Jul 30",
                "short": "Jul 30", "days_until": 6,
                "types": [{ "label": "Blue Box", "icon": 1 }] },
  "upcoming": [ /* next few collection days, same shape */ ],
  "schedule": [ /* every service in the window, at its next date */ ],
  "holidays": [ /* dated, may shift collection */ ],
  "notices":  [ /* e.g. street sweeping */ ]
}
```

`schedule` has one entry per distinct service, soonest first, so rare services (brush, street
sweeping, bulk) still surface; `in_next` marks the ones already drawn as bins. `icon` indexes the
table in [`src/shared.liquid`](src/shared.liquid) — a test cross-checks it against `ICON_ORDER`,
so keep the two in the same order.

### Type detection

`flag.name` isn't standardized across cities:

| | Sacramento, CA | Durham, ON |
|---|---|---|
| `flag.name` | `Garbage`, `Recycling`, `YardWaste` | `garbage`, `recycling`, `yardwaste`, `GreenBin` |
| `flag.subject` | `null` | `"Garbage"`, `"Blue Box"`, `"Green Bin"` |

The transform classifies by keyword substring and resolves labels in three stages —
`flag.subject`, then a label derived from `flag.name`, then a fallback — so the city's own
vocabulary wins (Blue Box vs Recycling, Green Bin vs Organics):

| `flag.name` (when `subject` is null) | Label | Icon |
|---|---|---|
| `GreenBin` / `GreenCart` | Green Bin / Green Cart | organics |
| `Organics`, `FoodScraps`, `Compost` | Organics | organics |
| `YardWaste`, `Leaves`, `GreenWaste`, `Brush`, `Limbs` | Yard Waste / Brush / Branches | yard waste |
| `BlueBox` / `BlueBin` / `BlueCart` | Blue Box / Bin / Cart | recycling |
| `recycling_glass`, `Batteries` | Glass / Batteries | recycling |
| `Recycling` | Recycling | recycling |
| `Garbage`, `Trash`, `SolidWaste`, `Refuse` | Garbage | garbage |
| anything else | the city's own name | garbage bag |

Match order matters: `green waste` (US yard waste) is tested before `green` (organics), and
`glass` before generic recycling — Portland's `recycling_glass` would otherwise dedupe into the
Recycling bin and vanish. Unknown types keep the city's name and get the garbage-bag icon.

To add a type: a branch in `classify()` and an icon in `shared.liquid`.

## Develop locally

```sh
gem install trmnl_preview
trmnlp serve
```

[`.trmnlp.yml`](.trmnlp.yml) ships with a Sacramento address; swap `calendar_url` to test another
city, and set `variables.trmnl.user.utc_offset` to your offset so the day math matches your
timezone. Views: `full`, `half_horizontal`, `half_vertical`, `quadrant`.

### Tests

```sh
node --test test/*.test.js
```

[`test/fixtures/`](test/fixtures/) holds verbatim API responses from Sacramento, Durham,
Nashville, and Portland. Prefer capturing a new city over writing a mock:

```sh
curl -H 'user-agent: TRMNL-Recollect-Schedule/1.0' \
  'https://api.recollect.net/api/places/<place_id>/services/<service_id>/events?nomerge=1&hide=reminder_only&after=2026-07-24&before=2026-11-24&locale=en'
```

Run the transform against any saved response to see what the views receive:

```sh
node test/run-transform.js test/fixtures/durham.json -18000   # as a UTC-5 user
```

### Discoverability

Add the `trmnl` topic to this repo so other TRMNL plugin builders can find it.
