import { StrictMode, memo, useRef } from 'react'
import { it } from '@jest/globals'
import { fireEvent, render, waitFor } from '@testing-library/react'
import { getUntracked } from 'proxy-compare'
import { proxy } from 'valtio'
import { useStore } from 'valtio/utils'
import { objectId } from 'valtio/react/utils/useStore'

it('re-renders on change', async () => {
  const initialObject = { count: 0 }
  const obj = proxy(initialObject)
  console.log({ initialObject: objectId(initialObject), obj: objectId(obj) })

  const Counter = () => {
    const store = useStore(obj, { debug: true })
    return (
      <>
        <div>count: {store.count}</div>
        <button onClick={() => ++store.count}>button</button>
      </>
    )
  }

  const { getByText, findByText } = render(
    <StrictMode>
      <Counter />
    </StrictMode>
  )

  await findByText('count: 0')

  fireEvent.click(getByText('button'))
  await findByText('count: 1')
})

it('tracks usage between components', async () => {
  const obj = proxy({ count: 0, count2: 0 })

  const Counter = () => {
    const store = useStore(obj, { debug: true })
    const renders = useRef(0).current++
    return (
      <>
        <div>
          count: {store.count} ({renders})
        </div>
        <button onClick={() => ++obj.count}>button</button>
      </>
    )
  }

  const Counter2 = () => {
    const store = useStore(obj)
    const renders = useRef(0).current++
    return (
      <>
        <div>
          count2: {store.count2} ({renders})
        </div>
        <button onClick={() => ++obj.count2}>button2</button>
      </>
    )
  }

  const { getByText } = render(
    <>
      <Counter />
      <Counter2 />
    </>
  )

  await waitFor(() => {
    getByText('count: 0 (0)')
    getByText('count2: 0 (0)')
  })

  fireEvent.click(getByText('button'))
  await waitFor(() => {
    getByText('count: 1 (1)')
    getByText('count2: 0 (0)')
  })
})

it('tracks usage in non-memo-d child lists', async () => {
  const obj = proxy({
    books: [
      { title: 'b1', price: 10 },
      { title: 'b2', price: 20 },
    ],
  })

  const BookList = () => {
    const store = useStore(obj, { debug: true })
    const renders = useRef(0).current++
    return (
      <>
        <div>books ({renders})</div>
        {store.books.map((b) => (
          <Book key={b.title} book={b} />
        ))}
        <button onClick={() => store.books.push({ title: 'b3', price: 30 })}>
          new
        </button>
        <button onClick={() => store.books.splice(0, 1)}>del</button>
      </>
    )
  }

  const Book = ({ book }: { book: any }) => {
    const renders = useRef(0).current++
    return (
      <>
        <div>
          {book.title} {book.price} ({renders})
        </div>
        <button onClick={() => ++book.price}>{book.title}</button>
      </>
    )
  }

  const { getByText } = render(<BookList />)

  await waitFor(() => {
    getByText('books (0)')
    getByText('b1 10 (0)')
    getByText('b2 20 (0)')
  })

  // Because no memo & no child getStore, everything re-renders
  fireEvent.click(getByText('b1'))
  await waitFor(() => {
    getByText('books (1)')
    getByText('b1 11 (1)')
    getByText('b2 20 (1)')
  })

  fireEvent.click(getByText('new'))
  await waitFor(() => {
    getByText('books (2)')
    getByText('b1 11 (2)')
    getByText('b2 20 (2)')
    getByText('b3 30 (0)')
  })

  fireEvent.click(getByText('del'))
  await waitFor(() => {
    getByText('books (3)')
    getByText('b2 20 (3)')
    getByText('b3 30 (1)')
  })
})

it('tracks usage in memo-d child lists using their own store', async () => {
  const obj = proxy({
    books: [
      { title: 'b1', price: 10 },
      { title: 'b2', price: 20 },
    ],
  })

  const BookList = () => {
    const store = useStore(obj, { debug: true })
    const renders = useRef(0).current++
    return (
      <>
        <div>books ({renders})</div>
        {store.books.map((b) => (
          <Book key={b.title} book={b} />
        ))}
        <button onClick={() => store.books.push({ title: 'b3', price: 30 })}>
          new
        </button>
        <button onClick={() => store.books.splice(0, 1)}>del</button>
      </>
    )
  }

  const Book = memo(({ book }: { book: any }) => {
    // The child must use their own `useStore` to render reactively, b/c the incoming
    // book proxy does not change identity; it's not a snapshot, it's a stable identity.
    const store = useStore(book, { debug: true })
    const renders = useRef(0).current++
    return (
      <>
        <div>
          {store.title} {store.price} ({renders})
        </div>
        <button onClick={() => ++store.price}>{store.title}</button>
      </>
    )
  })

  const { getByText } = render(<BookList />)

  await waitFor(() => {
    getByText('books (0)')
    getByText('b1 10 (0)')
    getByText('b2 20 (0)')
  })

  fireEvent.click(getByText('b1'))
  await waitFor(() => {
    getByText('books (0)')
    // Only the 1st child re-renders
    getByText('b1 11 (1)')
    getByText('b2 20 (0)')
  })

  fireEvent.click(getByText('new'))
  await waitFor(() => {
    getByText('books (2)') // should be 1...
    getByText('b1 11 (1)')
    getByText('b2 20 (0)')
    getByText('b3 30 (0)')
  })

  fireEvent.click(getByText('del'))
  await waitFor(() => {
    getByText('books (2)')
    getByText('b2 20 (0)')
    getByText('b3 30 (0)')
  })
})

it('re-renders on change of an object getter', async () => {
  const obj = proxy({
    _count: 0,
    get count() {
      return this._count
    },
    set count(v) {
      console.log('SETTING', v, 'ON', objectId(this), typeof this)
      this._count = v
    },
    get doubled() {
      console.log('CALCED', this.count * 2, 'ON', objectId(this), this._count)
      return this.count * 2
    },
  })
  console.log({ obj: objectId(obj) })

  const Counter = () => {
    const store = useStore(obj, { debug: true })
    // console.log({
    //   storeId: objectId(store),
    //   storeCount: store._count,
    //   storeDoubled: store.doubled,
    //   objId: objectId(obj),
    //   objCount: obj._count,
    //   objDoubled: obj.doubled,
    //   untrackedId: objectId(getUntracked(store)!),
    // })
    return (
      <>
        <div>double: {store.doubled}</div>
        <button onClick={() => ++obj.count}>button</button>
      </>
    )
  }

  const { getByText, findByText } = render(
    <StrictMode>
      <Counter />
    </StrictMode>
  )

  await findByText('double: 0')

  fireEvent.click(getByText('button'))
  await findByText('double: 2')
})

it('re-renders on change of an class getter', async () => {
  class Count {
    count = 0
    get doubled() {
      return this.count * 2
    }
  }
  const obj = proxy(new Count())

  const Counter = () => {
    const store = useStore(obj, { debug: true })
    return (
      <>
        <div>doubled: {store.doubled}</div>
        <button onClick={() => ++obj.count}>button</button>
      </>
    )
  }

  const { getByText, findByText } = render(
    <StrictMode>
      <Counter />
    </StrictMode>
  )

  await findByText('doubled: 0')

  fireEvent.click(getByText('button'))
  await findByText('doubled: 2')
})
