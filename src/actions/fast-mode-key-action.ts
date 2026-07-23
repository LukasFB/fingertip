import {
  action,
  type KeyDownEvent,
  type PropertyInspectorDidAppearEvent,
  type PropertyInspectorDidDisappearEvent,
  SingletonAction,
  type WillAppearEvent,
  type WillDisappearEvent,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

import type { FingertipRuntime } from "../runtime/fingertip-runtime.ts";

type FastModeSettings = JsonObject;

function containsLegacyTaskTarget(settings: JsonObject): boolean {
  return "taskPosition" in settings || "taskSource" in settings || "version" in settings;
}

@action({ UUID: "com.lukas-bhm.fingertip.fast-mode" })
export class FastModeKeyAction extends SingletonAction<FastModeSettings> {
  constructor(readonly runtime: FingertipRuntime) { super(); }

  override async onWillAppear(event: WillAppearEvent<FastModeSettings>): Promise<void> {
    if (!event.action.isKey()) return;
    if (containsLegacyTaskTarget(event.payload.settings)) await event.action.setSettings({});
    this.runtime.attachFastModeAction(event.action);
  }

  override onWillDisappear(event: WillDisappearEvent<FastModeSettings>): void {
    this.runtime.detachFastModeAction(event.action.id);
  }

  override async onKeyDown(event: KeyDownEvent<FastModeSettings>): Promise<void> {
    await this.runtime.pressFastMode(event.action.id);
  }

  override onPropertyInspectorDidAppear(event: PropertyInspectorDidAppearEvent<FastModeSettings>): void {
    this.runtime.fastModePropertyInspectorDidAppear(event.action.id);
  }

  override onPropertyInspectorDidDisappear(event: PropertyInspectorDidDisappearEvent<FastModeSettings>): void {
    this.runtime.fastModePropertyInspectorDidDisappear(event.action.id);
  }
}
