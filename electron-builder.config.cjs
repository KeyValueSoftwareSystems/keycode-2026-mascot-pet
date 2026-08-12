/**
 * electron-builder configuration.
 *
 * The object is produced by `createConfig` in electron-builder.create-config.cjs. That helper is
 * not attached here: electron-builder 26.15 validates every own property, including non-enumerable
 * ones, and rejects unknown keys.
 */
const { createConfig } = require('./electron-builder.create-config.cjs')
module.exports = createConfig()
