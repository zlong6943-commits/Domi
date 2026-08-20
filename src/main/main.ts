import { spawn, type ChildProcess } from "node:child_process";
import { basename, extname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { copyFile, mkdir } from "node:fs/promises";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  net,
  protocol,
  screen,
  shell,
  Tray
} from "electron";
import Store from "electron-store";
import {
  createEmptyStats,
  DEFAULT_SETTINGS
} from "../shared/constants";
import { i18n, pick } from "../shared/i18n";
import { PET_STATE_ORDER } from "../shared/petAppearances";
import type {
  AppSnapshot,
  BlockingMode,
  CustomPetAsset,
  DistractionStatus,
  DemoTrigger,
  PetFacing,
  PetState,
  Settings,
  StatsHistory,
  SpeechBubble,
  TodayStats,
  UpdateCheckResult
} from "../shared/types";
import {
  APP_NAME,
  AMBIENT_TICK_MS,
  BALL_WINDOW,
  BREAK_RUN_TICK_MS,
  DISTRACTION_CHECK_INTERVAL_MS,
  DISTRACTION_WARNING_COOLDOWN_MS,
  IS_DEV,
  PET_WINDOW,
  PRELOAD_PATH,
  RELEASES_URL,
  RENDERER_HTML_PATH,
  SETTINGS_WINDOW,
  STRETCH_INTERVAL_MS,
  STORE_NAME
} from "./config";
import {
  initialWindowBounds,
  savedPositionFromBounds,
  visibleWindowBounds
} from "./displayPosition";
import type { DisplayBounds, SavedWindowPosition } from "./displayPosition";
import { classifyDistraction, isPermissionError, readActiveWindow } from "./distraction";
import { applyLaunchAtLoginPreference, getLaunchAtLoginState } from "./loginItem";
import { clamp, easeInOut, recordSamePlaceClick } from "./petPlay";
import type { ScreenPoint, TimedClick } from "./petPlay";
import {
  buildApplicationMenuTemplate,
  buildPetContextMenuTemplate,
  buildTrayMenuTemplate
} from "./menus";
import { createTrayImage } from "./trayIcon";
import { getStoredSettings, normalizeSettings } from "./settingsStore";
import {
  getCurrentStats,
  getStatsHistory,
  resetCurrentStats,
  updateCurrentStats
} from "./statsStore";
import {
  checkGitHubReleasesForUpdates,
  createCheckingUpdateCheck,
  createInitialUpdateCheck
} from "./updates";

type StoreSchema = {
  settings: Settings;
  stats: TodayStats;
  statsHistory: StatsHistory;
  petPosition?: SavedWindowPosition;
  petHiddenByUser?: boolean;
};

type PetPosition = {
  x: number;
  y: number;
};

type AmbientMode = "roaming" | "stretching" | "ball" | null;

app.setName(APP_NAME);

const store = new Store<StoreSchema>({
  name: STORE_NAME,
  defaults: {
    settings: DEFAULT_SETTINGS,
    stats: createEmptyStats(),
    statsHistory: {}
  }
});

let petWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let ballWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let petState: PetState = "idle";
let petFacing: PetFacing = "right";
let blockingMode: BlockingMode = null;
let focusActive = false;
let focusStartedAt: number | null = null;
let breakRunTimer: NodeJS.Timeout | null = null;
let breakRunCountdownTimer: NodeJS.Timeout | null = null;
let breakRunMovementTimer: NodeJS.Timeout | null = null;
let breakTimer: NodeJS.Timeout | null = null;
let hydrationTimer: NodeJS.Timeout | null = null;
let focusTimer: NodeJS.Timeout | null = null;
let distractionTimer: NodeJS.Timeout | null = null;
let distractionStartupTimer: NodeJS.Timeout | null = null;
let displayChangeTimer: NodeJS.Timeout | null = null;
let breakDueAt: number | null = null;
let hydrationDueAt: number | null = null;
let focusEndsAt: number | null = null;
let bubbleTimer: NodeJS.Timeout | null = null;
let dragTimer: NodeJS.Timeout | null = null;
let dragSafetyTimer: NodeJS.Timeout | null = null;
let cursorMotionTimer: NodeJS.Timeout | null = null;
let inactivityTimer: NodeJS.Timeout | null = null;
let ambientTickTimer: NodeJS.Timeout | null = null;
let ambientMotionTimer: NodeJS.Timeout | null = null;
let ambientFinishTimer: NodeJS.Timeout | null = null;
let mouseMonitorRestartTimer: NodeJS.Timeout | null = null;
let breakRunVelocity: PetPosition = { x: 0, y: 0 };
let breakRunFormatter: ((seconds: number) => string) | null = null;
let nextBreakRunTurnAt = 0;
let breakMutedToday = false;
let dragOffset: PetPosition = { x: 0, y: 0 };
let petMouseInteractive = true;
let lastPetInteractionAt = Date.now();
let sleepingFromInactivity = false;
let ambientMode: AmbientMode = null;
let ambientSequence = 0;
let nextRoamAt = Date.now() + 12_000;
let lastStretchAt = Date.now();
let mouseMonitorProcess: ChildProcess | null = null;
let globalClickSequence: TimedClick[] = [];
let isQuitting = false;
let distractionStatus: DistractionStatus = {
  state: "idle",
  activeApp: "",
  activeWindowTitle: "",
  matchedRule: null,
  lastCheckedAt: null,
  lastWarningAt: null,
  error: null
};
let updateCheck: UpdateCheckResult = createInitialUpdateCheck();

function setPetMouseInteractive(interactive: boolean): void {
  if (!petWindow || petWindow.isDestroyed() || petMouseInteractive === interactive) return;
  petMouseInteractive = interactive;
  petWindow.setIgnoreMouseEvents(!interactive, { forward: true });
}

function getSettings(): Settings {
  return getStoredSettings(store);
}

function text(): ReturnType<typeof i18n> {
  return i18n(getSettings().language);
}

function setSettings(next: Settings): void {
  const normalized = normalizeSettings(next);
  applyLaunchAtLoginPreference(normalized.launchAtLoginEnabled);
  store.set("settings", normalized);
  sendToAll("settings:updated", getSettingsWithSystemState());
  settingsWindow?.setTitle(`${APP_NAME} ${text().menu.settings}`);
  scheduleReminderTimers();
  scheduleDistractionDetection();
  updateTrayMenu();
}

function getSettingsWithSystemState(): Settings {
  const settings = getSettings();
  return {
    ...settings,
    launchAtLoginEnabled: getLaunchAtLoginState(settings.launchAtLoginEnabled)
  };
}

function getStats(): TodayStats {
  return getCurrentStats(store);
}

function updateStats(mutator: (stats: TodayStats) => TodayStats): void {
  const next = updateCurrentStats(store, mutator);
  sendToAll("stats:updated", next);
}

