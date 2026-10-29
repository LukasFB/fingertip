# Marketplace submission 1.2.0

## Short description

Codex and T3 Code at your fingertips. Live task status, direct thread navigation
and configurable model keys on Stream Deck for macOS.

## Description

Keep your coding agents in view without switching away from your work. Fingertip
Agent brings Codex and T3 Code tasks to Stream Deck, with live status colors,
project labels and one-press navigation to the matching thread.

Choose Codex or T3 Code for each key and mix both apps in the same profile. Pair
T3 once: every T3 Task, Model and Fast Mode key shares that connection, including
across profiles and plugin restarts.

Configure model keys with a model and supported thinking level from your selected
app. Press to apply the combination to the active existing thread; the confirmed
selection stays highlighted. Add a Fast Mode key where the provider supports it.

Customize shared task colors, project bars, typography and alignment. Choose
toast notifications, system sounds or custom audio for completed work and
approval requests, with independent volume and repeat controls.

Codex additionally supports task line-change statistics, queue badges and target
window selection. T3 currently assumes one window and uses the most recently
visited thread for model and Fast Mode changes. Available models and options
depend on your app and provider.

Requires macOS 13+, Stream Deck 7.1+, and Codex / ChatGPT for macOS or a local
T3 Code instance supporting orchestration protocol 2.

## Release notes

Added T3 Code alongside Codex for Task, Model and Fast Mode keys. T3 pairing is
shared globally, with a single connection status across all T3 keys. Includes
live task colors, direct thread navigation and dynamic model choices. Fixed
direct typing in Task Position and preserved live task state when T3 sends
repository-enrichment updates. T3 task ordering now follows the inbox and Working
shelf: newly completed tasks move ahead of running tasks, with pinned threads
keeping their order.

## Images to upload

All eight files are English-language 1920×960 PNGs:

1. `thumbnail.png` — Codex + T3 Code at your fingertips.
2. `gallery-1-live-status.png` — Live status for both apps.
3. `gallery-2-task-context.png` — Shared context; Codex-only badge distinctions.
4. `gallery-3-exact-task.png` — Direct thread navigation and key gestures.
5. `gallery-4-settings-general.png` — App selection and one shared T3 pairing.
6. `gallery-5-settings-appearance.png` — Shared colors and typography.
7. `gallery-6-settings-notifications.png` — Toast and audio settings.
8. `gallery-7-model-keys.png` — Current configurable model keys and Fast Mode.

The previous `gallery-7-model-selector.png` is superseded. Inspector images use
the current plugin HTML with example settings; task and model keys use the
production renderers. The hardware sources and approved perspective are preserved.

These files are prepared locally; nothing has been uploaded or published.
Use the validated 1.2.0.0 plugin package from `dist/1.2.0/` for this release.
Earlier submission files are historical and are not the current upload list.
