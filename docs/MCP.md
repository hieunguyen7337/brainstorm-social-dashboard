# Pulse MCP server

Pulse exposes a remote MCP server (Streamable HTTP, stateless) at `https://<host>/mcp`.
Auth is your workspace token, copied from the app's **Settings** screen. Send it as
`Authorization: Bearer <token>` or, for clients that cannot set headers, as `?token=<token>`.

Tools: `get_dashboard`, `list_posts`, `create_post`, `publish_post`, `generate_posts`, `list_trends`,
`list_themes`, `get_ai_usage`, `set_autopilot`, `run_autopilot`, `set_profile_url`, `record_metrics`,
`harvest_status`, `harvest_instructions`.

## Claude Code
```
claude mcp add --transport http pulse https://<host>/mcp --header "Authorization: Bearer <token>"
```

## Claude Desktop
Edit `claude_desktop_config.json` (uses the `mcp-remote` bridge):
```json
{
  "mcpServers": {
    "pulse": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<host>/mcp", "--header", "Authorization: Bearer <token>"]
    }
  }
}
```

## claude.ai custom connector
Settings -> Connectors -> Add custom connector, URL: `https://<host>/mcp?token=<token>`
(the custom connector form has no header field, so the token goes in the query string).

## Try it
"Show my Pulse dashboard for the last 7 days, then draft a LinkedIn and X post about the top trend."