function isCustomPetState(state: unknown): state is PetState {
  return typeof state === "string" && PET_STATE_ORDER.includes(state as PetState);
}

async function importCustomPetAsset(state: PetState, sourcePath: string): Promise<CustomPetAsset | null> {
  if (!isCustomPetState(state) || typeof sourcePath !== "string") return null;
  const extension = extname(sourcePath).toLowerCase();
  if (![".gif", ".png", ".webp", ".webm"].includes(extension)) return null;

  const customRoot = join(app.getPath("userData"), "custom_pet_assets");
  const stateDir = join(customRoot, state);
  await mkdir(stateDir, { recursive: true });

  const originalName = basename(sourcePath);
  const safeName = originalName.replace(/[^a-zA-Z0-9._-]+/g, "-") || `${state}${extension}`;
  const fileName = `${state}-${Date.now()}-${safeName}`;
  const targetPath = join(stateDir, fileName);
  await copyFile(sourcePath, targetPath);

  return {
    relativePath: `custom_pet_assets/${state}/${fileName}`,
    originalName,
    updatedAt: Date.now(),
    mediaType: extension === ".webm" ? "video" : extension === ".gif" ? "animated-image" : "image"
  };
}

function resetTodayStats(): void {
  breakMutedToday = false;
  const reset = resetCurrentStats(store);
  sendToAll("stats:updated", reset);
}

async function selectCustomPetAsset(state: PetState): Promise<CustomPetAsset | null> {
  if (!isCustomPetState(state)) return null;

  const options: Electron.OpenDialogOptions = {
    properties: ["openFile"],
    filters: [{ name: "Pet Assets", extensions: ["gif", "png", "webp", "webm"] }]
  };
  const result =
    settingsWindow && !settingsWindow.isDestroyed()
      ? await dialog.showOpenDialog(settingsWindow, options)
      : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths[0]) return null;
  return importCustomPetAsset(state, result.filePaths[0]);
}

function snapshot(): AppSnapshot {
  return {
    appInfo: {
      version: app.getVersion(),
      releaseNotesUrl: RELEASES_URL
    },
    updateCheck,
    settings: getSettingsWithSystemState(),
    stats: getStats(),
    statsHistory: getStatsHistory(store),
    timers: {
      breakDueAt,
      hydrationDueAt,
      focusEndsAt
    },
    distraction: distractionStatus,
    petState,
    petFacing,
    blockingMode,
    dogVisible: Boolean(petWindow?.isVisible()),
    focusActive
  };
}

function isPetHiddenByUser(): boolean {
  return store.get("petHiddenByUser") === true;
}

function setPetHiddenByUser(hidden: boolean): void {
  store.set("petHiddenByUser", hidden);
  updateTrayMenu();
  publishSnapshot();
}

function sendToPet<T>(channel: string, payload?: T): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  petWindow.webContents.send(channel, payload);
}

function sendToAll<T>(channel: string, payload?: T): void {
  sendToPet(channel, payload);
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send(channel, payload);
  }
}

function publishSnapshot(): void {
  sendToAll("app:snapshot", snapshot());
}

function setPetState(next: PetState): void {
  petState = next;
  if (next !== "sleeping") sleepingFromInactivity = false;
  sendToAll("pet:set-state", next);
}

function notePetInteraction(): void {
  lastPetInteractionAt = Date.now();
  if (sleepingFromInactivity && !blockingMode && !focusActive) {
    sleepingFromInactivity = false;
    setPetState("idle");
  }
}

function publishCursorMotion(): void {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = petWindow.getBounds();
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  const deltaX = cursor.x - centerX;
  const deltaY = cursor.y - centerY;
  const distance = Math.hypot(deltaX, deltaY);
  const near = distance <= 280;
  sendToPet("pet:cursor-motion", {
    x: Math.max(-1, Math.min(1, deltaX / Math.max(bounds.width, 1))),
    y: Math.max(-1, Math.min(1, deltaY / Math.max(bounds.height, 1))),
    distance,
    near
  });
  if (near) {
    notePetInteraction();
    if (blockingMode !== "breakRun" && Math.abs(deltaX) > 25) {
      setPetFacing(deltaX < 0 ? "left" : "right");
    }
  }
}

function checkPetInactivity(): void {
  if (
    !sleepingFromInactivity &&
    !blockingMode &&
    !focusActive &&
    petState === "idle" &&
    Date.now() - lastPetInteractionAt >= 5 * 60 * 1000
  ) {
    sleepingFromInactivity = true;
    setPetState("sleeping");
  }
}

function startPetInteractionTimers(): void {
  if (cursorMotionTimer) clearInterval(cursorMotionTimer);
  if (inactivityTimer) clearInterval(inactivityTimer);
  cursorMotionTimer = setInterval(publishCursorMotion, 80);
  inactivityTimer = setInterval(checkPetInactivity, 30_000);
}

function setPetFacing(next: PetFacing): void {
  if (petFacing === next) return;
  petFacing = next;
  publishSnapshot();
}

function showBubble(bubble: SpeechBubble): void {
  if (bubbleTimer) clearTimeout(bubbleTimer);
  sendToPet("pet:show-bubble", bubble);
  if (bubble.autoDismissMs) {
    bubbleTimer = setTimeout(() => hideBubble(), bubble.autoDismissMs);
  }
}

function hideBubble(): void {
  if (bubbleTimer) {
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
  }
  sendToPet("pet:hide-bubble");
}

function rendererUrl(route: "pet" | "settings" | "ball"): string {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return `${devServer}#${route}`;
  return RENDERER_HTML_PATH;
}

function loadRenderer(win: BrowserWindow, route: "pet" | "settings" | "ball"): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) {
    void win.loadURL(rendererUrl(route));
    return;
  }
  void win.loadFile(rendererUrl(route), { hash: route });
}

