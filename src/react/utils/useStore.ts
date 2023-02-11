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
 * @example foo
 * const view = useStore(proxy)
 */
export function useStore<T extends object>(
  store: T,
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
    const stats = new Map<object, StoreStats>()
    const onAccess = (store: object, prop: string | symbol) => {
      console.log({ action: 'ACCESS', store, storeId: objectId(store) })
      let s = stats.get(store)
      if (!s) {
        s = new StoreStats()
        stats.set(store, s)
      }
      if (!s.accesses.has(prop)) {
        debug && console.log('ACCESSED', prop)
        s.accesses.add(prop)
        ref.current!.hasNewAccess = true
      }
    }
    const proxyCache = new WeakMap()

    ref.current = {
      stats,
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

  // We use `useSyncExternalStore` to get its tear avoidance, but cheat and don't have
  // real snapshots; instead our "snapshot" is a version number that we tick when we
  // realize there as been a change that we need to re-render.
  // This is similar to Mobx's approach: https://github.com/mobxjs/mobx/pull/3590
  const compareProxy = useSyncExternalStore(
    useCallback(
      (callback) => {
        const { stats } = current
        const unsub = subscribe(store, (ops) => {
          for (const op of ops) {
            // Get the child store
            const origObject = op[op.length - 1] as object
            const store = proxy(origObject)
            console.log({
              action: 'CHANGE',
              origObject,
              origObjectId: objectId(origObject),
              store,
              storeId: objectId(store),
            })
            let s = stats.get(store)
            if (!s) {
              s = new StoreStats()
              stats.set(store, s)
            }
            // Get the last path, i.e. the store
            const paths = op[1]
            s.changes.add(paths![paths.length - 1]!)
            debug && console.log('CHANGE', op[0], op[1].join('/'))
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
          for (const store of dirtyStores) {
            proxyCache.delete(store)
          }
          // Always create a new root proxy, even if it's only a child that changed
          // to ensure getSnapshot returns a new version.
          // ...maybe this should be done like snapshots, from a child up to the root...
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

  // We're creating a double proxy here; in theory if we knew this compare-proxy was only
  // going to be used for reads, we could compare-proxy against the original object;
  // but that would defeat the purpose of `useStore` returning a "still unified" proxy.
  return compareProxy
}

function getDirtyStores(stats: Map<object, StoreStats>): object[] {
  const dirtyStores = []
  nextStore: for (const [store, stat] of stats) {
    for (const key of stat.accesses) {
      if (stat.changes.has(key)) {
        dirtyStores.push(store)
        break nextStore
      }
    }
  }
  return dirtyStores
}

class StoreStats {
  accesses = new Set<string | symbol>()
  changes = new Set<string | symbol>()
}

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
