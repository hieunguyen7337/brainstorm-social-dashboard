import fs from 'node:fs';

export interface DesktopMcpInfo {
  url: string;
  token: string;
}

let desktopMcp: DesktopMcpInfo | null = null;

/** Unit D4 calls this once its local MCP server listens (null when it stops). */
export function setDesktopMcp(info: DesktopMcpInfo | null): void {
  desktopMcp = info;
}

export function getDesktopMcp(): DesktopMcpInfo | null {
  return desktopMcp;
}

type HttpServer = { type: 'http'; url: string; headers: { Authorization: string } };

export function buildMcpConfig(
  apiUrl: string,
  token: string | null,
  desktop: DesktopMcpInfo | null,
): { mcpServers: Record<string, HttpServer> } {
  const mcpServers: Record<string, HttpServer> = {};
  if (token) {
    mcpServers.pulse = { type: 'http', url: `${apiUrl}/mcp`, headers: { Authorization: `Bearer ${token}` } };
  }
  if (desktop) {
    mcpServers.pulse_desktop = {
      type: 'http',
      url: desktop.url,
      headers: { Authorization: `Bearer ${desktop.token}` },
    };
  }
  return { mcpServers };
}

/** Writes the config with mode 0600 (also when the file already existed). */
export function writeMcpConfig(
  file: string,
  apiUrl: string,
  token: string | null,
  desktop: DesktopMcpInfo | null = desktopMcp,
): string {
  fs.writeFileSync(file, JSON.stringify(buildMcpConfig(apiUrl, token, desktop)), { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export function removeMcpConfig(file: string): void {
  fs.rmSync(file, { force: true });
}
