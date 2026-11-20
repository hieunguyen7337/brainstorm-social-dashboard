# tools/harvest

Reads **your own** LinkedIn and Instagram numbers from **your own logged-in Chrome** and sends them to your
Pulse workspace (`POST /api/metrics/ingest`). The plain-language guide is [docs/HARVEST.md](../../docs/HARVEST.md);
this page is the exact reference.

## What it does and does not do

- Own account only, in a Chrome you started and logged in to yourself. It never asks for, types or stores a
  password, and never reads or writes a credential file. The workspace token only goes into the
  `Authorization` header and is never printed.
- Read-only. It never posts, likes, comments, follows or messages.
- Human pace: 1-2 seconds between page actions, at most **30 LinkedIn posts** and **12 Instagram posts** per run
  (`--max-posts` can only lower that).
- Not a crawler: it opens only your profile and your latest posts.

## Setup

```
pip install -r requirements.txt
```

There is no `playwright install` step: the script attaches to your own Chrome, it does not download a browser.
Python 3.11+ (the project uses 3.13).

### 1. Start Chrome with a separate profile folder

Current Chrome ignores the debugging port for its default profile, so start a Chrome that has its own folder.
Your normal Chrome stays as it is.

- Windows:
  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\pulse-chrome"
  ```
- macOS:
  ```
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/pulse-chrome"
  ```
- Linux:
  ```
  google-chrome --remote-debugging-port=9222 --user-data-dir=$HOME/pulse-chrome
  ```

### 2. Log in once, in that window

Log in to LinkedIn and Instagram yourself. The folder remembers it. Leave the window open.

### 3. Run it

Look first with `--dry-run`: it reads the pages and prints the JSON it would send, and calls **no** API at all
(not even the profile save).

- Windows:
  ```
  py tools\harvest\harvest.py --api https://<host> --token <token> --platform all --profile-url https://www.linkedin.com/in/<you>/ --profile-url https://www.instagram.com/<you>/ --dry-run
  ```
- macOS / Linux:
  ```
  python3 tools/harvest/harvest.py --api https://<host> --token <token> --platform all \
    --profile-url https://www.linkedin.com/in/<you>/ --profile-url https://www.instagram.com/<you>/ --dry-run
  ```

If the numbers look right, run the same command without `--dry-run`. Output looks like
`linkedin: matched 7, created 3, snapshots 11`.

## Options

| Option | Meaning |
| --- | --- |
| `--api` | Pulse API base URL. Default: `$PULSE_API`, else `http://localhost:8000`. |
| `--token` | Workspace token. Default: `$PULSE_TOKEN`. Not needed with `--dry-run`. |
| `--platform` | `linkedin`, `instagram` or `all` (default). With `all`, every platform you gave a URL for runs and the rest are skipped with a note. |
| `--profile-url` | Your own profile URL. Repeat it for both platforms. The platform comes from the host (`linkedin.com` / `instagram.com`, or a subdomain of them). Any other host is an error. |
| `--cdp` | Chrome's debugging address. Default `http://127.0.0.1:9222`. |
| `--dry-run` | Print the body (pretty JSON on stdout) and send nothing. |
| `--from-json FILE` | Use a saved payload instead of opening Chrome (see below). |
| `--max-posts N` | Posts to read per platform. Default and maximum: 30 LinkedIn, 12 Instagram. |

For each platform the script saves the profile URL (`PUT /api/connections/{platform}/profile`), reads the numbers,
then sends them (`POST /api/metrics/ingest` with `"source": "script"`). The body is checked locally first:
counts must be whole numbers of 0 or more, at most 500 posts, unknown keys are dropped. Progress goes to
stderr; results and `--dry-run` JSON go to stdout. If a run reads several platforms, `--dry-run` prints one JSON
body after the other.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Everything succeeded. |
| `2` | A platform was logged out. It prints `log in in that Chrome window, then rerun` and names the platform. The other platforms are still processed first. Used whenever any platform needed a login, even if something else also failed. |
| `1` | Any other failure: cannot reach Chrome (it prints the start commands above), cannot reach the API, an API error (shown as `{status}: {detail}`), a page the reader could not understand, bad arguments or a bad file. |

## `--from-json`

Skips the browser (no Chrome is opened) and sends a saved payload. The file is either one payload, used for the
single selected platform:

```json
{
  "account": { "followers": 3140, "views": 18250, "engagements": 904 },
  "posts": [
    {
      "external_id": "7123456789012345678",
      "url": "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
      "content": "We just launched our new dashboard ...",
      "posted_at": "2026-11-18T09:30:00Z",
      "views": 4210,
      "engagements": 188
    }
  ]
}
```

or one payload per platform:

```json
{
  "linkedin":  { "account": { "followers": 3140 }, "posts": [] },
  "instagram": { "account": { "followers": 980 },  "posts": [] }
}
```

Account keys: `followers`, `views`, `engagements`, `clicks`, `profile_views`. Post keys: `external_id`, `url`,
`content`, `posted_at`, `views`, `engagements`, `clicks`, `conversions`. All numbers are plain integers.

## Tests

No network, no browser, no Playwright needed:

```
python -m pytest -q tools/harvest
```

## Layout

```
tools/harvest/
  harvest.py        the CLI (this page)
  common.py         shared helpers: parse_count, html_to_text, pacing, LoginRequired / HarvestError
  linkedin.py       LinkedIn reader: harvest(context, profile_url, ...) plus pure parsers
  instagram.py      Instagram reader: same shape
  fixtures/         saved page HTML the parser tests run against
  test_*.py         tests
  requirements.txt  playwright>=1.49
```

## When the page changes

LinkedIn and Instagram change their pages now and then. The parsers are pure functions over saved HTML, so the
fix is routine: save the page's HTML into `fixtures/`, add a test that shows the number the parser should find,
then fix the parser until it passes. Nothing else has to change.

## Fallback

If the script fails or a page keeps defeating it, use Claude in Chrome through the Pulse MCP tools instead. It
reads the page like a person would. See [docs/HARVEST.md](../../docs/HARVEST.md) (Path A) and
[docs/MCP.md](../../docs/MCP.md).
