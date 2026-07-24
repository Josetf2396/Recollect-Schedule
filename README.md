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

Two things worth knowing about the upstream API:

- **`client_id` is not required.** It's an ICS-only parameter; the JSON endpoint ignores it. It's
  harmless to leave in the pasted URL.
- **Use JSON, not `.ics`.** The `.ics` endpoint rate-limits aggressively (`429`); the JSON endpoint
  is what the plugin polls.

### Collection types are detected, not hardcoded

Recollect's `flag.name` is **not** standardized across cities:

| | Sacramento, CA | Durham, ON |
|---|---|---|
| `flag.name` | `Garbage`, `Recycling`, `YardWaste` | `garbage`, `recycling`, `yardwaste`, `GreenBin` |
| `flag.subject` | `null` | `"Garbage"`, `"Blue Box"`, `"Green Bin"` |

So [`src/shared.liquid`](src/shared.liquid) classifies each type by downcased keyword substrings
rather than exact names, and resolves a label in three stages:
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

To support another collection type, add a branch to that chain. It's the single place that
knows about types; all four views call into it with the same four-line resolve block.

## Develop locally

Templates and settings live in [`src/`](src/), ready for
[trmnlp](https://github.com/usetrmnl/trmnlp):

```sh
gem install trmnl_preview
trmnlp serve
```

[`.trmnlp.yml`](.trmnlp.yml) is preloaded with a Sacramento address so the preview has real data.
Swap `calendar_url` for any Recollect city's link to test another municipality.

Views: `full`, `half_horizontal`, `half_vertical`, `quadrant`.

### Discoverability

Add the `trmnl` topic to this repo so other TRMNL plugin builders can find it.
