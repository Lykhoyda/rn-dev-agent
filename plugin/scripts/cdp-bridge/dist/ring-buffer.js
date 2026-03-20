export class RingBuffer {
    buffer;
    cursor = 0;
    count = 0;
    capacity;
    constructor(capacity) {
        this.capacity = capacity;
        this.buffer = new Array(capacity);
    }
    push(item) {
        this.buffer[this.cursor] = item;
        this.cursor = (this.cursor + 1) % this.capacity;
        if (this.count < this.capacity)
            this.count++;
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
    clear() {
        this.buffer = new Array(this.capacity);
        this.cursor = 0;
        this.count = 0;
    }
    get size() {
        return this.count;
    }
}
