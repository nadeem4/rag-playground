/**
 * A stand-in for the browser's ResizeObserver in tests: it reports
 * `FakeResizeObserver.width` when it starts observing, and again when a test
 * calls `report`. `silent` makes it never call back, as a real observer has
 * not yet done on the first paint.
 */
export class FakeResizeObserver {
  static all: FakeResizeObserver[] = []
  static width = 1440
  static silent = false
  disconnected = false
  private cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb
    FakeResizeObserver.all.push(this)
  }
  observe() {
    if (!FakeResizeObserver.silent) this.report(FakeResizeObserver.width)
  }
  report(width: number) {
    this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true
  }
  static reset() {
    FakeResizeObserver.all = []
    FakeResizeObserver.width = 1440
    FakeResizeObserver.silent = false
  }
}
