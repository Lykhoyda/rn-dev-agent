export class RingBuffer {
    buffer;
    cursor = 0;
    count = 0;
    capacity;
    indexKey;
    index;
    constructor(capacity, options) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
        this.indexKey = options?.indexKey;
        this.index = options?.indexKey ? new Map() : null;
    }
    push(item) {
        if (this.index && this.buffer[this.cursor] !== undefined) {
            const evicted = this.buffer[this.cursor];
            const evictedKey = this.indexKey(evicted);
            if (evictedKey !== undefined && this.index.get(evictedKey) === evicted) {
                this.index.delete(evictedKey);
            }
        }
        this.buffer[this.cursor] = item;
        this.cursor = (this.cursor + 1) % this.capacity;
        if (this.count < this.capacity)
            this.count++;
        if (this.index) {
            const key = this.indexKey(item);
            if (key !== undefined)
                this.index.set(key, item);
        }
    }
    getLast(n) {
        const result = [];
        const total = Math.min(n, this.count);
        for (let i = 0; i < total; i++) {
            const idx = (this.cursor - total + i + this.capacity) % this.capacity;
            const item = this.buffer[idx];
            if (item !== undefined)
                result.push(item);
        }
        return result;
    }
    filter(predicate) {
        const all = this.getLast(this.count);
        return all.filter(predicate);
    }
    findLast(predicate) {
        for (let i = 0; i < this.count; i++) {
            const idx = (this.cursor - 1 - i + this.capacity) % this.capacity;
            const item = this.buffer[idx];
            if (item !== undefined && predicate(item))
                return item;
        }
        return undefined;
    }
    getByKey(key) {
        return this.index?.get(key);
    }
    clear() {
        this.buffer = new Array(this.capacity);
        this.cursor = 0;
        this.count = 0;
        this.index?.clear();
    }
    get size() {
        return this.count;
    }
}
