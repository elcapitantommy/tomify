// A small in-memory IndexedDB for tests (jsdom has none): object stores with a keyPath, and
// get/getAll/put/delete in transactions that commit together or abort together.
// `failPut` lets a test make a write fail, the way a full disk does.
type Data = Map<IDBValidKey, unknown>
interface StoreDef { keyPath: string; data: Data }
interface Db { version: number; stores: Map<string, StoreDef> }

class FakeRequest<T = unknown> {
  result: T = undefined as T
  error: DOMException | null = null
  onsuccess: ((event: Event) => void) | null = null
  onerror: ((event: Event) => void) | null = null
  onupgradeneeded: ((event: Event) => void) | null = null
}

type Op = { store: string; run(data: Data, def: StoreDef): unknown; request: FakeRequest }

class FakeObjectStore {
  constructor(private readonly tx: FakeTransaction, private readonly name: string) {}
  private queue(run: Op['run']) { const request = new FakeRequest(); this.tx.ops.push({ store: this.name, run, request }); return request }
  get(key: IDBValidKey) { return this.queue((data) => data.get(key)) }
  getAll() { return this.queue((data) => [...data.values()]) }
  put(value: Record<string, unknown>) {
    const failure = this.tx.factory.failPut?.(this.name, value)
    return this.queue((data, def) => {
      if (failure) throw failure
      const key = value[def.keyPath] as IDBValidKey
      data.set(key, { ...value })
      return key
    })
  }
  delete(key: IDBValidKey) { return this.queue((data) => { data.delete(key) }) }
}

class FakeTransaction {
  ops: Op[] = []
  error: DOMException | null = null
  oncomplete: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private aborted = false
  constructor(readonly factory: FakeIndexedDb, private readonly db: Db, private readonly names: string[]) {
    names.forEach((name) => { if (!db.stores.has(name)) throw new DOMException(`No store ${name}`, 'NotFoundError') })
    setTimeout(() => this.finish(), 0)
  }
  objectStore(name: string) { if (!this.names.includes(name)) throw new DOMException(`${name} is not in this transaction`, 'NotFoundError'); return new FakeObjectStore(this, name) }
  abort() { this.aborted = true }
  private finish() {
    if (this.aborted) { this.error = new DOMException('Aborted', 'AbortError'); this.onabort?.(); return }
    const staged = new Map(this.names.map((name) => [name, new Map(this.db.stores.get(name)!.data)]))
    for (const op of this.ops) {
      try {
        op.request.result = op.run(staged.get(op.store)!, this.db.stores.get(op.store)!)
        op.request.onsuccess?.(new Event('success'))
      } catch (error) {
        const failure = error instanceof DOMException ? error : new DOMException(String(error), 'UnknownError')
        op.request.error = failure
        op.request.onerror?.(new Event('error'))
        this.error = failure
        this.onerror?.()
        this.onabort?.()
        return
      }
    }
    staged.forEach((data, name) => { this.db.stores.get(name)!.data = data })
    this.oncomplete?.()
  }
}

class FakeDatabase {
  onversionchange: (() => void) | null = null
  constructor(private readonly factory: FakeIndexedDb, private readonly db: Db) {}
  get objectStoreNames() { const names = [...this.db.stores.keys()]; return { contains: (name: string) => names.includes(name), length: names.length } }
  createObjectStore(name: string, options: { keyPath: string }) { this.db.stores.set(name, { keyPath: options.keyPath, data: new Map() }) }
  transaction(names: string | string[]) { return new FakeTransaction(this.factory, this.db, Array.isArray(names) ? names : [names]) }
  close() {}
}

export class FakeIndexedDb {
  readonly databases = new Map<string, Db>()
  failPut: ((store: string, value: Record<string, unknown>) => DOMException | null) | null = null
  open(name: string, version = 1) {
    const request = new FakeRequest<FakeDatabase>()
    setTimeout(() => {
      let db = this.databases.get(name)
      const upgrade = !db || db.version < version
      if (!db) { db = { version, stores: new Map() }; this.databases.set(name, db) }
      db.version = version
      request.result = new FakeDatabase(this, db)
      if (upgrade) request.onupgradeneeded?.(new Event('upgradeneeded'))
      request.onsuccess?.(new Event('success'))
    }, 0)
    return request
  }
  // What a store holds, for assertions.
  contents(name: string, store: string) { return this.databases.get(name)?.stores.get(store)?.data ?? new Map() }
}