function randomBetween(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

function setNextRoamTime(minimumMs = 12_000, maximumMs = 28_000): void {
  nextRoamAt = Date.now() + Math.round(randomBetween(minimumMs, maximumMs));
}

function destroyBallWindow(): void {
  if (ballWindow && !ballWindow.isDestroyed()) ballWindow.destroy();
  ballWindow = null;
}

function clearAmbientTimers(): void {
  if (ambientMotionTimer) {
    clearInterval(ambientMotionTimer);
    ambientMotionTimer = null;
  }
  if (ambientFinishTimer) {
    clearTimeout(ambientFinishTimer);
    ambientFinishTimer = null;
  }
}

function cancelAmbientActivity(): void {
  ambientSequence += 1;
  clearAmbientTimers();
  destroyBallWindow();
  ambientMode = null;
  setNextRoamTime();
}

function canStartAmbientActivity(): boolean {
  return Boolean(
    !ambientMode &&
      !blockingMode &&
      !focusActive &&
      !dragTimer &&
      !isPetHiddenByUser() &&
      petWindow &&
      !petWindow.isDestroyed() &&
      petWindow.isVisible() &&
      (petState === "idle" || petState === "sleeping")
  );
}

function runAmbientAnimation(
  durationMs: number,
  sequence: number,
  frame: (progress: number) => void,
  complete: () => void
): void {
  if (ambientMotionTimer) clearInterval(ambientMotionTimer);
  const startedAt = Date.now();
  const tick = (): void => {
    if (sequence !== ambientSequence) return;
    const progress = clamp((Date.now() - startedAt) / Math.max(durationMs, 1), 0, 1);
    frame(progress);
    if (progress < 1) return;
    if (ambientMotionTimer) {
      clearInterval(ambientMotionTimer);
      ambientMotionTimer = null;
    }
    complete();
  };
  tick();
  if (durationMs > 0) ambientMotionTimer = setInterval(tick, 16);
}

function targetPetBoundsForPoint(point: ScreenPoint): Electron.Rectangle {
  return visibleWindowBounds(currentDisplays(), primaryDisplay(), {
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: Math.round(point.x - PET_WINDOW.width / 2),
    y: Math.round(point.y - PET_WINDOW.height + 28)
  });
}

function animatePetToBounds(
  target: Electron.Rectangle,
  speedPixelsPerSecond: number,
  sequence: number,
  motionState: "walking" | "running",
  complete: () => void
): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const start = petWindow.getBounds();
  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  const durationMs = clamp((distance / speedPixelsPerSecond) * 1000, 420, 7200);
  setPetFacing(target.x >= start.x ? "right" : "left");
  setPetState(motionState);
  runAmbientAnimation(
    durationMs,
    sequence,
    (progress) => {
      if (!petWindow || petWindow.isDestroyed()) return;
      const eased = easeInOut(progress);
      petWindow.setBounds({
        ...start,
        x: Math.round(start.x + (target.x - start.x) * eased),
        y: Math.round(start.y + (target.y - start.y) * eased)
      });
    },
    () => {
      persistPetPosition();
      complete();
    }
  );
}

function chooseRoamTarget(): Electron.Rectangle | null {
  if (!petWindow || petWindow.isDestroyed()) return null;
  const bounds = petWindow.getBounds();
  const workArea = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  }).workArea;
  const minimumX = workArea.x + 8;
  const maximumX = workArea.x + workArea.width - PET_WINDOW.width - 8;
  const minimumY = Math.min(
    workArea.y + workArea.height - PET_WINDOW.height - 8,
    workArea.y + Math.round(workArea.height * 0.28)
  );
  const maximumY = workArea.y + workArea.height - PET_WINDOW.height - 8;
  return {
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: Math.round(randomBetween(minimumX, Math.max(minimumX, maximumX))),
    y: Math.round(randomBetween(minimumY, Math.max(minimumY, maximumY)))
  };
}

function startRoaming(): void {
  if (!canStartAmbientActivity()) return;
  const target = chooseRoamTarget();
  if (!target || !petWindow) return;
  const current = petWindow.getBounds();
  if (Math.hypot(target.x - current.x, target.y - current.y) < 90) {
    setNextRoamTime(5_000, 10_000);
    return;
  }

  ambientMode = "roaming";
  sleepingFromInactivity = false;
  ambientSequence += 1;
  const sequence = ambientSequence;
  animatePetToBounds(target, 150, sequence, "walking", () => {
    if (sequence !== ambientSequence) return;
    ambientMode = null;
    setPetState("idle");
    setNextRoamTime();
  });
}

function startStretching(): void {
  if (!canStartAmbientActivity()) return;
  ambientMode = "stretching";
  sleepingFromInactivity = false;
  lastStretchAt = Date.now();
  ambientSequence += 1;
  const sequence = ambientSequence;
  setPetState("breakRunning");
  ambientFinishTimer = setTimeout(() => {
    ambientFinishTimer = null;
    if (sequence !== ambientSequence || blockingMode || focusActive) return;
    ambientMode = null;
    setPetState("idle");
    setNextRoamTime(7_000, 15_000);
  }, 5_000);
}

function ambientTick(): void {
  if (!canStartAmbientActivity()) return;
  const now = Date.now();
  if (now - lastStretchAt >= STRETCH_INTERVAL_MS) {
    startStretching();
    return;
  }
  if (now >= nextRoamAt) startRoaming();
}

function startAmbientBehavior(): void {
  if (ambientTickTimer) clearInterval(ambientTickTimer);
  lastStretchAt = Date.now();
  setNextRoamTime(8_000, 16_000);
  ambientTickTimer = setInterval(ambientTick, AMBIENT_TICK_MS);
}

