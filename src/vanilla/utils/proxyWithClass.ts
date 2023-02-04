import { markToTrack } from 'proxy-compare'
import { snapshot, unstable_buildProxyFunction } from 'valtio'

const [
  ,
  proxyStateMap,
  refSet,
  objectIs,
  newProxy,
  canProxy,
  handlePromise,
  snapCache,
  ,
  ,
  ,
] = unstable_buildProxyFunction()

/**
 * Implements a copy/paste customization of `createSnapshot` that walks up the prototype
 * chain looking for getters to invoke and then set directly on the snapshot instance.
 *
 * This effectively caches the value, aligning with the behavior of object getters, and prevents
 * the user from getting confused by the getter being invoked with `this` as the snapshot.
 */
const createSnapshot = <T extends object>(target: T, version: number): T => {
  const cache = snapCache.get(target)
  if (cache?.[0] === version) {
    return cache[1] as T
  }
  const snap: any = Array.isArray(target)
    ? []
    : Object.create(Object.getPrototypeOf(target))
  markToTrack(snap, true) // mark to track
  snapCache.set(target, [version, snap])

  function getValue(key: PropertyKey): any {
    const value = Reflect.get(target, key)
    if (refSet.has(value as object)) {
      markToTrack(value as object, false) // mark not to track
      return value
    } else if (proxyStateMap.has(value as object)) {
      return snapshot(value as object, handlePromise)
    } else {
      return value
    }
  }

  // This will copy all object getters, functions, and values
  Reflect.ownKeys(target).forEach((key) => {
    const value = getValue(key)
    if (value instanceof Promise) {
      Object.defineProperty(snap, key, {
        get() {
          return handlePromise(value)
        },
      })
    } else {
      snap[key] = value
    }
  })

  // Now look for proto getters to essentially cache them
  const protoGetters = findPrototypeGetters(target)
  protoGetters.forEach((key) => {
    const value = getValue(key)
    if (value instanceof Promise) {
      Object.defineProperty(snap, key, {
        get() {
          return handlePromise(value)
        },
      })
    } else {
      // We have to use `defineProperty` instead of `snap[key] = value` to explicitly
      // set the value on the snap instance itself, and not just invoke the setter
      Object.defineProperty(snap, key, { value })
    }
  })

  return Object.freeze(snap)
}

export const [proxyFunction] = unstable_buildProxyFunction(
  objectIs,
  newProxy,
  canProxy,
  handlePromise,
  snapCache,
  createSnapshot
)

export const proxyWithClass = proxyFunction

/** Walks the prototype chain looking for getters. */
function findPrototypeGetters(target: any): PropertyKey[] {
  const protoGetters: PropertyKey[] = []
  let current = Object.getPrototypeOf(target)
  while (
    current &&
    current !== Object.prototype &&
    current !== Array.prototype
  ) {
    protoGetters.push(
      ...Reflect.ownKeys(current).filter(
        (key) => Object.getOwnPropertyDescriptor(current, key)?.get
      )
    )
    current = Object.getPrototypeOf(current)
  }
  return protoGetters
}
