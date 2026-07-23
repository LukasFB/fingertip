export class CatalogCompatibilityTracker {
  #fingerprint = "";
  #lastSignature = "";
  #failureCount = 0;
  #incompatible = false;

  get incompatible(): boolean {
    return this.#incompatible;
  }

  observeFingerprint(fingerprint: string): void {
    if (fingerprint === this.#fingerprint) return;
    this.#fingerprint = fingerprint;
    this.#lastSignature = "";
    this.#failureCount = 0;
    this.#incompatible = false;
  }

  recordFailure(signature: string): boolean {
    if (signature === this.#lastSignature) this.#failureCount += 1;
    else {
      this.#lastSignature = signature;
      this.#failureCount = 1;
    }
    if (this.#failureCount >= 3) this.#incompatible = true;
    return this.#incompatible;
  }

  clearFailures(): void {
    this.#lastSignature = "";
    this.#failureCount = 0;
    this.#incompatible = false;
  }

  recordSuccess(): void {
    this.clearFailures();
  }
}
