import {
  action,
  type KeyDownEvent,
  type DidReceiveSettingsEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";

@action({ UUID: "com.lukas-bhm.fingertip.fast-mode" })
export class FastModeKeyAction extends SingletonAction<JsonObject> {
  constructor(readonly runtime: { attachFastModeAction(action: Parameters<FingertipRuntime["attachFastModeAction"]>[0], backend?: unknown): void; detachFastModeAction(id: string): void; pressFastMode(id: string): Promise<boolean> }) { super(); }

  override onWillAppear(event: WillAppearEvent<JsonObject>): void {
    if (event.action.isKey()) this.runtime.attachFastModeAction(event.action, event.payload.settings.backend);
  }

  override onDidReceiveSettings(event: DidReceiveSettingsEvent<JsonObject>): void {
    if (event.action.isKey()) this.runtime.attachFastModeAction(event.action, event.payload.settings.backend);
  }

  override onWillDisappear(event: WillDisappearEvent<JsonObject>): void {
    this.runtime.detachFastModeAction(event.action.id);
  }

  override async onKeyDown(event: KeyDownEvent<JsonObject>): Promise<void> {
    if (!await this.runtime.pressFastMode(event.action.id)) {
      await event.action.showAlert().catch(() => undefined);
    }
  }
}
