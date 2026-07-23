import {
  renderKeySvg,
  toSvgDataUrl,
  type KeyAnimationEffect,
  type KeyRenderModel,
} from "../rendering/svg-key-renderer.ts";
import { taskKeyColors } from "../settings/task-key-settings.ts";
import type { KeySnapshot } from "./key-snapshot.ts";

export interface StreamDeckKeyImagePort {
  setImage(image: string): Promise<void>;
  showAlert(): Promise<void>;
}

export interface TaskKeyRenderQueueOptions {
  sleep(delayMs: number): Promise<void>;
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number;
  clearTimer(timer: ReturnType<typeof setTimeout> | number): void;
}

const IMAGE_RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000] as const;
const WORKING_NOISE_FRAME_COUNT = 70;
const WORKING_NOISE_FRAMES = Object.freeze(Array.from(
  { length: WORKING_NOISE_FRAME_COUNT },
  (_, index) => ({ intensity: 1, phase: ((index + 1) % WORKING_NOISE_FRAME_COUNT) / WORKING_NOISE_FRAME_COUNT }),
));
const STATUS_FLASH_FRAMES = [
  { intensity: 0.2, phase: 0.25 },
  { intensity: 0.95, phase: 0.5 },
  { intensity: 0.35, phase: 0.75 },
  { intensity: 0, phase: 1 },
] as const;
const DONE_BURST_FRAMES = [
  { intensity: 0.88, phase: 0.16 },
  { intensity: 0.62, phase: 0.3 },
  { intensity: 0.34, phase: 0.46 },
  { intensity: 0.12, phase: 0.64 },
  { intensity: 0.82, phase: 0.12 },
  { intensity: 1, phase: 0.25 },
  { intensity: 0.68, phase: 0.42 },
  { intensity: 0.38, phase: 0.6 },
  { intensity: 0.16, phase: 0.78 },
  { intensity: 0, phase: 1 },
] as const;
const WORKING_FRAME_DELAY_MS = 1_000 / 24;
const STATUS_FLASH_FRAME_DELAY_MS = 165;
const DONE_BURST_FRAME_DELAY_MS = 165;

interface ActiveAnimation {
  readonly kind: KeyAnimationEffect["kind"];
  readonly snapshot: KeySnapshot;
  readonly generation: number;
  frameIndex: number;
}

