import { useCallback, useRef } from 'react'
import useSyncExternalStoreExports from 'use-sync-external-store/shim'
import { isStore, subscribe } from 'valtio'

const { useSyncExternalStore } = useSyncExternalStoreExports
const GET_ORIGINAL_SYMBOL = Symbol()

/**
 * Provides a component with usage-based tracking of changes to a store.
 *
 * Instead of using a snapshot, and compare-proxying against that, we compare-proxy
 * against the store itself, which means to detect changes we can't use the
 * `isChanged` from proxy-compare, but instead track both accessed + mutations,
 * and use the intersection of those to determine if we've had a dirty read.
 *
 * Current pros/cons:
 *
 * - Pro: removes complexity of separate snap/store
 * - Pro: removes need to "loop over snapshots, but pass the store"
 * - Pro: (improvement over the `add-use-store` v1 branch) invalidates the
 *     compare-proxy for each store on change, so should identity should
 *     intuitively "just work" with deps arrays/React.memos
 * - Con: Currently only _directly_ modified stores have their identity changed,
 *     and we don't "walk up" and invalid parent compare-proxies like snapshot
 *     does. Would be possible just haven't tried yet.
 *
 * @example
 * function MyComponent() {
 *  const store = useStore(props.proxy)
 *  return (
 *    <>
 *      <div onClick={() => store.count++}>
 *        {store.count}
 *      </div>
 *    </>
 *  );
 */
export function useStore<T extends object>(store: T): T {
  // If we were passed one of our own access proxies, i.e. a child component
  // using `useStore`, unwrap it to establish the child component's own tracking
  store = getOriginalObject(store)

  const ref = useRef<UseStoreAdmin | null>(null)
  if (!ref.current) {
    // ...what if store changes?
    ref.current = new UseStoreAdmin(store)
  }
  const { current } = ref

  // We're going to render our JSX now, so assume we're up-to-date, and start/reset
  // recording all changes + all accesses from here on.
  current.beginRender()

  return useSyncExternalStore(
    useCallback(
      (onStoreChange) => {
        current.onStoreChange = onStoreChange
        return () => Object.values(current.stats).forEach((s) => s.unsub())
      },
      [current]
    ),
    () => current.getSnapshot() as T,
    () => store
  )
}

// Instead of lots of refs, we use a single ref with our bag of state.
class UseStoreAdmin {
  onStoreChange = () => {}
  stats = new Map<object, StoreStats>()
  proxyCache = new WeakMap<any, any>()
  hasNewAccess = false
  hasNewChange = false
  hasAnyChange = false

  constructor(private store: object) {}

  beginRender() {
    this.hasNewChange = false
    this.hasNewAccess = false
    for (const [, stat] of this.stats) {
      stat.accesses.clear()
      stat.changes.clear()
      stat.keysChange = false
    }
  }

  getSnapshot() {
    // Only call resetDirtyProxies if:
    // - # of changed is more than last time
    // - # of accessed is more than last time (and we've had at least 1 change)
    if (this.hasNewChange || (this.hasNewAccess && this.hasAnyChange)) {
      // Determine if the change touched something we actively used
      this.resetDirtyProxies()
      // We don't have to check again until we've had a new change or a new access
      this.hasNewChange = false
      this.hasNewAccess = false
    }
    return this.getOrCreateProxy(this.store)
  }

  resetDirtyProxies(): void {
    for (const [, stats] of this.stats) {
      if (stats.hasDirtyRead) {
        // Unset our proxy, up the root, which creates new a new snapshot
        ;[...stats.parents, stats].forEach((stats) => {
          this.proxyCache.delete(stats.store)
        })
      }
    }
  }

  // Wraps a store with an access tracking proxy
  getOrCreateProxy<T extends object>(store: T, parents: StoreStats[] = []): T {
    let proxy = this.proxyCache.get(store)
    if (!proxy) {
      // This will immediately start subscribing to the proxy
      proxy = this.getStoreStats(parents, store).newProxy()
      this.proxyCache.set(store, proxy)
    }
    return proxy
  }

  getStoreStats(parents: StoreStats[], store: object): StoreStats {
    let stats = this.stats.get(store)
    if (!stats) {
      stats = new StoreStats(this, parents, store)
      this.stats.set(store, stats)
    }
    return stats
  }
}

// For each store we touch, track both its accesses and changes, the
// combination of which allow use to very quickly determine if there
// have been dirty reads.
class StoreStats {
  accesses = new Set<string | symbol>()
  changes = new Set<string | symbol>()
  keysChange = false
  unsub: () => void

  constructor(
    private ref: UseStoreAdmin,
    public parents: StoreStats[],
    public store: object
  ) {
    this.unsub = subscribe(store, (ops) => {
      for (const tuple of ops) {
        const [op, path] = tuple
        // Only listen to changes directly to this store
        if (path.length === 1) {
          this.changes.add(String(path[0]))
          if (op === 'set' && tuple[4]) {
            this.keysChange = true
          } else if (op === 'delete') {
            this.keysChange = true
          }
        }
        ref.hasNewChange = true
        ref.hasAnyChange = true
        ref.onStoreChange()
      }
    })
  }

  /** Return true if any of the accessed properties have changed. */
  get hasDirtyRead(): boolean {
    if (this.keysChange) {
      return true
    }
    for (const key of this.accesses) {
      if (this.changes.has(key)) {
        return true
      }
    }
    return false
  }

  newProxy(): any {
    const { ref, store, accesses } = this
    const parents = [...this.parents, this]
    return new Proxy(store, {
      get(target, prop: string | symbol, receiver) {
        if (prop === GET_ORIGINAL_SYMBOL) {
          return store
        }
        accesses.add(prop)
        ref.hasNewAccess = true
        const value = Reflect.get(target, prop, receiver)
        return isStore(value) ? ref.getOrCreateProxy(value, parents) : value
      },
    })
  }
}

const getOriginalObject = <T extends object>(obj: T) =>
  (obj as { [GET_ORIGINAL_SYMBOL]?: typeof obj })[GET_ORIGINAL_SYMBOL] || obj

// Remove, just for debugging "are these really the same object/proxy?"
export const objectId = (() => {
  let currentId = 0
  const map = new WeakMap()
  return (object: object): number => {
    if (!map.has(object)) {
      map.set(object, ++currentId)
    }
    return map.get(object)!
  }
})()
Object.assign(global, { objectId })
