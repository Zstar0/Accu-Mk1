// Writes public/pn-bridge.v<N>.js from the vendored bridge string (spec §7.2).
// Node 22.6+ strips the .ts import's types natively; the dev boxes run Node 24.
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_SCRIPT,
} from '../src/vendor/plannotator/bridge-script.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = resolve(root, 'public', `pn-bridge.v${BRIDGE_PROTOCOL_VERSION}.js`)
writeFileSync(out, BRIDGE_SCRIPT)
console.log(`wrote ${out} (${BRIDGE_SCRIPT.length} chars)`)
