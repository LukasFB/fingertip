import type { JsonValue } from "@elgato/utils";
import type { FingertipRuntime } from "./fingertip-runtime.ts";
import { T3Runtime } from "../t3/t3-runtime.ts";
import type { TaskNotifier } from "../notifications/mac-task-notifier.ts";
import type { TaskKeySettings } from "../settings/task-key-settings.ts";
import type { ModelKeySettings } from "../settings/model-key-settings.ts";

type TaskPort = Parameters<FingertipRuntime["attachAction"]>[0];
type ModelPort = Parameters<FingertipRuntime["attachModelKeyAction"]>[0];
export class RuntimeRouter {
  readonly t3: T3Runtime;
  #sources = new Map<string, boolean>();
  #taskInspectors = new Set<string>();
  #modelInspectors = new Set<string>();
  readonly codex: FingertipRuntime;
  constructor(codex: FingertipRuntime, send: (payload: JsonValue) => Promise<void>, notifier: TaskNotifier) {
    this.codex = codex;
    this.t3 = new T3Runtime(send, notifier);
  }
  #runtime(id: string) { return this.#sources.get(id) ? this.t3 : this.codex; }
  normalizeSettings(value: unknown) { return this.codex.normalizeSettings(value); }
  attachAction(action: TaskPort, settings: TaskKeySettings): void {
    this.#sources.set(action.id, settings.backend === "t3"); this.#runtime(action.id).attachAction(action, settings);
  }
  updateSettings(action: TaskPort, settings: TaskKeySettings): void {
    if (this.#sources.get(action.id) !== (settings.backend === "t3")) {
      const old = this.#runtime(action.id); old.propertyInspectorDidDisappear(action.id); old.detachAction(action.id);
      this.attachAction(action, settings);
      if (this.#taskInspectors.has(action.id)) this.#runtime(action.id).propertyInspectorDidAppear(action.id);
    } else this.#runtime(action.id).updateSettings(action, settings);
  }
  detachAction(id: string): void { this.#runtime(id).detachAction(id); this.#sources.delete(id); this.#taskInspectors.delete(id); }
  keyDown(id: string): void { this.#runtime(id).keyDown(id); }
  keyUp(id: string): Promise<void> { return this.#runtime(id).keyUp(id); }
  propertyInspectorDidAppear(id: string): void { this.#taskInspectors.add(id); this.#runtime(id).propertyInspectorDidAppear(id); }
  propertyInspectorDidDisappear(id: string): void { this.#taskInspectors.delete(id); this.#runtime(id).propertyInspectorDidDisappear(id); }
  attachModelKeyAction(action: ModelPort, settings: ModelKeySettings): void {
    this.#sources.set(action.id, settings.backend === "t3"); this.#runtime(action.id).attachModelKeyAction(action, settings);
  }
  updateModelKeySettings(action: ModelPort, settings: ModelKeySettings): void {
    if (this.#sources.get(action.id) !== (settings.backend === "t3")) {
      const old = this.#runtime(action.id); old.modelPropertyInspectorDidDisappear(action.id); old.detachModelKeyAction(action.id);
      this.attachModelKeyAction(action, settings);
      if (this.#modelInspectors.has(action.id)) this.#runtime(action.id).modelPropertyInspectorDidAppear(action.id);
    } else this.#runtime(action.id).updateModelKeySettings(action, settings);
  }
  detachModelKeyAction(id: string): void { this.#runtime(id).detachModelKeyAction(id); this.#sources.delete(id); this.#modelInspectors.delete(id); }
  pressModelKey(id: string): Promise<boolean> { return this.#runtime(id).pressModelKey(id); }
  modelPropertyInspectorDidAppear(id: string): void { this.#modelInspectors.add(id); this.#runtime(id).modelPropertyInspectorDidAppear(id); }
  modelPropertyInspectorDidDisappear(id: string): void { this.#modelInspectors.delete(id); this.#runtime(id).modelPropertyInspectorDidDisappear(id); }
  refreshModelCatalog(): void {
    if ([...this.#sources.values()].includes(false)) void this.codex.refreshModelCatalog();
    if ([...this.#sources.values()].includes(true)) void this.t3.refreshModelCatalog();
  }
  attachFastModeAction(action: ModelPort, backend?: unknown): void {
    if (this.#sources.has(action.id)) this.#runtime(action.id).detachFastModeAction(action.id);
    this.#sources.set(action.id, backend === "t3"); this.#runtime(action.id).attachFastModeAction(action);
  }
  detachFastModeAction(id: string): void { this.#runtime(id).detachFastModeAction(id); this.#sources.delete(id); }
  pressFastMode(id: string): Promise<boolean> { return this.#runtime(id).pressFastMode(); }
  retryNow(): void { if ([...this.#sources.values()].includes(false)) this.codex.retryNow(); this.t3.retryNow(); }
  updateAppearance(value: unknown): void { this.codex.updateAppearance(value); this.t3.updateAppearance(value); }
  applicationDidLaunch(): void { this.codex.applicationDidLaunch(); }
  applicationDidTerminate(): void { this.codex.applicationDidTerminate(); }
  systemDidWake(): void { this.codex.systemDidWake(); this.t3.retryNow(); }
  shutdown(): void { this.codex.shutdown(); this.t3.shutdown(); }
  async importCustomSound(...args: Parameters<FingertipRuntime["importCustomSound"]>) {
    await this.codex.importCustomSound(...args); await this.t3.refreshCustomSounds();
  }
  previewSound(...args: Parameters<FingertipRuntime["previewSound"]>) { return this.codex.previewSound(...args); }
  pairT3(link: string, serverAddress?: string): void { void this.t3.pair(link, serverAddress); }
}
