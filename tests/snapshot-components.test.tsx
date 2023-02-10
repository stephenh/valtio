import { StrictMode } from 'react'
import { it } from '@jest/globals'
import { fireEvent, render } from '@testing-library/react'
import { proxy, useSnapshot } from 'valtio'

it('tracks accessed in children', async () => {
  const obj = proxy({ firstName: 'John', lastName: 'Doe' })

  const Parent = () => {
    const snap = useSnapshot(obj)
    return (
      <>
        <div>First: {snap.firstName}</div>
        <Child snap={snap} />
        <button onClick={() => (obj.lastName = 'Dor')}>last</button>
      </>
    )
  }

  const Child = ({ snap }: { snap: typeof obj }) => {
    return (
      <>
        <div>Last: {snap.lastName}</div>
        <button onClick={() => (obj.firstName = 'Jane')}>first</button>
      </>
    )
  }

  const { getByText, findByText } = render(
    <StrictMode>
      <Parent />
    </StrictMode>
  )

  await findByText('Last: Doe')

  fireEvent.click(getByText('last'))
  await findByText('Last: Dor')

  fireEvent.click(getByText('first'))
  await findByText('First: Jane')
})
