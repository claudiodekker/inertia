import { Dispatch, MutableRefObject, SetStateAction, useEffect, useState } from 'react'
import { useRouter } from './layerContext'

export default function useRemember<State>(
  initialState: State,
  key?: string,
  excludeKeysRef?: MutableRefObject<string[]>,
): [State, Dispatch<SetStateAction<State>>] {
  const router = useRouter()
  const [state, setState] = useState(() => {
    const restored = router.restore(key) as State

    return restored !== undefined ? restored : initialState
  })

  useEffect(() => {
    const keys = excludeKeysRef?.current
    if (keys && keys.length > 0 && typeof state === 'object' && state !== null) {
      const filtered = { ...state } as Record<string, unknown>
      keys.forEach((k) => delete filtered[k])
      router.remember(filtered, key)
    } else {
      router.remember(state, key)
    }
  }, [state, key])

  return [state, setState]
}
