import { Link, useLayer } from '@inertiajs/react'

export default () => {
  const layer = useLayer()!

  layer.setLayoutProps({ layerChrome: 'layer' })

  return (
    <>
      <div>Account settings</div>
      <Link href="/layers/settings">Open settings again</Link>
    </>
  )
}
