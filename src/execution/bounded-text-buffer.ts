export interface BoundedTextResult {
  readonly text: string;
  readonly truncated: boolean;
  readonly originalChars: number;
}

/** Keeps bounded head and tail samples without retaining the complete process output. */
export class BoundedTextBuffer {
  readonly #maxChars: number;
  #head = '';
  #tail = '';
  #originalChars = 0;

  public constructor(maxChars: number) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
      throw new RangeError('maxChars must be a positive safe integer.');
    }
    this.#maxChars = maxChars;
  }

  public append(chunk: string): void {
    if (chunk.length === 0) return;

    this.#originalChars += chunk.length;
    if (this.#head.length < this.#maxChars) {
      this.#head = (this.#head + chunk).slice(0, this.#maxChars);
    }
    this.#tail = (this.#tail + chunk).slice(-this.#maxChars);
  }

  public finish(): BoundedTextResult {
    if (this.#originalChars <= this.#maxChars) {
      return {
        text: this.#head,
        truncated: false,
        originalChars: this.#originalChars,
      };
    }

    const marker = `\n... [truncated ${this.#originalChars - this.#maxChars} or more chars] ...\n`;
    if (marker.length >= this.#maxChars) {
      return {
        text: marker.slice(0, this.#maxChars),
        truncated: true,
        originalChars: this.#originalChars,
      };
    }

    const availableChars = this.#maxChars - marker.length;
    const headChars = Math.ceil(availableChars / 2);
    const tailChars = availableChars - headChars;
    return {
      text: this.#head.slice(0, headChars) + marker + this.#tail.slice(-tailChars),
      truncated: true,
      originalChars: this.#originalChars,
    };
  }
}
