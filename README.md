# Fingertip Agent

Fingertip Agent brings your local ChatGPT Codex tasks to Stream Deck. Follow
live task status at a glance, preserve the familiar sidebar order, and jump
straight to the exact task you need with a single press.

Requirements: macOS 13 or newer, Stream Deck 7.1 or newer, ChatGPT for macOS,
Node.js 24, and a coding agent with terminal access.

## Install

Give your coding agent this prompt from the repository directory:

> Install Fingertip Agent on this Mac. First verify the requirements above. Then run
> `npm ci`, `npm run check`, and `npm run build`. Validate
> `com.lukas-bhm.fingertip.sdPlugin` with the Stream Deck CLI, link that plugin
> directory into Stream Deck, and restart the plugin. Do not modify the source.
> Tell me about any failed check or macOS permission prompt.

Fingertip Agent uses ChatGPT's private, unsupported desktop IPC protocol. A future
ChatGPT update may require a compatibility update.

## License

[MIT](LICENSE)
