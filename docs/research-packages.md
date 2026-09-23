# Research packages

A `.twig` file is a UTF-8 JSON document. It contains the selected reading
order and annotations, so another Twig installation can import it without
access to the sender's profile. Markdown and HTML exports are readable
documents; only `.twig` files support round-trip import.

## Version 1

```json
{
  "format": "twig-research",
  "version": 1,
  "title": "Choosing a database",
  "description": "Read the overview, then compare the deployment constraints.",
  "createdAt": 1772323200000,
  "pages": [
    {
      "url": "https://www.sqlite.org/whentouse.html",
      "title": "Appropriate Uses For SQLite",
      "note": "Consider this for a local application.",
      "excerpts": ["A passage explicitly selected or added by the author."],
      "capturedAt": 1772323200000
    }
  ],
  "sourceCheckpoint": null
}
```

Every field is required. `sourceCheckpoint` is either `null` or an object
with `name` and `createdAt`. Checkpoint identifiers and ancestry are not
exported. Unknown fields and unsupported versions are rejected, rather
than silently discarded. Dates are nonnegative Unix milliseconds, within
JavaScript's valid date range. Capture dates describe when sources were
collected into the package (or saved in its source checkpoint), not when
their website content was published.

## Bounds and addresses

| Field | Limit |
| --- | --- |
| File / normalized package | 2 MiB |
| Pages | 1–200, in reading order |
| Package title / checkpoint name | 1–120 characters |
| Description / page note | 4,000 characters |
| Page title | 500 characters |
| Page URL | 8,192 bytes |
| Excerpts per page | 20 |
| Each excerpt | 8,000 characters |

Addresses must use HTTP or HTTPS and cannot contain embedded usernames or
passwords. The importer normalizes URLs. Local files, inline data, script
URLs, and unknown protocols are rejected. Ordinary query strings and
fragments are retained; the export preview displays full addresses for
the author to review. Text fields cannot contain control characters other
than tabs and newlines.

## Workflow and storage

1. Open Research Packages, use the current space, or start from a checkpoint.
2. Choose the pages, reading order, notes, and excerpts. A selected passage
   can be collected from the active page; editable form selections are skipped.
3. Preview the selected content. Checkpoint provenance is optional.
4. Save locally, export to Downloads, or open the package in a new space.

Importing a file validates and previews it without opening its links. The
user's explicit **Open in a new space** action saves the package in the
local library and creates separate tabs. The first page becomes active;
other pages stay hibernated. Existing spaces remain intact. Notes and
excerpts remain in the package library and can be edited or exported again;
they are not injected into the original websites.

The local library is `research-packages.json` in Twig's app data directory,
separate from portable files. It supports up to 200 packages and 32 MiB,
uses atomic replacement, and preserves a damaged file rather than silently
overwriting it. Removing a package from the library does not close tabs or
delete files already exported. All native package commands reject private
windows.

Exports use unique filenames in Downloads. HTML contains escaped text,
source links, inline styles, and a restrictive content security policy;
it includes no scripts, remote images, fonts, or tracking. Markdown escapes
author text and link destinations. Neither format contains authentication
state, browser identifiers, or unselected pages.