function createBallWindow(point: ScreenPoint, ready: () => void): void {
  destroyBallWindow();
  ballWindow = new BrowserWindow({
    width: BALL_WINDOW.width,
    height: BALL_WINDOW.height,
    x: Math.round(point.x - BALL_WINDOW.width / 2),
    y: Math.round(point.y - BALL_WINDOW.height / 2),
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    focusable: false,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  ballWindow.setIgnoreMouseEvents(true);
  ballWindow.setAlwaysOnTop(true, "floating");
  ballWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadRenderer(ballWindow, "ball");
  ballWindow.once("ready-to-show", () => {
    if (!ballWindow || ballWindow.isDestroyed()) return;
    ballWindow.showInactive();
    ready();
  });
  ballWindow.on("closed", () => {
    ballWindow = null;
  });
}

function setBallFrame(
  center: ScreenPoint,
  size: number = BALL_WINDOW.width,
  opacity: number = 1
): void {
  if (!ballWindow || ballWindow.isDestroyed()) return;
  ballWindow.setBounds({
    x: Math.round(center.x - size / 2),
    y: Math.round(center.y - size / 2),
    width: Math.max(1, Math.round(size)),
    height: Math.max(1, Math.round(size))
  });
  ballWindow.setOpacity(clamp(opacity, 0, 1));
}

function chooseBallLanding(click: ScreenPoint): ScreenPoint {
  const workArea = screen.getDisplayNearestPoint({ x: click.x, y: click.y }).workArea;
  const petBounds = petWindow?.getBounds();
  const petCenterX = petBounds ? petBounds.x + petBounds.width / 2 : click.x;
  const preferredDirection = click.x >= petCenterX ? 1 : -1;
  const distance = randomBetween(170, 290);
  const margin = BALL_WINDOW.width / 2 + 12;
  const minimumX = workArea.x + margin;
  const maximumX = workArea.x + workArea.width - margin;
  let x = clamp(click.x + preferredDirection * distance, minimumX, maximumX);
  if (Math.abs(x - click.x) < 100) {
    x = clamp(click.x - preferredDirection * distance, minimumX, maximumX);
  }
  return {
    x,
    y: clamp(click.y + randomBetween(-65, 65), workArea.y + margin, workArea.y + workArea.height - margin)
  };
}

function finishBallPounce(landing: ScreenPoint, sequence: number): void {
  if (sequence !== ambientSequence) return;
  setPetState("pouncing");
  runAmbientAnimation(
    1_150,
    sequence,
    (progress) => {
      const vanish = clamp((progress - 0.48) / 0.52, 0, 1);
      setBallFrame(landing, BALL_WINDOW.width * (1 - vanish * 0.72), 1 - vanish);
    },
    () => {
      destroyBallWindow();
      setPetState("happy");
      ambientFinishTimer = setTimeout(() => {
        ambientFinishTimer = null;
        if (sequence !== ambientSequence || blockingMode || focusActive) return;
        ambientMode = null;
        setPetState("idle");
        setNextRoamTime(10_000, 20_000);
      }, 1_000);
    }
  );
}

function chaseBall(landing: ScreenPoint, sequence: number): void {
  if (sequence !== ambientSequence) return;
  const target = targetPetBoundsForPoint(landing);
  animatePetToBounds(target, 360, sequence, "running", () =>
    finishBallPounce(landing, sequence)
  );
}

function startBallChase(click: ScreenPoint): void {
  if (blockingMode || focusActive || ambientMode === "ball") return;
  if (!ensurePetWindowVisible()) return;
  cancelAmbientActivity();
  ambientMode = "ball";
  sleepingFromInactivity = false;
  notePetInteraction();
  ambientSequence += 1;
  const sequence = ambientSequence;
  const landing = chooseBallLanding(click);
  setPetFacing(landing.x >= click.x ? "right" : "left");
  createBallWindow(click, () => {
    if (sequence !== ambientSequence) return;
    const distance = Math.hypot(landing.x - click.x, landing.y - click.y);
    runAmbientAnimation(
      clamp(distance * 3.2, 620, 920),
      sequence,
      (progress) => {
        const eased = easeInOut(progress);
        setBallFrame({
          x: click.x + (landing.x - click.x) * eased,
          y:
            click.y +
            (landing.y - click.y) * eased -
            Math.sin(Math.PI * progress) * Math.min(130, 70 + distance * 0.22)
        });
      },
      () => chaseBall(landing, sequence)
    );
  });
}

function handleGlobalMouseClick(click: TimedClick): void {
  if (blockingMode || focusActive) {
    globalClickSequence = [];
    return;
  }
  const result = recordSamePlaceClick(globalClickSequence, click);
  globalClickSequence = result.clicks;
  if (result.tripleClick) startBallChase(click);
}

function mouseMonitorPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "native", "pawpal-mouse-monitor")
    : join(process.cwd(), "native", "bin", "pawpal-mouse-monitor");
}

function startGlobalMouseMonitor(): void {
  if (process.platform !== "darwin" || mouseMonitorProcess || isQuitting) return;
  const child = spawn(mouseMonitorPath(), [], { stdio: ["ignore", "pipe", "pipe"] });
  mouseMonitorProcess = child;
  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split("\n");
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const payload = JSON.parse(line) as Partial<TimedClick> & { type?: string };
        if (
          payload.type === "leftMouseDown" &&
          typeof payload.x === "number" &&
          typeof payload.y === "number"
        ) {
          handleGlobalMouseClick({
            x: payload.x,
            y: payload.y,
            timestamp: typeof payload.timestamp === "number" ? payload.timestamp : Date.now()
          });
        }
      } catch {
        // Ignore malformed helper output and keep monitoring future clicks.
      }
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (message: string) => {
    console.warn(`Domi mouse monitor: ${message.trim()}`);
  });
  child.on("error", (error) => {
    console.warn("Unable to start the Domi mouse monitor:", error);
  });
  child.on("exit", () => {
    if (mouseMonitorProcess === child) mouseMonitorProcess = null;
    if (isQuitting) return;
    if (mouseMonitorRestartTimer) clearTimeout(mouseMonitorRestartTimer);
    mouseMonitorRestartTimer = setTimeout(startGlobalMouseMonitor, 5_000);
  });
}

function stopGlobalMouseMonitor(): void {
  if (mouseMonitorRestartTimer) {
    clearTimeout(mouseMonitorRestartTimer);
    mouseMonitorRestartTimer = null;
  }
  mouseMonitorProcess?.kill();
  mouseMonitorProcess = null;
}

function toDisplayBounds(display: Electron.Display): DisplayBounds {
  return {
    id: display.id,
    workArea: display.workArea
  };
}

function currentDisplays(): DisplayBounds[] {
  return screen.getAllDisplays().map(toDisplayBounds);
}

function primaryDisplay(): DisplayBounds {
  return toDisplayBounds(screen.getPrimaryDisplay());
}

function initialPetBounds(): Electron.Rectangle {
  const stored = store.get("petPosition");
  return initialWindowBounds({
    displays: currentDisplays(),
    primaryDisplay: primaryDisplay(),
    size: PET_WINDOW,
    saved: stored
  });
}

function persistPetPosition(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  store.set("petPosition", savedPositionFromBounds(currentDisplays(), bounds, primaryDisplay()));
}

function keepPetWindowInVisibleWorkArea(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const bounds = petWindow.getBounds();
  const nextBounds = visibleWindowBounds(currentDisplays(), primaryDisplay(), bounds);
  if (bounds.x !== nextBounds.x || bounds.y !== nextBounds.y) {
    petWindow.setBounds(nextBounds);
  }
  persistPetPosition();
  publishSnapshot();
}

function schedulePetDisplayRepair(): void {
  if (displayChangeTimer) clearTimeout(displayChangeTimer);
  displayChangeTimer = setTimeout(() => {
    displayChangeTimer = null;
    keepPetWindowInVisibleWorkArea();
  }, 250);
}

function registerDisplayChangeHandlers(): void {
  screen.on("display-added", schedulePetDisplayRepair);
  screen.on("display-removed", schedulePetDisplayRepair);
  screen.on("display-metrics-changed", schedulePetDisplayRepair);
}

function createPetWindow(): void {
  const bounds = initialPetBounds();
  petMouseInteractive = true;
  petWindow = new BrowserWindow({
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: bounds.x,
    y: bounds.y,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !IS_DEV
    }
  });

  petWindow.setAlwaysOnTop(true, process.platform === "darwin" ? "floating" : "normal");
  if (process.platform === "darwin") {
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  setPetMouseInteractive(false);
  loadRenderer(petWindow, "pet");
  petWindow.once("ready-to-show", () => {
    if (!isPetHiddenByUser()) petWindow?.showInactive();
    updateTrayMenu();
    publishSnapshot();
  });
  petWindow.on("show", () => {
    updateTrayMenu();
    publishSnapshot();
  });
  petWindow.on("hide", () => {
    cancelAmbientActivity();
    stopPetDrag();
    updateTrayMenu();
    publishSnapshot();
  });
  petWindow.on("closed", () => {
    cancelAmbientActivity();
    stopPetDrag();
    petWindow = null;
    updateTrayMenu();
    publishSnapshot();
  });
}

