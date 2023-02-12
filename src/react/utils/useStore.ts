import { useCallback, useRef } from 'react'
import useSyncExternalStoreExports from 'use-sync-external-store/shim'
import { proxy, subscribe } from 'valtio'
import { createProxy, getUntracked } from './compare-proxy'

const { useSyncExternalStore } = useSyncExternalStoreExports

// Instead of lots of refs, we use a single ref with our bag of state.
interface StoreRef {
  proxy: any
  stats: Map<object, StoreStats>
  onAccess: (obj: object, prop: string | symbol) => void
  proxyCache: WeakMap<any, any>
  hasNewAccess: boolean
  hasNewChange: boolean
  hasAnyChange: boolean
}

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
export function useStore<T extends object>(
  store: T,
  // TODO Remove hacky debug flag for development
  opts: { debug: boolean } = { debug: false }
): T {
  const { debug } = opts

  // If we were passed a compare-proxy, i.e. a child component doing their own
  // `const store = useStore(props.parent)` line, unwrap it to establish the child
  // component's own usage tracking.
  if (getUntracked(store)) {
    store = getUntracked(store) as T
  }

  // Use just 1 ref for all our state
  const ref = useRef<StoreRef | null>(null)
  if (!ref.current) {
    const statsMap = new Map<object, StoreStats>()

    // I've forked proxy-compare to accept an`onAccess` callback, so that we
    // can more directly update our internal store of accessed properties,
    // and not have to rely on `affectedToPathList` to pull them out later.
    const onAccess = (store: object, prop: string | symbol) => {
      console.log({ action: 'ACCESS', store, storeId: objectId(store) })
      const s = StoreStats.get(statsMap, store)
      if (!s.accesses.has(prop)) {
        debug && console.log('ACCESSED', prop)
        s.accesses.add(prop)
        ref.current!.hasNewAccess = true
      }
    }
    const proxyCache = new WeakMap()

    ref.current = {
      stats: statsMap,
      onAccess,
      proxy: createProxy(store, onAccess, proxyCache),
      proxyCache,
      hasNewAccess: false,
      hasNewChange: false,
      hasAnyChange: false,
    }
  }

  const { current } = ref

  // We're going to render our JSX now, so assume we're up-to-date, and start/reset
  // recording all changes + all accesses from here on.
  current.hasNewChange = false
  // TODO Reset accesses in the StoreStats

  const compareProxy = useSyncExternalStore(
    useCallback(
      (callback) => {
        const { stats: statsMap } = current
        const unsub = subscribe(store, (ops) => {
          for (const op of ops) {
            debug && console.log('CHANGE', op[0], op[1].join('/'))
            // Super hacky change to vanilla.ts: get the last path's _instance_
            const origObject = op[op.length - 1] as object
            // Resolve the internal baseObject instance back to a store proxy
            const store = proxy(origObject)
            const stats = StoreStats.get(statsMap, store)
            // Get the last path
            const paths = op[1]
            stats.changes.add(paths![paths.length - 1]!)
            current.hasNewChange = true
            current.hasAnyChange = true
          }
          callback()
        })
        callback()
        return unsub
      },
      [store, debug, current]
    ),
    () => {
      const {
        stats,
        proxyCache,
        onAccess,
        hasNewChange,
        hasNewAccess,
        hasAnyChange,
      } = current
      // Only call hasDirtyReads if:
      // - # of changed is more than last time
      // - # of accessed is more than last time (and we've had at least 1 change)
      if (hasNewChange || (hasNewAccess && hasAnyChange)) {
        // Determine if the change touched something we actively used
        const dirtyStores = getDirtyStores(stats)
        if (dirtyStores.length > 0) {
          // TODO This should be done recursively up from each dirty `store` (which
          //  could be a child proxy) up to the root `store`, so that all levels up
          //  the tree are invalidated, just like snapshots.
          for (const store of dirtyStores) {
            proxyCache.delete(store)
          }
          // ...until we do the above TODO, at least invalidate the root proxy
          proxyCache.delete(store)
          current.proxy = createProxy(store, onAccess, proxyCache)
        }
        // We don't have to check again until we've had a new change or a new access
        current.hasNewChange = false
        current.hasNewAccess = false
      }
      return current.proxy
    },
    () => 1
  )

  return compareProxy
}

// ...this is just a .filter(s => s.isDirty) but "for loops are faster"?
function getDirtyStores(statsMap: Map<object, StoreStats>): object[] {
  const dirtyStores = []
  for (const [store, stats] of statsMap) {
    if (stats.isDirty) {
      dirtyStores.push(store)
    }
  }
  return dirtyStores
}

// For each store we wrap in a compare-proxy, track both its accesses and
// changes, the combination of which allow use to very quickly determine
// if there have been dirty reads.
class StoreStats {
  static get(stats: Map<object, StoreStats>, store: object): StoreStats {
    let s = stats.get(store)
    if (!s) {
      s = new StoreStats()
      stats.set(store, s)
    }
    return s
  }

  accesses = new Set<string | symbol>()
  changes = new Set<string | symbol>()

  get isDirty(): boolean {
    for (const key of this.accesses) {
      if (this.changes.has(key)) {
        return true
      }
    }
    return false
  }
}

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
