export class RingBuffer<T> {
  private buffer: (T | undefined)[];
  private cursor = 0;
  private count = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(item: T): void {
    this.buffer[this.cursor] = item;
    this.cursor = (this.cursor + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  getLast(n: number): T[] {
    const result: T[] = [];
    const total = Math.min(n, this.count);
    for (let i = 0; i < total; i++) {
      const idx = (this.cursor - total + i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined) result.push(item);
    }
    return result;
  }

  filter(predicate: (item: T) => boolean): T[] {
    const all = this.getLast(this.count);
    return all.filter(predicate);
  }

  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = 0; i < this.count; i++) {
      const idx = (this.cursor - 1 - i + this.capacity) % this.capacity;
      const item = this.buffer[idx];
      if (item !== undefined && predicate(item)) return item;
    }
    return undefined;
  }

  clear(): void {
    this.buffer = new Array(this.capacity);
    this.cursor = 0;
    this.count = 0;
  }

  get size(): number {
    return this.count;
  }
}
