import {
  FAST_MODE_ANIMATION_FPS,
  FAST_MODE_ANIMATION_FRAME_COUNT,
  renderFastModeKeyDataUrl,
  type FastModeVisualState,
} from "../rendering/utility-key-renderer.ts";

export interface FastModeKeyImagePort {
  setImage(image: string): Promise<void>;
}

export interface FastModeKeyAnimatorOptions {
  setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> | number;
  clearTimer(timer: ReturnType<typeof setTimeout> | number): void;
}

export interface FastModeKeyPresentation {
  readonly signature: string;
  readonly state: FastModeVisualState;
  readonly offline: boolean;
}

interface PendingImage {
  readonly generation: number;
  readonly image: string;
  readonly stable: boolean;
}

function defaultSetTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(callback, delayMs);
  timer.unref();
  return timer;
}

export class FastModeKeyAnimator {
  readonly #port: FastModeKeyImagePort;
  readonly #setTimer: FastModeKeyAnimatorOptions["setTimer"];
  readonly #clearTimer: FastModeKeyAnimatorOptions["clearTimer"];
  #signature = "";
  #generation = 0;
  #frameIndex = 0;
  #timer: ReturnType<typeof setTimeout> | number | null = null;
  #pendingImage: PendingImage | null = null;
  #imageInFlight = false;
  #disposed = false;

  constructor(port: FastModeKeyImagePort, options?: Partial<FastModeKeyAnimatorOptions>) {
    this.#port = port;
    this.#setTimer = options?.setTimer ?? defaultSetTimer;
    this.#clearTimer = options?.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  render(presentation: FastModeKeyPresentation): void {
    if (this.#disposed || presentation.signature === this.#signature) return;
    this.#signature = presentation.signature;
    this.#cancelAnimation();
    const generation = this.#generation;
    if (presentation.state === "fast" && !presentation.offline) {
      this.#frameIndex = 0;
      this.#queueImage({
        generation,
        image: renderFastModeKeyDataUrl({
          state: presentation.state,
          offline: presentation.offline,
          animationPhase: 0,
        }),
        stable: false,
      });
      this.#scheduleFrame(presentation, generation);
      return;
    }
    this.#queueImage({
      generation,
      image: renderFastModeKeyDataUrl(presentation),
      stable: true,
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#signature = "";
    this.#cancelAnimation();
    this.#pendingImage = null;
  }

  #scheduleFrame(presentation: FastModeKeyPresentation, generation: number): void {
    if (this.#disposed || generation !== this.#generation) return;
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      if (this.#disposed || generation !== this.#generation) return;
      this.#frameIndex = (this.#frameIndex + 1) % FAST_MODE_ANIMATION_FRAME_COUNT;
      this.#queueImage({
        generation,
        image: renderFastModeKeyDataUrl({
          state: presentation.state,
          offline: presentation.offline,
          animationPhase: this.#frameIndex / FAST_MODE_ANIMATION_FRAME_COUNT,
        }),
        stable: false,
      });
      this.#scheduleFrame(presentation, generation);
    }, 1_000 / FAST_MODE_ANIMATION_FPS);
  }

  #cancelAnimation(): void {
    this.#generation += 1;
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#pendingImage = null;
  }

  #queueImage(image: PendingImage): void {
    if (this.#disposed) return;
    this.#pendingImage = image;
    this.#drainImages();
  }

  #drainImages(): void {
    if (this.#disposed || this.#imageInFlight || this.#pendingImage === null) return;
    const image = this.#pendingImage;
    this.#pendingImage = null;
    this.#imageInFlight = true;
    void this.#port.setImage(image.image).catch(() => {
      if (image.stable && image.generation === this.#generation) this.#signature = "";
    }).finally(() => {
      this.#imageInFlight = false;
      if (!this.#disposed) this.#drainImages();
    });
  }
}
