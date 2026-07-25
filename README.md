# Recollect Schedule

A [TRMNL](https://trmnl.com) plugin showing your next waste collection — garbage, recycling,
organics, yard waste — for any city on [Recollect](https://recollect.net). Location, services and
labels all come from the API; nothing is city-specific.

Synced via [GitHub Sync](https://help.trmnl.com/en/articles/15977899-github-sync).

## Setup

Paste your city's **Subscribe** / **Add to calendar** link into the plugin's Calendar URL field:

```
https://api.recollect.net/api/places/EE0C3310-C0C3-11E6-8A10-F4110BA3B673/services/340/events.en-US.ics?client_id=…
```

Place and service IDs are parsed from it. Display Address optionally overrides the title-bar city.

No subscribe link? Look up the IDs — the area name is spelling-sensitive (`Durham`, not
`DurhamRegion`):

```sh
curl 'https://api.recollect.net/api/areas/Sacramento/services/340/address-suggest?q=915+I+St&locale=en'
```

## How it works

[`settings.yml`](src/settings.yml) rewrites the pasted link into the JSON events endpoint:

- Window starts a day early — `after` uses the server's UTC clock, which would otherwise skip a
  pickup that's still "today" for evening users in North America.
- Window runs 120 days, so seasonal services appear at all (Nashville brush: ~3×/year).
- `client_id` is ICS-only. The plugin polls JSON; `.ics` rate-limits hard.

[`transform.js`](src/transform.js) runs once per poll and returns the template merge data, leaving
the views as pure layout. ~10 KB of API response becomes ~1.5 KB, and `days_until` is measured
against the user's local date (`trmnl.user.utc_offset`), not the server's UTC clock.

```jsonc
{
  "has_pickups": true,
  "area": "Durham",          // used when Display Address is blank
  "today": "2026-07-24",     // user's local date
  "next":     { "date": "2026-07-30", "long": "Thursday, July 30", "medium": "Thu, Jul 30",
                "short": "Jul 30", "days_until": 6,
                "types": [{ "label": "Blue Box", "icon": 1 }] },
  "upcoming": [ /* later collection days, same shape */ ],
  "schedule": [ /* each service at its next date; in_next marks bins already drawn */ ],
  "holidays": [ /* may shift collection */ ],
  "notices":  [ /* e.g. street sweeping */ ]
}
```

`schedule` is what surfaces rare services like brush or bulk pickup. `icon` indexes the table in
[`shared.liquid`](src/shared.liquid); a test cross-checks it against `ICON_ORDER`.

### Type detection

`flag.name` varies by city (`YardWaste` vs `yardwaste`, `subject` often null), so types are matched
by keyword substring. Labels resolve `flag.subject` → derived from `flag.name` → fallback, keeping
each city's own vocabulary:

| `flag.name` | Label | Icon |
|---|---|---|
| `GreenBin` / `GreenCart` | Green Bin / Green Cart | organics |
| `Organics`, `FoodScraps`, `Compost` | Organics | organics |
| `YardWaste`, `Leaves`, `Brush`, `Limbs` | Yard Waste / Brush / Branches | yard waste |
| `BlueBox` / `BlueBin` / `BlueCart` | Blue Box / Bin / Cart | recycling |
| `recycling_glass`, `Batteries` | Glass / Batteries | recycling |
| `Recycling` | Recycling | recycling |
| `Garbage`, `Trash`, `SolidWaste`, `Refuse` | Garbage | garbage |
| anything else | the city's own name | garbage bag |

Order matters: `green waste` (US yard waste) before `green` (organics), and `glass` before generic
recycling — Portland's `recycling_glass` would otherwise dedupe into Recycling and vanish.

To add a type: a branch in `classify()`, an icon in `shared.liquid`.

## Develop

```sh
gem install trmnl_preview
trmnlp serve                  # views: full, half_horizontal, half_vertical, quadrant
node --test test/*.test.js
```

In [`.trmnlp.yml`](.trmnlp.yml), swap `calendar_url` to preview another city and set
`variables.trmnl.user.utc_offset` to your own offset.

[`test/fixtures/`](test/fixtures/) holds real API responses from Sacramento, Durham, Nashville and
Portland — capture a new city rather than writing a mock:

```sh
curl -H 'user-agent: TRMNL-Recollect-Schedule/1.0' \
  'https://api.recollect.net/api/places/<place_id>/services/<service_id>/events?nomerge=1&hide=reminder_only&after=2026-07-24&before=2026-11-24&locale=en'

node test/run-transform.js test/fixtures/durham.json -18000   # what the views receive, as UTC-5
```
