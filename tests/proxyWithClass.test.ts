import { expect, it } from '@jest/globals'
import {
  affectedToPathList,
  createProxy as createProxyToCompare,
} from 'proxy-compare'
import { snapshot } from 'valtio'
import { proxyWithClass } from 'valtio/utils'

it('should cache class getters via proxyWithClass', () => {
  let getter = 0
  class Counter {
    count = 1
    get doubled() {
      getter++
      return this.count * 2
    }
    set doubled(v: number) {
      this.count = v / 2
    }
  }
  const state = proxyWithClass(new Counter())

  // getter calls to the state are not cached
  state.doubled
  expect(getter).toBe(1)
  state.doubled
  expect(getter).toBe(2)

  // creating a snapshot caches the getter
  const snap = snapshot(state)
  expect(getter).toBe(3)
  expect(Reflect.ownKeys(snap)).toEqual(['count', 'doubled'])

  snap.doubled
  expect(getter).toBe(3)

  // and the setter will blow up
  expect(() => ((snap as any).doubled = 8)).toThrowError('Cannot assign')

  // and `doubled` shows up in affectedToPathList
  const affected = new WeakMap()
  const cmp = createProxyToCompare(snap, affected)
  cmp.doubled
  expect(affectedToPathList(cmp, affected)).toEqual([['doubled']])
})

it('uses proxyWithClass for child objects', () => {
  class Book {
    title = 'b1'
    get titleUpper() {
      return this.title.toUpperCase()
    }
  }
  class Author {
    books = [new Book()]
  }
  const state = proxyWithClass(new Author())
  const snap = snapshot(state)
  expect(Reflect.ownKeys(snap.books[0]!)).toEqual(['title', 'titleUpper'])
})
