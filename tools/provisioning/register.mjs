/**
 * Installs the TypeScript resolution hook used by the provisioning CLI.
 *
 * Loaded with `node --import ./tools/provisioning/register.mjs`.
 */
import { register } from 'node:module'

register('./loader.mjs', import.meta.url)
