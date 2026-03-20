export declare class RingBuffer<T> {
    private buffer;
    private cursor;
    private count;
    private readonly capacity;
    constructor(capacity: number);
    push(item: T): void;
    getLast(n: number): T[];
    filter(predicate: (item: T) => boolean): T[];
    findLast(predicate: (item: T) => boolean): T | undefined;
    clear(): void;
    get size(): number;
}
