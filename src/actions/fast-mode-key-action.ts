import {
  action,
  type KeyDownEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";

@action({ UUID: "com.lukas-bhm.fingertip.fast-mode" })
export class FastModeKeyAction extends SingletonAction<JsonObject> {
  constructor(readonly runtime: FingertipRuntime) { super(); }

  override onWillAppear(event: WillAppearEvent<JsonObject>): void {
    if (event.action.isKey()) this.runtime.attachFastModeAction(event.action);
  }

  override onWillDisappear(event: WillDisappearEvent<JsonObject>): void {
    this.runtime.detachFastModeAction(event.action.id);
  }

  override async onKeyDown(event: KeyDownEvent<JsonObject>): Promise<void> {
    if (!await this.runtime.pressFastMode()) {
      await event.action.showAlert().catch(() => undefined);
    }
  }
}
