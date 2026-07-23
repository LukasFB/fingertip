const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function milliseconds(timestamp: number): number {
  return timestamp < 1_000_000_000_000 ? timestamp * 1_000 : timestamp;
}

export function formatTaskActivityTime(activityAt: number, now: number): string {
  const elapsed = Math.max(0, now - milliseconds(activityAt));
  if (elapsed < MINUTE) return "just now";
  if (elapsed < HOUR) {
    const minutes = Math.floor(elapsed / MINUTE);
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`;
  }
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR);
    const minutes = Math.floor((elapsed % HOUR) / MINUTE);
    return `${hours}:${String(minutes).padStart(2, "0")} ${hours === 1 ? "hour" : "hours"} ago`;
  }
  if (elapsed < 2 * DAY) return "yesterday";
  return `${Math.floor(elapsed / DAY)} days ago`;
}
