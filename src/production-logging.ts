interface ProductionLogger {
  setLevel(level: "info"): unknown;
}

export function lockProductionLogLevel(logger: ProductionLogger): void {
  logger.setLevel("info");
}
