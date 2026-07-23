import { watch } from "node:fs";
import path from "node:path";

export function watchWorkspaceMetadataFile(
  filePath: string,
  onChange: () => void,
): () => void {
  const directory = path.dirname(filePath);
  const target = path.basename(filePath);
  const watcher = watch(directory, { persistent: false }, (_event, filename) => {
    if (filename === null || filename.toString() === target) onChange();
  });
  watcher.on("error", () => watcher.close());
  return () => watcher.close();
}
