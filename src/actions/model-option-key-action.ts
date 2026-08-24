import streamDeck, {
  action,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import {
  normalizeModelSelection,
  type ModelSelection,
} from "../models/model-selection.ts";
import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";

type ModelOptionSettings = JsonObject & Partial<Pick<ModelSelection, "family" | "effort">>;

@action({ UUID: "com.lukas-bhm.fingertip.model-option" })
export class ModelOptionKeyAction extends SingletonAction<ModelOptionSettings> {
  readonly #selections = new Map<string, ModelSelection>();

  constructor(readonly runtime: FingertipRuntime) { super(); }

  override async onWillAppear(event: WillAppearEvent<ModelOptionSettings>): Promise<void> {
    if (!event.action.isKey()) return;
    const selection = normalizeModelSelection(event.payload.settings);
    if (selection === null) {
      await event.action.showAlert().catch(() => undefined);
      return;
    }
    this.#selections.set(event.action.id, selection);
    this.runtime.attachModelOptionAction(event.action, selection);
  }

  override onWillDisappear(event: WillDisappearEvent<ModelOptionSettings>): void {
    this.#selections.delete(event.action.id);
    this.runtime.detachModelOptionAction(event.action.id);
  }

  override async onKeyDown(event: KeyDownEvent<ModelOptionSettings>): Promise<void> {
    const selection = this.#selections.get(event.action.id)
      ?? normalizeModelSelection(event.payload.settings);
    if (selection === null || selection === undefined
      || !await this.runtime.pressModelSelection(selection)) {
      await event.action.showAlert().catch(() => undefined);
      return;
    }
    await streamDeck.profiles.switchToProfile(event.action.device.id).catch(async () => {
      await event.action.showAlert().catch(() => undefined);
    });
  }
}
