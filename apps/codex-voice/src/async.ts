export class Deferred<T> {
  readonly promise: Promise<T>
  resolve!: (value: T | PromiseLike<T>) => void
  reject!: (reason?: unknown) => void

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
  }
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = []
  #waiters: Array<Deferred<IteratorResult<T>>> = []
  #closed = false
  #error: unknown

  get length(): number {
    return this.#values.length
  }

  push(value: T): void {
    if (this.#closed) throw new Error('queue is closed')
    const waiter = this.#waiters.shift()
    if (waiter) {
      waiter.resolve({ value, done: false })
      return
    }
    this.#values.push(value)
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const waiter of this.#waiters.splice(0)) {
      waiter.resolve({ value: undefined, done: true })
    }
  }

  fail(error: unknown): void {
    if (this.#closed) return
    this.#closed = true
    this.#error = error
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error)
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        if (this.#values.length > 0) {
          return { value: this.#values.shift()!, done: false }
        }
        if (this.#error !== undefined) throw this.#error
        if (this.#closed) return { value: undefined, done: true }
        const waiter = new Deferred<IteratorResult<T>>()
        this.#waiters.push(waiter)
        return waiter.promise
      },
    }
  }
}

export function abortError(message = 'operation aborted'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? abortError()
}

export function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
