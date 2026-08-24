import streamDeck, {
  action,
  type KeyDownEvent,
  SingletonAction,
} from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";

@action({ UUID: "com.lukas-bhm.fingertip.model-selector-back" })
export class ModelSelectorBackKeyAction extends SingletonAction<JsonObject> {
  override async onKeyDown(event: KeyDownEvent<JsonObject>): Promise<void> {
    await streamDeck.profiles.switchToProfile(event.action.device.id).catch(async () => {
      await event.action.showAlert().catch(() => undefined);
    });
  }
}
