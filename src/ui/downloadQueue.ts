export class DownloadQueue {
  private readonly items: number[] = [];

  enqueue(index: number): boolean {
    if (this.items.includes(index)) return false;
    this.items.push(index);
    return true;
  }

  dequeue(): number | null {
    // `??` rather than `||`: file index 0 is falsy, so `||` would report a
    // queue holding only the first file as empty.
    return this.items.shift() ?? null;
  }

  cancel(index: number): boolean {
    const at = this.items.indexOf(index);
    if (at < 0) return false;
    this.items.splice(at, 1);
    return true;
  }

  clear(): void {
    this.items.length = 0;
  }

  has(index: number): boolean {
    return this.items.includes(index);
  }

  size(): number {
    return this.items.length;
  }

  pending(): readonly number[] {
    return [...this.items];
  }
}