interface PendingAnimationFrame {
  readonly snapshot: KeySnapshot;
  readonly effect: KeyAnimationEffect;
  readonly generation: number;
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function defaultSetTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

function renderModel(snapshot: KeySnapshot, animation?: KeyAnimationEffect): KeyRenderModel {
  if (snapshot.kind === "task") {
    return {
      kind: "task",
      taskPosition: snapshot.settings.taskPosition,
      titleFontSize: snapshot.appearance.titleFontSize,
      projectFontSize: snapshot.appearance.projectFontSize,
      timeFontSize: snapshot.appearance.timeFontSize,
      textAlignment: snapshot.appearance.textAlignment,
      borderEnabled: snapshot.appearance.borderEnabled,
      colors: taskKeyColors(snapshot.appearance),
      title: snapshot.title,
      ...(snapshot.projectLabel === undefined ? {} : { projectLabel: snapshot.projectLabel }),
      status: snapshot.status,
      activityLabel: snapshot.activityLabel,
      ...(snapshot.taskChangeStats === undefined ? {} : { taskChangeStats: snapshot.taskChangeStats }),
      ...(snapshot.queuedMessageCount === undefined ? {} : { queuedMessageCount: snapshot.queuedMessageCount }),
      ...(snapshot.hasOngoingGoal === undefined ? {} : { hasOngoingGoal: snapshot.hasOngoingGoal }),
      badgePosition: snapshot.appearance.badgePosition,
      badgeFontSize: snapshot.appearance.badgeFontSize,
      ...(animation === undefined ? {} : { animation }),
      offlineWarning: snapshot.offlineWarning,
    };
  }
  return {
    kind: snapshot.kind,
    taskPosition: snapshot.settings.taskPosition,
    titleFontSize: snapshot.appearance.titleFontSize,
    projectFontSize: snapshot.appearance.projectFontSize,
    timeFontSize: snapshot.appearance.timeFontSize,
    textAlignment: snapshot.appearance.textAlignment,
    borderEnabled: snapshot.appearance.borderEnabled,
    colors: taskKeyColors(snapshot.appearance),
    offlineWarning: snapshot.offlineWarning,
  };
}

export function renderSnapshotDataUrl(snapshot: KeySnapshot, animation?: KeyAnimationEffect): string {
  return toSvgDataUrl(renderKeySvg(renderModel(snapshot, animation)));
}

function isLiveWorking(snapshot: KeySnapshot): boolean {
  return snapshot.kind === "task"
    && snapshot.status === "working"
    && snapshot.liveFreshness === "fresh"
    && !snapshot.offlineWarning;
}

function transitionAnimation(previous: KeySnapshot | null, next: KeySnapshot): ActiveAnimation["kind"] | null {
  const sameLiveTask = previous?.kind === "task"
    && next.kind === "task"
    && previous.taskId === next.taskId
    && next.liveFreshness === "fresh"
    && !next.offlineWarning;
  if (!sameLiveTask || previous.kind !== "task" || next.kind !== "task") return null;
  if (next.status === "done" && previous.status !== "done") return "done-burst";
  if (previous.status === "working" && next.status === "idle") return "done-burst";
  return previous.status === "working" && (next.status === "waiting" || next.status === "confirmation")
    ? "status-flash"
    : null;
}

export class TaskKeyRenderQueue {
  readonly #port: StreamDeckKeyImagePort;
  readonly #sleep: (delayMs: number) => Promise<void>;
  readonly #setTimer: TaskKeyRenderQueueOptions["setTimer"];
  readonly #clearTimer: TaskKeyRenderQueueOptions["clearTimer"];
  #pendingCandidate: KeySnapshot | null = null;
  #pendingAnimationFrame: PendingAnimationFrame | null = null;
  #submittedCandidate: KeySnapshot | null = null;
  #displayedSnapshot: KeySnapshot | null = null;
  #processing = false;
  #disposed = false;
  #retryAttempt = 0;
  #imageUpdateFailed = false;
  #failureAlertShown = false;
  #animation: ActiveAnimation | null = null;
  #animationTimer: ReturnType<typeof setTimeout> | number | null = null;
  #animationGeneration = 0;
  #idleWaiters: (() => void)[] = [];
  #stateListeners = new Set<() => void>();

  constructor(port: StreamDeckKeyImagePort, options?: Partial<TaskKeyRenderQueueOptions>) {
    this.#port = port;
    this.#sleep = options?.sleep ?? defaultSleep;
    this.#setTimer = options?.setTimer ?? defaultSetTimer;
    this.#clearTimer = options?.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  get displayedSnapshot(): KeySnapshot | null {
    return this.#displayedSnapshot;
  }

  get submittedCandidate(): KeySnapshot | null {
    return this.#submittedCandidate;
  }

  get retryAttempt(): number {
    return this.#retryAttempt;
  }

  get imageUpdateFailed(): boolean {
    return this.#imageUpdateFailed;
  }

  onStateChange(listener: () => void): () => void {
    this.#stateListeners.add(listener);
    return () => this.#stateListeners.delete(listener);
  }

