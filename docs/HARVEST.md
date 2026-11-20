# Bring your real LinkedIn and Instagram numbers into Pulse

## What this does

Pulse starts with simulated numbers so the dashboard is never empty. This guide swaps the simulated
LinkedIn and Instagram numbers for your real ones.

It is gentle and safe:

- It reads **only your own account**, in **your own logged-in browser**.
- It moves at a human pace. It waits 1-2 seconds between pages.
- It reads at most **30 posts on LinkedIn** and **12 on Instagram**.
- It never posts, likes, comments, follows or messages anyone.
- It never sees your password. You log in yourself, in your own browser.

Once your real numbers are in, each post you harvested shows its real views and engagement in the dashboard
(your follower count is real too). Posts Pulse has not read from your account keep their simulated numbers.

## Before you start

You need three things:

1. **Your Pulse workspace token.** Open Pulse, go to **Settings**, and copy the token.
2. **The link to your own LinkedIn page.** For example `https://www.linkedin.com/in/your-name/`.
3. **The link to your own Instagram page.** For example `https://www.instagram.com/your-name/`.

Then pick a path. Path A is the quick way. Path B is a script you run on your computer. You only need one.

## Path A: the quick way (ask Claude in Chrome)

Claude in Chrome is a browser extension. It can read pages in your own Chrome, while you are logged in.

1. Install the **Claude in Chrome** extension and sign in to it.
2. Make sure you are logged in to LinkedIn and Instagram in that same Chrome.
3. Add Pulse to Claude as a connector. Choose the one that matches how you use Claude:
   - **Claude Code**: run this in your terminal (swap in your host and token):
     ```
     claude mcp add --transport http pulse https://<host>/mcp --header "Authorization: Bearer <token>"
     ```
   - **claude.ai**: go to Settings, then Connectors, then **Add custom connector**. Use this URL
     (swap in your host and token):
     ```
     https://<host>/mcp?token=<token>
     ```
     More detail is in [MCP.md](MCP.md).
4. Paste this prompt into Claude, once for each platform:

   > Use Pulse's harvest_instructions tool for LinkedIn and follow it in this browser.

   > Use Pulse's harvest_instructions tool for Instagram and follow it in this browser.

5. If a login page shows up, Claude will stop and ask you to log in yourself. Do that, then tell it to carry on.
6. When it finishes, Claude tells you how many posts it matched, how many are new, and which numbers it
   could not read. It never guesses a number.

## Path B: the script (tools/harvest)

The script does the same job without Claude. It drives a separate Chrome window on your computer.

### Step 1: install Python and the script's helpers

Install Python 3.11 or newer from [python.org](https://www.python.org/downloads/). Then run this once.

- **Windows** (Command Prompt or PowerShell, in the Pulse folder):
  ```
  py -m pip install -r tools\harvest\requirements.txt
  ```
- **macOS** (Terminal, in the Pulse folder):
  ```
  python3 -m pip install -r tools/harvest/requirements.txt
  ```

### Step 2: open a separate Chrome window

The script needs a Chrome window it can drive. This opens a **new** Chrome window with its own folder.
Close nothing: your normal Chrome stays as it is. Recent versions of Chrome need that separate folder,
so please keep the `--user-data-dir` part.

- **Windows**:
  ```
  "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\pulse-chrome"
  ```
- **macOS**:
  ```
  /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="$HOME/pulse-chrome"
  ```

In **that new window**, log in to LinkedIn and to Instagram. You only need to do this once. Leave the
window open.

### Step 3: run the script

Have a look first, without sending anything to Pulse. Add `--dry-run`:

- **Windows**:
  ```
  py tools\harvest\harvest.py --api https://<host> --token <token> --platform all --profile-url https://www.linkedin.com/in/<you>/ --profile-url https://www.instagram.com/<you>/ --dry-run
  ```
- **macOS**:
  ```
  python3 tools/harvest/harvest.py \
    --api https://<host> \
    --token <token> \
    --platform all \
    --profile-url https://www.linkedin.com/in/<you>/ \
    --profile-url https://www.instagram.com/<you>/ \
    --dry-run
  ```

If the numbers look right, run the same command again **without** `--dry-run`.

Good to know:

- If the script stops with exit code 2 or says **"log in in that Chrome window, then rerun"**, log in to
  the site in the new Chrome window and run it again.
- Already saved a harvest to a file? Load it with `--from-json file`. For example
  `--from-json my-harvest.json`.

## How to check it worked

- **Dashboard**: the posts that were read from LinkedIn and Instagram now show their real numbers, and the
  follower counts match your accounts.
- **Activity feed**: you will see a line that starts with **"Harvested ..."**.
- **Ask Claude** (if you added Pulse in Path A): "Run Pulse's harvest_status tool". It lists each
  platform, its profile link, when it was last harvested, and how many real posts Pulse holds.

## If something fails

- **The script fails?** Use Path A instead. It is the fallback.
- **Claude in Chrome gets stuck?** Use Path B instead.
- **The numbers look empty after a LinkedIn or Instagram update?** Both sites change their pages
  now and then, and that can break the script's page-reading. Path A copes better, because Claude reads
  the page the way a person would. It is worth trying that first.
- **A login page keeps showing?** Log in yourself in that same browser window, then run it again.

## Privacy and good manners

- Use this on **your own account only**.
- Check the terms of LinkedIn and Instagram, and make sure you are comfortable with them.
- Run it a few times a day at most. Real numbers do not change by the minute.
- Your password is never typed by Claude or the script. Your token is the only secret involved, so keep it to yourself.

## For developers

Four endpoints carry the data. All use `Authorization: Bearer <token>`.

- `PUT /api/connections/{platform}/profile` with `{"profile_url": "..."}` saves the profile link.
- `POST /api/metrics/ingest` records real numbers (up to 500 posts per call).
- `GET /api/metrics/snapshots` reads back the saved snapshots.
- `GET /api/connections/harvest-status` shows, per platform, the profile link, last harvest time and source,
  followers, real post count and snapshot count.

The MCP tools `set_profile_url`, `record_metrics`, `harvest_status` and `harvest_instructions` wrap these
(`record_metrics` always sends `"source": "claude_chrome"`; the script sends `"script"`). A sample ingest body:

```json
{
  "platform": "linkedin",
  "source": "script",
  "account": { "followers": 3140, "views": 18250, "engagements": 904 },
  "posts": [
    {
      "external_id": "7123456789012345678",
      "url": "https://www.linkedin.com/feed/update/urn:li:activity:7123456789012345678/",
      "content": "We just launched our new dashboard ...",
      "posted_at": "2026-11-18T09:30:00Z",
      "views": 4210,
      "engagements": 188
    },
    {
      "external_id": "7119876543210987654",
      "url": "https://www.linkedin.com/feed/update/urn:li:activity:7119876543210987654/",
      "content": "Three lessons from our first 100 customers ...",
      "views": 2890,
      "engagements": 121
    }
  ]
}
```

It replies with `{platform, source, matched, created, snapshots, captured_at}`. All numbers are plain
integers (`1.2K` becomes `1200`). `source` is one of `script`, `claude_chrome` or `manual`. `external_id` is
the post's id from its address: for LinkedIn the digits after `urn:li:activity:`, for Instagram the code in
`/p/<code>/` or `/reel/<code>/`.
