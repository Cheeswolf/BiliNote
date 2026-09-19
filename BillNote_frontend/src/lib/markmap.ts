import { loadCSS, loadJS } from 'markmap-common'
import { Transformer } from 'markmap-lib'
import * as markmap from 'markmap-view'

export const transformer = new Transformer()
let assetInitialization: Promise<void> | undefined

export function initializeMarkmapAssets(): Promise<void> {
  assetInitialization ??= Promise.resolve()
    .then(() => {
      const { scripts = [], styles = [] } = transformer.getAssets()
      return Promise.all([
        loadCSS(styles),
        loadJS(scripts, { getMarkmap: () => markmap }),
      ])
    })
    .then(() => undefined)
    .catch(error => {
      // The upstream loader caches failures too; retry requires a page reload.
      console.warn('Unable to load mind-map assets', error)
    })
  return assetInitialization
}
