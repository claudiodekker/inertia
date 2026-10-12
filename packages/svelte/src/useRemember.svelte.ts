import { cloneDeep } from 'es-toolkit'
import { useRouter } from './layerContext.svelte'

export default function useRemember<State extends object>(initialState: State, key?: string): State {
  const router = useRouter()
  const restored = router.restore(key) as State | undefined
  const state = $state(restored !== undefined ? cloneDeep(restored) : initialState)

  $effect(() => {
    router.remember(cloneDeep($state.snapshot(state)), key)
  })

  return state
}
