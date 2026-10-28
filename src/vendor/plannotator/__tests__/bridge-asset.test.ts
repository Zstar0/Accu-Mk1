import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION, BRIDGE_SCRIPT } from '../bridge-script'

describe('bridge asset', () => {
  it('public/pn-bridge.v<N>.js is byte-identical to BRIDGE_SCRIPT (run npm run build:bridge after editing the bridge)', () => {
    const asset = resolve(__dirname, '../../../../public', `pn-bridge.v${BRIDGE_PROTOCOL_VERSION}.js`)
    expect(readFileSync(asset, 'utf8')).toBe(BRIDGE_SCRIPT)
  })
})
