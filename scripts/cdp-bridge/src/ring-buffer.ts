export class RingBuffer<T> {
  private buffer: T[] = [];
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  push(item: T): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(item);
  }

  getAll(): T[] {
    return [...this.buffer];
  }

  getLast(n: number): T[] {
    return this.buffer.slice(-n);
  }

  findLast(predicate: (item: T) => boolean): T | undefined {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (predicate(this.buffer[i])) return this.buffer[i];
    }
    return undefined;
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.buffer.filter(predicate);
  }

  clear(): void {
    this.buffer = [];
  }

  get size(): number {
    return this.buffer.length;
  }
}
