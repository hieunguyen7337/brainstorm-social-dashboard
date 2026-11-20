/** The connect sheet's context and hook. Kept apart from the sheet itself so `ConnectAccounts` can use it without an import cycle. */
import { createContext, useContext } from 'react';

import type { Platform } from '@/src/types';

export interface ConnectSheetApi {
  /** Open the sheet, optionally straight into one platform's panel. */
  open: (platform?: Platform | null) => void;
  close: () => void;
  isOpen: boolean;
  /** Bumps after every successful save: put it in a loader's deps to refetch right away instead of at the next poll. */
  version: number;
  /** `ConnectAccounts` calls this after a save, wherever it is shown (sheet, onboarding, Settings). */
  markSaved: () => void;
}

const NOOP: ConnectSheetApi = { open: () => undefined, close: () => undefined, isOpen: false, version: 0, markSaved: () => undefined };

export const ConnectSheetContext = createContext<ConnectSheetApi>(NOOP);

export function useConnectSheet(): ConnectSheetApi {
  return useContext(ConnectSheetContext);
}
