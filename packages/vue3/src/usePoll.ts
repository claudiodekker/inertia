import { PollOptions, ReloadOptions } from '@inertiajs/core'
import { onMounted, onUnmounted, ref, Ref } from 'vue'
import { useRouter } from './layerContext'

export default function usePoll(
  interval: number,
  requestOptions: ReloadOptions | (() => ReloadOptions) = {},
  options: PollOptions = {
    autoStart: true,
  },
): {
  stop: VoidFunction
  start: VoidFunction
  polling: Ref<boolean>
} {
  const router = useRouter()
  const autoStart = options.autoStart ?? true

  const { stop, start, destroy } = router.poll(interval, requestOptions, {
    ...options,
    autoStart: false,
  })

  const polling = ref(autoStart)

  onMounted(() => {
    if (autoStart) {
      start()
    }
  })

  onUnmounted(() => {
    destroy()
  })

  return {
    polling,
    stop: () => {
      stop()
      polling.value = false
    },
    start: () => {
      start()
      polling.value = true
    },
  }
}