function ensurePetWindowVisible(options: { ignoreUserHidden?: boolean } = {}): boolean {
  if (isPetHiddenByUser() && !options.ignoreUserHidden) {
    updateTrayMenu();
    publishSnapshot();
    return false;
  }
  if (!petWindow || petWindow.isDestroyed()) createPetWindow();
  if (petWindow && !petWindow.isVisible()) petWindow.showInactive();
  updateTrayMenu();
  publishSnapshot();
  return true;
}

function showPetWindowFromMenu(): void {
  setPetHiddenByUser(false);
  ensurePetWindowVisible({ ignoreUserHidden: true });
}

function createSettingsWindow(): void {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WINDOW.width,
    height: SETTINGS_WINDOW.height,
    title: `${APP_NAME} ${text().menu.settings}`,
    resizable: true,
    minWidth: SETTINGS_WINDOW.width,
    maxWidth: SETTINGS_WINDOW.width,
    minHeight: 400,
    show: false,
    backgroundColor: "#faf6ee",
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 14, y: 14 } }
      : {}),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: !IS_DEV
    }
  });

  loadRenderer(settingsWindow, "settings");
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
    publishSnapshot();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
}

function createTray(): void {
  tray = new Tray(createTrayImage());
  tray.setToolTip(APP_NAME);
  tray.on("click", () => {
    tray?.popUpContextMenu();
  });
  if (process.platform !== "darwin") {
    nativeTheme.on("updated", () => tray?.setImage(createTrayImage()));
  }
  updateTrayMenu();
}

function togglePetWindowVisibility(): void {
  if (!petWindow) createPetWindow();
  if (!petWindow) return;
  if (petWindow.isVisible()) hidePetWindowFromMenu();
  else showPetWindowFromMenu();
}

function hidePetWindowFromMenu(): void {
  cancelAmbientActivity();
  setPetHiddenByUser(true);
  petWindow?.hide();
  updateTrayMenu();
  sendToAll("app:snapshot", snapshot());
}

function menuState() {
  return {
    appName: APP_NAME,
    dogVisible: Boolean(petWindow?.isVisible()),
    focusActive,
    isPackaged: app.isPackaged
  };
}

function menuActions() {
  return {
    toggleDog: togglePetWindowVisibility,
    hideDog: hidePetWindowFromMenu,
    startFocus: startFocusMode,
    stopFocusFromMenu: () => stopFocusMode(true),
    stopFocusFromContext: () => stopFocusMode(false),
    openSettings: createSettingsWindow,
    quit: () => app.quit(),
    triggerDemo
  };
}

function updateApplicationMenu(): void {
  const labels = text().menu;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(buildApplicationMenuTemplate(labels, menuState(), menuActions()))
  );
}

function updateTrayMenu(): void {
  updateApplicationMenu();
  if (!tray) return;
  const labels = text().menu;
  tray.setContextMenu(
    Menu.buildFromTemplate(buildTrayMenuTemplate(labels, menuState(), menuActions()))
  );
}

function showPetContextMenu(): void {
  const labels = text().menu;
  Menu.buildFromTemplate(buildPetContextMenuTemplate(labels, menuState(), menuActions())).popup({
    window: petWindow ?? undefined
  });
}

