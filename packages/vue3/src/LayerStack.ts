import { layerSlot } from '@inertiajs/core'
import { defineComponent } from 'vue'

export default defineComponent({
  name: 'InertiaLayerStack',
  setup() {
    return () => (layerSlot.views().length > 0 ? [] : null)
  },
})
