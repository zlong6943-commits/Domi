import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const APP_NAME = "Domi";
export const STORE_NAME = "pawpal";
export const RELEASES_API_URL = "https://api.github.com/repos/zlong6943-commits/Domi/releases/latest";
export const RELEASES_URL = "https://github.com/zlong6943-commits/Domi/releases";

export const PET_WINDOW = {
  width: 220,
  height: 340
} as const;

export const BALL_WINDOW = {
  width: 54,
  height: 54
} as const;

export const SETTINGS_WINDOW = {
  width: 760,
  height: 680
} as const;

export const PRELOAD_PATH = join(__dirname, "../preload/index.cjs");
export const RENDERER_HTML_PATH = join(__dirname, "../renderer/index.html");
export const IS_DEV = Boolean(process.env.ELECTRON_RENDERER_URL);

export const DISTRACTION_CHECK_INTERVAL_MS = 3000;
export const DISTRACTION_WARNING_COOLDOWN_MS = 60_000;
export const BREAK_RUN_TICK_MS = 16;
export const AMBIENT_TICK_MS = 1000;
export const STRETCH_INTERVAL_MS = 10 * 60 * 1000;
