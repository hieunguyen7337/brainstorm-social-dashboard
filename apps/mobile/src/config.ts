/** Build-time app configuration. Spell env vars out literally so Metro can inline them. */
export const APP_NAME: string = process.env.EXPO_PUBLIC_APP_NAME || 'Pulse';

/** How often live screens re-fetch while focused. */
export const POLL_MS = 5000;

/** Max width of the centred content column on tablets and desktop browsers. */
export const MAX_CONTENT_WIDTH = 720;
