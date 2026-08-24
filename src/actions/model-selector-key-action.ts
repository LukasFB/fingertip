import streamDeck, {
  action,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";

const MODEL_SELECTOR_PROFILE = "profiles/codex-model-selector";

@action({ UUID: "com.lukas-bhm.fingertip.model-selector" })
export class ModelSelectorKeyAction extends SingletonAction<JsonObject> {
  constructor(readonly runtime: FingertipRuntime) { super(); }

  override onWillAppear(event: WillAppearEvent<JsonObject>): void {
    if (event.action.isKey()) this.runtime.attachModelSelectorAction(event.action);
  }

  override onWillDisappear(event: WillDisappearEvent<JsonObject>): void {
    this.runtime.detachModelSelectorAction(event.action.id);
  }

  override async onKeyDown(event: KeyDownEvent<JsonObject>): Promise<void> {
    try {
      if (!await this.runtime.prepareModelSelector()) {
        await event.action.showAlert().catch(() => undefined);
        return;
      }
      await streamDeck.profiles.switchToProfile(event.action.device.id, MODEL_SELECTOR_PROFILE);
    } catch {
      await event.action.showAlert().catch(() => undefined);
    }
  }
}
