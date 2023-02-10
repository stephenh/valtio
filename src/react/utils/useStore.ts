import { useCallback, useMemo, useRef } from 'react'
import {
  affectedToPathList,
  createProxy as createProxyToCompare,
  getUntracked,
  markToTrack,
} from 'proxy-compare'
import useSyncExternalStoreExports from 'use-sync-external-store/shim'
import { subscribe } from 'valtio'

const { useSyncExternalStore } = useSyncExternalStoreExports

// Instead of lots of refs, we use a single ref with our bag of state.
interface StoreRef {
  // We use a local version number instead of the proxy's version number,
  // because the proxy may change, but on a property that we're not using.
  version: 0
  // Any state accessed by JSX/etc. since our last render.
  accessed: CountingWeakMap<object, unknown>
  // Any state changed by mutations since our last render.
  changed: Set<string>
  // Caching for our hasDirtyRead checks.
  lastChecked: { accessedSets: number; changedSize: number }
}

/**
 * Provides a component with usage-based tracking of changes to a store.
 *
 * @example foo
 * const view = useStore(proxy)
 */
export function useStore<T extends object>(
  proxy: T,
  opts: { debug: boolean } = { debug: false }
): T {
  const { debug } = opts

  // If we were passed a compare-proxy, i.e. a child component doing their own
  // `const store = useStore(props.parent)` line, unwrap it to establish the child
  // component's own usage tracking.
  if (getUntracked(proxy)) {
    proxy = getUntracked(proxy) as T
  }

  // Use just 1 ref for all our state
  const ref = useRef<StoreRef | null>(null)
  if (!ref.current) {
    ref.current = {
      version: 0,
      accessed: new CountingWeakMap(),
      changed: new Set(),
      lastChecked: { accessedSets: 0, changedSize: 0 },
    }
  }

  const { current } = ref

  // We're going to render our JSX now, so assume we're up-to-date, and start/reset
  // recording all changes + all accesses from here on.
  current.accessed = new CountingWeakMap()
  current.changed = new Set()

  // We use `useSyncExternalStore` to get its tear avoidance, but cheat and don't have
  // real snapshots; instead our "snapshot" is a version number that we tick when we
  // realize there as been a change that we need to re-render.
  // This is similar to Mobx's approach: https://github.com/mobxjs/mobx/pull/3590
  useSyncExternalStore(
    useCallback(
      (callback) => {
        const unsub = subscribe(proxy, (ops) => {
          for (const op of ops) {
            debug && console.log('CHANGE', op[0], op[1].join('/'))
            current.changed.add(op[1].join('/'))
          }
          callback()
        })
        callback()
        return unsub
      },
      [proxy, debug, current]
    ),
    () => {
      const { lastChecked, changed, accessed } = current
      // Only call hasDirtyReads if:
      // - # of changed is more than last time
      // - # of accessed is more than last time
      if (
        changed.size > lastChecked.changedSize ||
        accessed.sets > lastChecked.accessedSets
      ) {
        lastChecked.changedSize = changed.size
        lastChecked.accessedSets = accessed.sets
        // Determine if the change touched something we actively used
        if (hasDirtyReads(proxy, accessed, changed)) {
          return ++current.version
        }
      }
      return current.version
    },
    () => 1
  )

  const proxyCache = useMemo(() => new WeakMap(), []) // per-hook proxyCache

  // TODO Need to have this done recursively, so we can mark all nested objects
  // Today in Valtio only snapshots are recursively marked.
  markToTrack(proxy)

  // We're creating a double proxy here; in theory if we knew this compare-proxy was only
  // going to be used for reads, we could compare-proxy against the original object;
  // but that would defeat the purpose of `useStore` returning a "still unified" proxy.
  return createProxyToCompare(proxy, current.accessed, proxyCache)
}

/**
 * Similar to proxy-compare's `isChanged` but compares `accessed` to a list of
 * `changed` paths, instead of comparing values between prev/curr snapshots.
 */
function hasDirtyReads(
  proxy: object,
  accessed: WeakMap<any, any>,
  changed: Set<string>
): boolean {
  // Create ['books/0/title', 'firstName']
  const accessedPaths = new Set(
    affectedToPathList(proxy, accessed).map((p) => p.join('/'))
  )
  let dirty = false
  for (const changedPath of changed) {
    if (accessedPaths.has(changedPath)) {
      dirty = true
      break
    }
  }
  return dirty
}

/**
 * Adds a "number of set calls" to `WeakMap`, since it doesn't have a `size` property.
 *
 * We use this to avoid continually calling `hasDirtyReads` when there haven't
 * been any new accesses since the last `getSnapshot` call anyway.
 */
class CountingWeakMap<K extends object, V> extends WeakMap<K, V> {
  sets = 0

  set(key: any, value: any) {
    this.sets++
    return super.set(key, value)
  }
}
