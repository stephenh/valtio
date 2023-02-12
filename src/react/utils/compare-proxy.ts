// symbols
import { getVersion } from '../../vanilla'

const TRACK_MEMO_SYMBOL = Symbol()
const GET_ORIGINAL_SYMBOL = Symbol()

// properties
const AFFECTED_PROPERTY = 'a'
const FROZEN_PROPERTY = 'f'
const PROXY_PROPERTY = 'p'
const PROXY_CACHE_PROPERTY = 'c'
const HAS_KEY_PROPERTY = 'h'
const ALL_OWN_KEYS_PROPERTY = 'w'
const HAS_OWN_KEY_PROPERTY = 'o'
const KEYS_PROPERTY = 'k'

// function to create a new bare proxy
let newProxy = <T extends object>(target: T, handler: ProxyHandler<T>) =>
  new Proxy(target, handler)

// get object prototype
const getProto = Object.getPrototypeOf

const objectsToTrack = new WeakMap<object, boolean>()

// check if obj is a plain object or an array
const isObjectToTrack = <T>(obj: T): obj is T extends object ? T : never =>
  (obj &&
    (objectsToTrack.has(obj as unknown as object)
      ? (objectsToTrack.get(obj as unknown as object) as boolean)
      : getProto(obj) === Object.prototype ||
        getProto(obj) === Array.prototype)) ||
  // ADDED BY USESTORE SO THAT WE DON'T HAVE TO markToTrack EVERY PROXY
  getVersion(obj) !== undefined

// Even if an object is not frozen, any non-configurable _and_ non-writeable properties
// (which Object.freeze does also do) will break the proxy get trap.
// See: https://github.com/dai-shi/proxy-compare/pull/8
const isEffectivelyFrozen = (obj: object) =>
  Object.isFrozen(obj) ||
  Object.values(Object.getOwnPropertyDescriptors(obj)).some(
    (descriptor) => !descriptor.configurable && !descriptor.writable
  )

// Make a copy with all descriptors marked as configurable.
const proxyFriendlyCopy = <T extends object>(obj: T): T => {
  if (Array.isArray(obj)) {
    // Arrays need a special way to copy
    return Array.from(obj) as T
  }
  // For non-array objects, we create a new object keeping the prototype
  // with changing all configurable options (otherwise, proxies will complain)
  const descriptors = Object.getOwnPropertyDescriptors(obj)
  Object.values(descriptors).forEach((desc) => {
    desc.configurable = true
  })
  return Object.create(getProto(obj), descriptors)
}

type HasKeySet = Set<string | symbol>
type HasOwnKeySet = Set<string | symbol>
type KeysSet = Set<string | symbol>
type Used = {
  [HAS_KEY_PROPERTY]?: HasKeySet
  [ALL_OWN_KEYS_PROPERTY]?: true
  [HAS_OWN_KEY_PROPERTY]?: HasOwnKeySet
  [KEYS_PROPERTY]?: KeysSet
}
type Affected = (object: object, key: string | symbol) => void
type ProxyHandlerState<T extends object> = {
  readonly [FROZEN_PROPERTY]: boolean
  [PROXY_PROPERTY]?: T
  [PROXY_CACHE_PROPERTY]?: ProxyCache<object> | undefined
  [AFFECTED_PROPERTY]?: Affected
}
type ProxyCache<T extends object> = WeakMap<
  object,
  readonly [ProxyHandler<T>, ProxyHandlerState<T>]
>

const createProxyHandler = <T extends object>(origObj: T, frozen: boolean) => {
  const state: ProxyHandlerState<T> = {
    [FROZEN_PROPERTY]: frozen,
  }
  let trackObject = false // for trackMemo
  const recordUsage = (
    type:
      | typeof HAS_KEY_PROPERTY
      | typeof ALL_OWN_KEYS_PROPERTY
      | typeof HAS_OWN_KEY_PROPERTY
      | typeof KEYS_PROPERTY,
    key?: string | symbol
  ) => {
    if (!trackObject) {
      if (key) {
        ;(state[AFFECTED_PROPERTY] as Affected)(origObj, key)
      }
    }
  }
  const recordObjectAsUsed = () => {
    trackObject = true
    // ;(state[AFFECTED_PROPERTY] as Affected).delete(origObj)
  }
  const handler: ProxyHandler<T> = {
    // TODO Upstream maybe to proxy-compare; pass along the receiver so
    // that we can "see into" what fields getters and setters are internally
    // accessing, because we need to see the actual physical fields to have
    // overlap between the accesses & changes (unlike mobx, we don't know
    // when getters change).
    get(target, key, receiver) {
      if (key === GET_ORIGINAL_SYMBOL) {
        return origObj
      }
      recordUsage(KEYS_PROPERTY, key)
      return createProxy(
        Reflect.get(target, key, receiver),
        state[AFFECTED_PROPERTY] as Affected,
        state[PROXY_CACHE_PROPERTY]
      )
    },
    has(target, key) {
      if (key === TRACK_MEMO_SYMBOL) {
        recordObjectAsUsed()
        return true
      }
      recordUsage(HAS_KEY_PROPERTY, key)
      return Reflect.has(target, key)
    },
    getOwnPropertyDescriptor(target, key) {
      recordUsage(HAS_OWN_KEY_PROPERTY, key)
      return Reflect.getOwnPropertyDescriptor(target, key)
    },
    ownKeys(target) {
      recordUsage(ALL_OWN_KEYS_PROPERTY)
      return Reflect.ownKeys(target)
    },
  }
  if (frozen) {
    handler.set = handler.deleteProperty = (_target, key) => {
      throw new Error(`Cannot assign to read only property '${String(key)}'`)
    }
  }
  return [handler, state] as const
}

