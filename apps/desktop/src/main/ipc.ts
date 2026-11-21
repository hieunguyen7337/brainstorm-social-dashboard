import type { AppContext } from './context';
import { registerSocial } from './social';
import { registerClaude } from './claude';
import { registerMcp } from './mcp';

export function registerIpc(ctx: AppContext): void {
  // IPC.setToken is registered by createContext (the token lives in the context).
  registerSocial(ctx);
  registerClaude(ctx);
  registerMcp(ctx);
}