function movePetWithCursor(): void {
  if (!petWindow || petWindow.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const bounds = visibleWindowBounds(currentDisplays(), primaryDisplay(), {
    width: PET_WINDOW.width,
    height: PET_WINDOW.height,
    x: cursor.x - dragOffset.x,
    y: cursor.y - dragOffset.y
  });
  petWindow.setBounds(bounds);
}

function startPetDrag(offset: { offsetX: number; offsetY: number }): void {
  if (blockingMode === "breakRun" || !petWindow || petWindow.isDestroyed()) return;
  if (ambientMode) {
    cancelAmbientActivity();
    setPetState(focusActive ? "focusGuard" : "idle");
  }
  notePetInteraction();
  dragOffset = {
    x: Math.min(Math.max(Math.round(offset.offsetX), 0), PET_WINDOW.width),
    y: Math.min(Math.max(Math.round(offset.offsetY), 0), PET_WINDOW.height)
  };
  if (dragTimer) clearInterval(dragTimer);
  if (dragSafetyTimer) clearTimeout(dragSafetyTimer);
  movePetWithCursor();
  dragTimer = setInterval(movePetWithCursor, 16);
  dragSafetyTimer = setTimeout(stopPetDrag, 15_000);
}

function stopPetDrag(): void {
  const wasDragging = Boolean(dragTimer || dragSafetyTimer);
  if (dragTimer) {
    clearInterval(dragTimer);
    dragTimer = null;
  }
  if (dragSafetyTimer) {
    clearTimeout(dragSafetyTimer);
    dragSafetyTimer = null;
  }
  if (wasDragging) {
    persistPetPosition();
    sendToAll("app:snapshot", snapshot());
  }
}

function clearBreakRunTimers(): void {
  if (breakRunTimer) {
    clearTimeout(breakRunTimer);
    breakRunTimer = null;
  }
  if (breakRunCountdownTimer) {
    clearInterval(breakRunCountdownTimer);
    breakRunCountdownTimer = null;
  }
  if (breakRunMovementTimer) {
    clearInterval(breakRunMovementTimer);
    breakRunMovementTimer = null;
  }
}

function showBreakRunCountdown(endsAt: number): void {
  const labels = text();
  const remainingSeconds = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  const formatter = breakRunFormatter ?? pick(labels.bubble.breakRun);
  showBubble({
    id: "break-run",
    message: formatter(remainingSeconds),
    actions: [{ id: "break-run:done", label: labels.actions.breakRunDone, kind: "primary" }]
  });
}

function chooseBreakRunVelocity(): PetPosition {
  const speed = 3.5 + Math.random() * 2.9;
  const angle = Math.random() * Math.PI * 2;
  return {
    x: Math.cos(angle) * speed,
    y: Math.sin(angle) * speed
  };
}

function movePetForBreakRun(): void {
  if (!petWindow || petWindow.isDestroyed() || !petWindow.isVisible()) return;

  const bounds = petWindow.getBounds();
  const workArea = screen.getDisplayNearestPoint({
    x: bounds.x + Math.round(bounds.width / 2),
    y: bounds.y + Math.round(bounds.height / 2)
  }).workArea;
  const now = Date.now();
  const minX = workArea.x + 8;
  const maxX = workArea.x + workArea.width - PET_WINDOW.width - 8;
  const minY = workArea.y + 8;
  const maxY = workArea.y + workArea.height - PET_WINDOW.height - 8;

  if (now >= nextBreakRunTurnAt && Math.random() < 0.45) {
    breakRunVelocity = chooseBreakRunVelocity();
  }

  let nextX = bounds.x + breakRunVelocity.x;
  let nextY = bounds.y + breakRunVelocity.y;

  if (nextX <= minX) {
    nextX = minX;
    breakRunVelocity.x = Math.abs(breakRunVelocity.x);
  }
  if (nextX >= maxX) {
    nextX = maxX;
    breakRunVelocity.x = -Math.abs(breakRunVelocity.x);
  }
  if (nextY <= minY) {
    nextY = minY;
    breakRunVelocity.y = Math.abs(breakRunVelocity.y);
  }
  if (nextY >= maxY) {
    nextY = maxY;
    breakRunVelocity.y = -Math.abs(breakRunVelocity.y);
  }

  if (now >= nextBreakRunTurnAt) {
    nextBreakRunTurnAt = now + 350 + Math.round(Math.random() * 850);
  }

  setPetFacing(breakRunVelocity.x >= 0 ? "right" : "left");
  petWindow.setBounds({
    ...bounds,
    x: Math.round(nextX),
    y: Math.round(nextY)
  });
}

function finishBreakRun(): void {
  clearBreakRunTimers();
  breakRunFormatter = null;
  blockingMode = null;
  hideBubble();
  showBubble({ id: "break-run-complete", message: pick(text().bubble.breakRunComplete), autoDismissMs: 2200 });
  setPetState("breakDone");
  scheduleBreakReminderTimer();
  setTimeout(() => {
    if (!blockingMode && !focusActive) {
      if (showOverdueReminder()) return;
      hideBubble();
      setPetState("idle");
    }
  }, 2300);
  publishSnapshot();
}

function startBreakRun(): void {
  ensurePetWindowVisible();
  cancelAmbientActivity();
  clearBreakRunTimers();
  blockingMode = "breakRun";
  breakDueAt = null;
  breakRunFormatter = pick(text().bubble.breakRun);
  breakRunVelocity = chooseBreakRunVelocity();
  nextBreakRunTurnAt = Date.now();
  setPetState("running");
  setPetFacing(breakRunVelocity.x >= 0 ? "right" : "left");
  const durationMs = getSettings().breakRunDurationSeconds * 1000;
  const endsAt = Date.now() + durationMs;
  showBreakRunCountdown(endsAt);
  breakRunCountdownTimer = setInterval(() => showBreakRunCountdown(endsAt), 1000);
  breakRunMovementTimer = setInterval(movePetForBreakRun, BREAK_RUN_TICK_MS);
  breakRunTimer = setTimeout(finishBreakRun, durationMs);
  publishSnapshot();
}

function clearBreakReminderTimer(): void {
  if (breakTimer) {
    clearTimeout(breakTimer);
    breakTimer = null;
  }
}

function clearHydrationReminderTimer(): void {
  if (hydrationTimer) {
    clearTimeout(hydrationTimer);
    hydrationTimer = null;
  }
}

function scheduleBreakReminderTimer(delayMs?: number): void {
  clearBreakReminderTimer();
  const settings = getSettings();
  if (!settings.breakReminderEnabled || breakMutedToday) {
    breakDueAt = null;
    publishSnapshot();
    return;
  }

  const nextDelayMs = delayMs ?? settings.breakIntervalMinutes * 60 * 1000;
  breakDueAt = Date.now() + nextDelayMs;
  breakTimer = setTimeout(() => triggerBreakReminder(false), nextDelayMs);
  publishSnapshot();
}

function scheduleHydrationReminderTimer(delayMs?: number): void {
  clearHydrationReminderTimer();
  const settings = getSettings();
  if (!settings.hydrationReminderEnabled) {
    hydrationDueAt = null;
    publishSnapshot();
    return;
  }

  const nextDelayMs = delayMs ?? settings.hydrationIntervalMinutes * 60 * 1000;
  hydrationDueAt = Date.now() + nextDelayMs;
  hydrationTimer = setTimeout(() => triggerHydrationReminder(false), nextDelayMs);
  publishSnapshot();
}

function scheduleReminderTimers(): void {
  clearBreakReminderTimer();
  clearHydrationReminderTimer();
  breakDueAt = null;
  hydrationDueAt = null;

  scheduleBreakReminderTimer();
  scheduleHydrationReminderTimer();
}

function showOverdueReminder(): boolean {
  if (blockingMode || focusActive) return false;

  const now = Date.now();
  const settings = getSettings();
  if (settings.breakReminderEnabled && !breakMutedToday && breakDueAt !== null && breakDueAt <= now) {
    triggerBreakReminder(false);
    return true;
  }
  if (settings.hydrationReminderEnabled && hydrationDueAt !== null && hydrationDueAt <= now) {
    triggerHydrationReminder(false);
    return true;
  }

  return false;
}

function setDistractionStatus(partial: Partial<DistractionStatus>): void {
  distractionStatus = { ...distractionStatus, ...partial };
  publishSnapshot();
}

async function checkDistractionNow(): Promise<void> {
  const settings = getSettings();
  if (!settings.distractionDetectionEnabled) return;

  try {
    const active = await readActiveWindow();
    const matchedRule = classifyDistraction(active, settings);
    const now = Date.now();

    setDistractionStatus({
      state: "watching",
      activeApp: active.appName,
      activeWindowTitle: active.windowTitle,
      matchedRule,
      lastCheckedAt: now,
      error: null
    });

    if (!focusActive || blockingMode === "focusWarning") return;
    if (!matchedRule) return;
    if (
      distractionStatus.lastWarningAt &&
      now - distractionStatus.lastWarningAt < DISTRACTION_WARNING_COOLDOWN_MS
    ) {
      return;
    }

    setDistractionStatus({ lastWarningAt: now });
    triggerFocusWarning(matchedRule.replace(/^(app|keyword):/, ""));
  } catch (error) {
    setDistractionStatus({
      state: isPermissionError(error) ? "permission-needed" : "error",
      error: error instanceof Error ? error.message : String(error),
      lastCheckedAt: Date.now()
    });
  }
}

function scheduleDistractionDetection(): void {
  if (distractionTimer) {
    clearInterval(distractionTimer);
    distractionTimer = null;
  }
  if (distractionStartupTimer) {
    clearTimeout(distractionStartupTimer);
    distractionStartupTimer = null;
  }

  const settings = getSettings();
  if (!settings.distractionDetectionEnabled) {
    setDistractionStatus({
      state: "idle",
      matchedRule: null,
      error: null
    });
    return;
  }

  setDistractionStatus({
    state: process.platform === "darwin" ? "watching" : "unsupported",
    error: process.platform === "darwin" ? null : text().system.unsupportedDistraction
  });

  if (process.platform !== "darwin") return;

  const firstCheckDelay = focusActive ? Math.max(0, settings.distractionGraceSeconds * 1000) : 0;
  distractionStartupTimer = setTimeout(() => {
    void checkDistractionNow();
    distractionTimer = setInterval(() => void checkDistractionNow(), DISTRACTION_CHECK_INTERVAL_MS);
  }, firstCheckDelay);
}

function resumeLongTermState(): void {
  blockingMode = null;
  hideBubble();
  if (showOverdueReminder()) return;
  if (focusActive) {
    setPetState("focusGuard");
    sendToAll("app:snapshot", snapshot());
    return;
  }
  setPetState("idle");
  sendToAll("app:snapshot", snapshot());
}

function happyFeedback(message: string | null = pick(text().bubble.woof), after?: () => void): void {
  if (blockingMode) return;
  if (ambientMode) cancelAmbientActivity();
  const returnState = focusActive ? "focusGuard" : "idle";
  setPetState("happy");
  if (message) {
    showBubble({ id: "happy", message, autoDismissMs: 1800 });
  }
  setTimeout(() => {
    hideBubble();
    setPetState(returnState);
    after?.();
  }, 1900);
}

function setUpdateCheck(next: UpdateCheckResult): void {
  updateCheck = next;
  publishSnapshot();
}

function openReleaseNotes(): void {
  void shell.openExternal(updateCheck.releaseUrl || RELEASES_URL).catch((error) => {
    console.error("Failed to open Domi releases:", error);
  });
}

function showUpdateAvailableNotice(result: UpdateCheckResult): void {
  if (blockingMode || result.status !== "available" || !result.latestVersion) return;
  ensurePetWindowVisible();
  setPetState("happy");
  showBubble({
    id: "update-available",
    message: pick(text().bubble.updateAvailable)(result.latestVersion),
    actions: [
      { id: "app:open-release-notes", label: text().settings.openReleaseNotes, kind: "primary" }
    ],
    autoDismissMs: 12000
  });
  setTimeout(() => {
    if (!blockingMode && petState === "happy") setPetState(focusActive ? "focusGuard" : "idle");
  }, 12_100);
}

async function checkForUpdates(options: { notifyAvailable?: boolean } = {}): Promise<UpdateCheckResult> {
  const checking = createCheckingUpdateCheck(updateCheck);
  setUpdateCheck(checking);
  const result = await checkGitHubReleasesForUpdates(checking);
  setUpdateCheck(result);
  if (options.notifyAvailable) showUpdateAvailableNotice(result);
  return result;
}

function triggerBreakReminder(fromDemo: boolean): void {
  if (!fromDemo) {
    breakTimer = null;
    if (breakMutedToday) {
      breakDueAt = null;
      publishSnapshot();
      return;
    }
    if (blockingMode || focusActive) {
      publishSnapshot();
      return;
    }
  } else if (blockingMode === "focusWarning" || blockingMode === "breakRun") {
    return;
  }
  cancelAmbientActivity();
  ensurePetWindowVisible();
  blockingMode = "break";
  breakDueAt = null;
  publishSnapshot();
  setPetState("breakPrompt");
  const labels = text();
  showBubble({
    id: "break",
    message: pick(labels.bubble.breakReminder),
    actions: [
      { id: "break:done", label: labels.actions.breakDone, kind: "primary" },
      { id: "break:snooze", label: labels.actions.breakSnooze },
      { id: "break:mute", label: labels.actions.breakMute, kind: "danger" }
    ]
  });
}

function triggerHydrationReminder(fromDemo: boolean): void {
  if (!fromDemo) {
    hydrationTimer = null;
    if (blockingMode || focusActive) {
      publishSnapshot();
      return;
    }
  } else if (blockingMode) {
    return;
  }
  cancelAmbientActivity();
  ensurePetWindowVisible();
  blockingMode = "hydration";
  hydrationDueAt = null;
  publishSnapshot();
  setPetState("hydrationPrompt");
  const labels = text();
  showBubble({
    id: "hydration",
    message: pick(labels.bubble.hydrationReminder),
    actions: [
      { id: "hydration:done", label: labels.actions.hydrationDone, kind: "primary" },
      { id: "hydration:snooze", label: labels.actions.hydrationSnooze }
    ]
  });
}

function triggerFocusWarning(rule?: string): void {
  if (blockingMode === "breakRun") return;
  cancelAmbientActivity();
  ensurePetWindowVisible();
  if (!focusActive) startFocusMode();
  blockingMode = "focusWarning";
  updateStats((stats) => ({ ...stats, focusWarnings: stats.focusWarnings + 1 }));
  setPetState("focusAlert");
  sendToAll("app:snapshot", snapshot());
  const labels = text();
  showBubble({
    id: "focus-warning",
    message: pick(labels.bubble.focusWarning)(rule ?? "?"),
    actions: [
      { id: "focus:back", label: labels.actions.focusBack, kind: "primary" },
      { id: "focus:end", label: labels.actions.focusEnd }
    ]
  });
}

function startFocusMode(): void {
  if (focusActive || blockingMode) return;
  cancelAmbientActivity();
  ensurePetWindowVisible();
  const settings = getSettings();
  focusActive = true;
  focusStartedAt = Date.now();
  blockingMode = null;
  setPetState("focusGuard");
  focusEndsAt = Date.now() + settings.focusDurationMinutes * 60 * 1000;
  sendToAll("app:snapshot", snapshot());
  showBubble({
    id: "focus-start",
    message: pick(text().bubble.focusStart)(settings.focusDurationMinutes),
    autoDismissMs: 4500
  });
  if (focusTimer) clearTimeout(focusTimer);
  focusTimer = setTimeout(
    () => stopFocusMode(true),
    settings.focusDurationMinutes * 60 * 1000
  );
  scheduleDistractionDetection();
  updateTrayMenu();
}

function stopFocusMode(completed: boolean): void {
  if (!focusActive) return;
  const startedAt = focusStartedAt ?? Date.now();
  const elapsedMinutes = Math.max(1, Math.round((Date.now() - startedAt) / 60000));
  focusActive = false;
  focusStartedAt = null;
  blockingMode = null;
  if (focusTimer) {
    clearTimeout(focusTimer);
    focusTimer = null;
  }
  focusEndsAt = null;
  scheduleDistractionDetection();
  updateStats((stats) => ({
    ...stats,
    focusMinutes: stats.focusMinutes + elapsedMinutes
  }));
  sendToAll("app:snapshot", snapshot());
  setPetState("focusDone");
  showBubble({
    id: "focus-complete",
    message: completed ? pick(text().bubble.focusComplete) : pick(text().bubble.focusCancelled),
    autoDismissMs: 2800
  });
  setTimeout(() => {
    if (!focusActive && !blockingMode) {
      if (showOverdueReminder()) return;
      hideBubble();
      setPetState("idle");
    }
  }, 2900);
  updateTrayMenu();
}

function triggerDemo(trigger: DemoTrigger): void {
  ensurePetWindowVisible();
  if (trigger === "break") triggerBreakReminder(true);
  if (trigger === "hydration") triggerHydrationReminder(true);
  if (trigger === "focusWarning") triggerFocusWarning("Twitter");
  if (trigger === "happy") happyFeedback(pick(text().bubble.woof));
}

function handleBubbleAction(actionId: string): void {
  if (actionId === "app:open-release-notes") {
    hideBubble();
    setPetState(focusActive ? "focusGuard" : "idle");
    openReleaseNotes();
    return;
  }
  if (actionId === "break-run:done") {
    finishBreakRun();
    return;
  }
  if (actionId === "break:done") {
    updateStats((stats) => ({ ...stats, breaksTaken: stats.breaksTaken + 1 }));
    startBreakRun();
    return;
  }
  if (actionId === "break:snooze") {
    resumeLongTermState();
    scheduleBreakReminderTimer(10 * 60 * 1000);
    return;
  }
  if (actionId === "break:mute") {
    breakMutedToday = true;
    breakDueAt = null;
    blockingMode = null;
    sendToAll("app:snapshot", snapshot());
    setPetState("sad");
    showBubble({ id: "break-muted", message: pick(text().bubble.breakIgnore), autoDismissMs: 2600 });
    setTimeout(resumeLongTermState, 2700);
    return;
  }
  if (actionId === "hydration:done") {
    updateStats((stats) => ({ ...stats, watersLogged: stats.watersLogged + 1 }));
    blockingMode = null;
    sendToAll("app:snapshot", snapshot());
    setPetState("drinking");
    hideBubble();
    setTimeout(() => {
      if (blockingMode) return;
      setPetState("hydrationDone");
      showBubble({ id: "hydration-complete", message: pick(text().bubble.hydrationDone), autoDismissMs: 1800 });
      setTimeout(() => {
        scheduleHydrationReminderTimer();
        if (showOverdueReminder()) return;
        hideBubble();
        setPetState(focusActive ? "focusGuard" : "idle");
      }, 1900);
    }, 2400);
    return;
  }
  if (actionId === "hydration:snooze") {
    resumeLongTermState();
    scheduleHydrationReminderTimer(15 * 60 * 1000);
    return;
  }
  if (actionId === "focus:back") {
    blockingMode = null;
    sendToAll("app:snapshot", snapshot());
    setPetState("focusGuard");
    showBubble({ id: "focus-back", message: pick(text().bubble.focusBack), autoDismissMs: 1800 });
    setTimeout(() => {
      if (focusActive && !blockingMode) hideBubble();
    }, 1900);
    return;
  }
  if (actionId === "focus:end") {
    stopFocusMode(false);
  }
}

function registerIpc(): void {
  ipcMain.handle("app:get-snapshot", () => snapshot());
  ipcMain.handle("app:check-for-updates", () => checkForUpdates({ notifyAvailable: true }));
  ipcMain.handle("custom-pet:select-asset", (_event, state: PetState) =>
    selectCustomPetAsset(state)
  );
  ipcMain.handle("custom-pet:import-asset", (_event, state: PetState, sourcePath: string) =>
    importCustomPetAsset(state, sourcePath)
  );
  ipcMain.on("app:open-release-notes", openReleaseNotes);
  ipcMain.on("pet:clicked", () => {
    if (blockingMode) return;
    notePetInteraction();
    happyFeedback(null);
  });
  ipcMain.on("pet:context-menu", showPetContextMenu);
  ipcMain.on("pet:drag-start", (_event, offset: { offsetX: number; offsetY: number }) =>
    startPetDrag(offset)
  );
  ipcMain.on("pet:drag-stop", stopPetDrag);
  ipcMain.on("pet:set-mouse-interactive", (_event, interactive: boolean) => {
    setPetMouseInteractive(interactive);
  });
  ipcMain.on("bubble:action", (_event, actionId: string) => handleBubbleAction(actionId));
  ipcMain.on("settings:update", (_event, partial: Partial<Settings>) => {
    setSettings({ ...getSettings(), ...partial });
  });
  ipcMain.on("demo:trigger", (_event, trigger: DemoTrigger) => triggerDemo(trigger));
  ipcMain.on("focus:start", startFocusMode);
  ipcMain.on("focus:stop", () => stopFocusMode(false));
  ipcMain.on("stats:reset-today", resetTodayStats);
}

protocol.registerSchemesAsPrivileged([
  { scheme: "pawpal-asset", privileges: { bypassCSP: true, supportFetchAPI: true } }
]);

app.whenReady().then(() => {
  protocol.handle("pawpal-asset", (request) => {
    let relativePath = "";
    try {
      const url = new URL(request.url);
      relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    } catch {
      return new Response("Invalid asset URL", { status: 404 });
    }

    const appBase = app.isPackaged ? process.resourcesPath : process.cwd();
    const builtInAssetRoot = resolve(appBase, "pet_assets");
    const customAssetRoot = resolve(app.getPath("userData"), "custom_pet_assets");
    const assetPath = relativePath.startsWith("custom_pet_assets/")
      ? resolve(app.getPath("userData"), relativePath)
      : resolve(appBase, relativePath);
    const isInsideBuiltInAssetRoot =
      assetPath === builtInAssetRoot || assetPath.startsWith(`${builtInAssetRoot}${sep}`);
    const isInsideCustomAssetRoot =
      assetPath === customAssetRoot || assetPath.startsWith(`${customAssetRoot}${sep}`);

    if (!isInsideBuiltInAssetRoot && !isInsideCustomAssetRoot) {
      return new Response("Asset not found", { status: 404 });
    }

    return net.fetch(pathToFileURL(assetPath).href);
  });

  getStats();
  registerIpc();
  createPetWindow();
  createTray();
  registerDisplayChangeHandlers();
  startPetInteractionTimers();
  startAmbientBehavior();
  startGlobalMouseMonitor();
  scheduleReminderTimers();
  scheduleDistractionDetection();
  if (IS_DEV) {
    createSettingsWindow();
  }
  if (getSettings().checkUpdatesOnLaunchEnabled) {
    setTimeout(() => void checkForUpdates({ notifyAvailable: true }), 1500);
  }

  app.on("activate", () => {
    if (!petWindow) createPetWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  stopGlobalMouseMonitor();
  cancelAmbientActivity();
  for (const timer of [
    breakRunTimer,
    breakRunCountdownTimer,
    breakRunMovementTimer,
    breakTimer,
    hydrationTimer,
    focusTimer,
    distractionTimer,
    distractionStartupTimer,
    displayChangeTimer,
    bubbleTimer,
    dragTimer,
    dragSafetyTimer,
    cursorMotionTimer,
    inactivityTimer,
    ambientTickTimer,
    ambientMotionTimer,
    ambientFinishTimer,
    mouseMonitorRestartTimer
  ]) {
    if (timer) clearTimeout(timer);
  }
});

app.on("window-all-closed", () => {
  // Keep the menu-bar utility alive after the settings window is closed.
});
