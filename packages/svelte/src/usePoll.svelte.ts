import type { PollOptions, ReloadOptions } from '@inertiajs/core'
import { onDestroy, onMount } from 'svelte'
import { useRouter } from './layerContext.svelte'

export default function usePoll(
  interval: number,
  requestOptions: ReloadOptions | (() => ReloadOptions) = {},
  options: PollOptions = {
    autoStart: true,
  },
) {
  const router = useRouter()
  const autoStart = options.autoStart ?? true

  const { stop, start, destroy } = router.poll(interval, requestOptions, {
    ...options,
    autoStart: false,
  })

  let polling = $state(autoStart)

  onMount(() => {
    if (autoStart) {
      start()
    }
  })

  onDestroy(() => {
    destroy()
  })

  return {
    get polling() {
      return polling
    },
    stop() {
      stop()
      polling = false
    },
    start() {
      start()
      polling = true
    },
  }
}