  enqueue(snapshot: KeySnapshot): void {
    if (this.#disposed) return;
    if (this.#pendingCandidate?.renderSignature === snapshot.renderSignature) return;
    if (this.#submittedCandidate?.renderSignature === snapshot.renderSignature && this.#pendingCandidate === null) return;
    if (this.#displayedSnapshot?.renderSignature === snapshot.renderSignature && this.#pendingCandidate === null) return;
    this.#cancelAnimation();
    this.#pendingCandidate = snapshot;
    this.#ensureProcessing();
  }

  whenIdle(): Promise<void> {
    if (!this.#processing && this.#pendingCandidate === null) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  dispose(): void {
    this.#disposed = true;
    this.#cancelAnimation();
    this.#pendingCandidate = null;
    this.#stateListeners.clear();
  }

  async #run(): Promise<void> {
    while (!this.#disposed && (this.#pendingCandidate !== null || this.#pendingAnimationFrame !== null)) {
      if (this.#pendingCandidate === null) {
        const frame = this.#pendingAnimationFrame;
        this.#pendingAnimationFrame = null;
        if (frame !== null) await this.#renderAnimationFrame(frame);
        continue;
      }
      const candidate = this.#pendingCandidate;
      this.#pendingCandidate = null;
      this.#submittedCandidate = candidate;
      const transition = transitionAnimation(this.#displayedSnapshot, candidate);
      const initialEffect: KeyAnimationEffect | undefined = transition === "done-burst"
        ? { kind: "done-burst", intensity: 1, phase: 0.04 }
        : transition === "status-flash"
          ? { kind: "status-flash", intensity: 1, phase: 0 }
        : isLiveWorking(candidate)
          ? { kind: "working-noise", intensity: 1, phase: 0 }
          : undefined;
      try {
        await this.#port.setImage(renderSnapshotDataUrl(candidate, initialEffect));
        this.#displayedSnapshot = candidate;
        this.#retryAttempt = 0;
        this.#imageUpdateFailed = false;
        this.#failureAlertShown = false;
        this.#emitStateChange();
        if (transition !== null) this.#beginAnimation(transition, candidate);
        else if (isLiveWorking(candidate)) this.#beginAnimation("working-noise", candidate);
      } catch {
        this.#imageUpdateFailed = true;
        this.#emitStateChange();
        if (!this.#failureAlertShown) {
          this.#failureAlertShown = true;
          await this.#port.showAlert().catch(() => undefined);
        }
        const delay = IMAGE_RETRY_DELAYS_MS[Math.min(this.#retryAttempt, IMAGE_RETRY_DELAYS_MS.length - 1)];
        this.#retryAttempt += 1;
        if (!this.#disposed) {
          this.#pendingCandidate ??= candidate;
          await this.#sleep(delay ?? 10_000);
        }
      } finally {
        this.#submittedCandidate = null;
      }
    }
    this.#processing = false;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  async #renderAnimationFrame(frame: PendingAnimationFrame): Promise<void> {
    if (!this.#animationMatches(frame)) return;
    try {
      await this.#port.setImage(renderSnapshotDataUrl(frame.snapshot, frame.effect));
    } catch {
      // Animation frames are decorative. A failed frame must not alert or replace the stable snapshot.
    }
    if (this.#animationMatches(frame)) this.#scheduleAnimationFrame();
  }

  #beginAnimation(kind: ActiveAnimation["kind"], snapshot: KeySnapshot): void {
    this.#cancelAnimation();
    const generation = this.#animationGeneration;
    this.#animation = { kind, snapshot, generation, frameIndex: 0 };
    this.#scheduleAnimationFrame();
  }

  #scheduleAnimationFrame(): void {
    const animation = this.#animation;
    if (animation === null || this.#disposed) return;
    const frames = animation.kind === "working-noise"
      ? WORKING_NOISE_FRAMES
      : animation.kind === "done-burst"
        ? DONE_BURST_FRAMES
        : STATUS_FLASH_FRAMES;
    if (animation.kind !== "working-noise" && animation.frameIndex >= frames.length) {
      this.#animation = null;
      return;
    }
    const frame = frames[animation.frameIndex % frames.length] ?? { intensity: 0, phase: 1 };
    animation.frameIndex += 1;
    const delay = animation.kind === "working-noise"
      ? WORKING_FRAME_DELAY_MS
      : animation.kind === "done-burst"
        ? DONE_BURST_FRAME_DELAY_MS
        : STATUS_FLASH_FRAME_DELAY_MS;
    this.#animationTimer = this.#setTimer(() => {
      this.#animationTimer = null;
      if (this.#animation !== animation || this.#disposed) return;
      this.#pendingAnimationFrame = {
        snapshot: animation.snapshot,
        effect: { kind: animation.kind, intensity: frame.intensity, phase: frame.phase },
        generation: animation.generation,
      };
      this.#ensureProcessing();
    }, delay);
  }

  #animationMatches(frame: PendingAnimationFrame): boolean {
    return this.#animation?.generation === frame.generation
      && this.#animation.snapshot.renderSignature === frame.snapshot.renderSignature
      && this.#displayedSnapshot?.renderSignature === frame.snapshot.renderSignature;
  }

  #cancelAnimation(): void {
    this.#animationGeneration += 1;
    if (this.#animationTimer !== null) this.#clearTimer(this.#animationTimer);
    this.#animationTimer = null;
    this.#animation = null;
    this.#pendingAnimationFrame = null;
  }

  #ensureProcessing(): void {
    if (this.#processing || this.#disposed) return;
    this.#processing = true;
    void this.#run();
  }

  #emitStateChange(): void {
    for (const listener of this.#stateListeners) listener();
  }
}
