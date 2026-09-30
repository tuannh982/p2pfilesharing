import { describe, expect, it } from 'vitest';
import { DownloadQueue } from './downloadQueue';

describe('DownloadQueue', () => {
  it('hands back files in the order they were queued', () => {
    const queue = new DownloadQueue();
    queue.enqueue(2);
    queue.enqueue(0);
    queue.enqueue(5);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(0);
    expect(queue.dequeue()).toBe(5);
    expect(queue.dequeue()).toBeNull();
  });

  it('ignores a file that is already queued, so a second click cannot duplicate it', () => {
    const queue = new DownloadQueue();
    expect(queue.enqueue(1)).toBe(true);
    expect(queue.enqueue(1)).toBe(false);
    expect(queue.size()).toBe(1);
    expect(queue.pending()).toEqual([1]);
  });

  it('re-queues a file that was taken off the queue', () => {
    const queue = new DownloadQueue();
    queue.enqueue(1);
    expect(queue.cancel(1)).toBe(true);
    expect(queue.has(1)).toBe(false);
    expect(queue.enqueue(1)).toBe(true);
    expect(queue.pending()).toEqual([1]);
  });

  it('cancels only the file asked for', () => {
    const queue = new DownloadQueue();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);
    expect(queue.cancel(2)).toBe(true);
    expect(queue.pending()).toEqual([1, 3]);
    expect(queue.cancel(2)).toBe(false);
  });

  it('empties on clear and reports its size', () => {
    const queue = new DownloadQueue();
    queue.enqueue(0);
    queue.enqueue(1);
    expect(queue.size()).toBe(2);
    queue.clear();
    expect(queue.size()).toBe(0);
    expect(queue.dequeue()).toBeNull();
  });

  it('dequeues file zero, which is falsy', () => {
    const queue = new DownloadQueue();
    queue.enqueue(0);
    expect(queue.dequeue()).toBe(0);
    expect(queue.dequeue()).toBeNull();
  });

  it('does not mutate the array it hands out for rendering', () => {
    const queue = new DownloadQueue();
    queue.enqueue(4);
    const view = queue.pending();
    queue.enqueue(7);
    expect(view).toEqual([4]);
  });

  it('hands out a copy, so a caller cannot push into the queue itself', () => {
    const queue = new DownloadQueue();
    queue.enqueue(4);
    (queue.pending() as number[]).push(7);
    expect(queue.pending()).toEqual([4]);
    expect(queue.size()).toBe(1);
  });
});