const getOriginalObject = <T extends object>(obj: T) =>
  // unwrap proxy
  (obj as { [GET_ORIGINAL_SYMBOL]?: typeof obj })[GET_ORIGINAL_SYMBOL] ||
  // otherwise
  obj

/**
 * Create a proxy.
 *
 * This function will create a proxy at top level and proxy nested objects as you access them,
 * in order to keep track of which properties were accessed via get/has proxy handlers:
 *
 * NOTE: Printing of WeakMap is hard to inspect and not very readable
 * for this purpose you can use the `affectedToPathList` helper.
 *
 * @param {object} obj - Object that will be wrapped on the proxy.
 * @param {WeakMap<object, unknown>} affected -
 * WeakMap that will hold the tracking of which properties in the proxied object were accessed.
 * @param {WeakMap<object, unknown>} [proxyCache] -
 * WeakMap that will help keep referential identity for proxies.
 * @returns {Proxy<object>} - Object wrapped in a proxy.
 *
 * @example
 * import { createProxy } from 'proxy-compare';
 *
 * const original = { a: "1", c: "2", d: { e: "3" } };
 * const affected = new WeakMap();
 * const proxy = createProxy(original, affected);
 *
 * proxy.a // Will mark as used and track its value.
 * // This will update the affected WeakMap with original as key
 * // and a Set with "a"
 *
 * proxy.d // Will mark "d" as accessed to track and proxy itself ({ e: "3" }).
 * // This will update the affected WeakMap with original as key
 * // and a Set with "d"
 */
export const createProxy = <T>(
  obj: T,
  affected: Affected,
  proxyCache?: WeakMap<object, unknown>
): T => {
  if (!isObjectToTrack(obj)) return obj
  const target = getOriginalObject(obj)
  // Even if target is not technically `Object.frozen`, if there are any frozen-ish properties,
  // we must make a copy for the proxy to work, and to avoid the user mutating _other_
  // non-frozen properties (that would go to our internal copy & be lost), we just treat
  // the entire object as frozen.
  const frozen = isEffectivelyFrozen(target)
  let handlerAndState =
    proxyCache && (proxyCache as ProxyCache<typeof target>).get(target)
  if (!handlerAndState || handlerAndState[1][FROZEN_PROPERTY] !== frozen) {
    handlerAndState = createProxyHandler<typeof target>(target, frozen)
    handlerAndState[1][PROXY_PROPERTY] = newProxy(
      frozen ? proxyFriendlyCopy(target) : target,
      handlerAndState[0]
    )
    if (proxyCache) {
      proxyCache.set(target, handlerAndState)
    }
  }
  handlerAndState[1][AFFECTED_PROPERTY] = affected as Affected
  handlerAndState[1][PROXY_CACHE_PROPERTY] = proxyCache as
    | ProxyCache<object>
    | undefined
  return handlerAndState[1][PROXY_PROPERTY] as typeof target
}

// explicitly track object with memo
export const trackMemo = (obj: unknown) => {
  if (isObjectToTrack(obj)) {
    return TRACK_MEMO_SYMBOL in obj
  }
  return false
}

/**
 * Unwrap proxy to get the original object.
 *
 * Used to retrieve the original object used to create the proxy instance with `createProxy`.
 *
 * @param {Proxy<object>} obj -  The proxy wrapper of the originial object.
 * @returns {object | null} - Return either the unwrapped object if exists.
 *
 * @example
 * import { createProxy, getUntracked } from 'proxy-compare';
 *
 * const original = { a: "1", c: "2", d: { e: "3" } };
 * const affected = new WeakMap();
 *
 * const proxy = createProxy(original, affected);
 * const originalFromProxy = getUntracked(proxy)
 *
 * Object.is(original, originalFromProxy) // true
 * isChanged(original, originalFromProxy, affected) // false
 */
export const getUntracked = <T>(obj: T): T | null => {
  if (isObjectToTrack(obj)) {
    return (obj as { [GET_ORIGINAL_SYMBOL]?: T })[GET_ORIGINAL_SYMBOL] || null
  }
  return null
}

/**
 * Mark object to be tracked.
 *
 * This function marks an object that will be passed into `createProxy`
 * as marked to track or not. By default only Array and Object are marked to track,
 * so this is useful for example to mark a class instance to track or to mark a object
 * to be untracked when creating your proxy.
 *
 * @param obj - Object to mark as tracked or not.
 * @param mark - Boolean indicating whether you want to track this object or not.
 * @returns - No return.
 *
 * @example
 * import { createProxy, markToTrack, isChanged } from 'proxy-compare';
 *
 * const nested = { e: "3" }
 *
 * markToTrack(nested, false)
 *
 * const original = { a: "1", c: "2", d: nested };
 * const affected = new WeakMap();
 *
 * const proxy = createProxy(original, affected);
 *
 * proxy.d.e
 *
 * isChanged(original, { d: { e: "3" } }, affected) // true
 */
export const markToTrack = (obj: object, mark = true) => {
  objectsToTrack.set(obj, mark)
}

/**
 * replace newProxy function.
 *
 * This can be used if you want to use proxy-polyfill.
 * Note that proxy-polyfill can't polyfill everything.
 * Use it at your own risk.
 */
export const replaceNewProxy = (fn: typeof newProxy) => {
  newProxy = fn
}
