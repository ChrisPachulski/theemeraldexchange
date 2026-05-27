// Platform-resolving loader for the napi-rs native module.
// Picks the right .node binary for the current host triple and re-exports
// every #[napi]-decorated symbol declared in src/lib.rs.
//
// Generated bindings would normally do this, but napi-rs v3 CLI does not
// emit a JS loader for napi 2.16 crates — hand-authored, kept minimal.

const { platform, arch } = process

function loadBinding() {
  const triples = []
  if (platform === 'darwin') {
    if (arch === 'arm64') triples.push('darwin-arm64')
    if (arch === 'x64') triples.push('darwin-x64')
  } else if (platform === 'linux') {
    if (arch === 'arm64') triples.push('linux-arm64-gnu', 'linux-arm64-musl')
    if (arch === 'x64') triples.push('linux-x64-gnu', 'linux-x64-musl')
  } else if (platform === 'win32') {
    if (arch === 'x64') triples.push('win32-x64-msvc')
    if (arch === 'arm64') triples.push('win32-arm64-msvc')
  }
  const errors = []
  for (const triple of triples) {
    try {
      return require(`./emerald-contracts-napi.${triple}.node`)
    } catch (e) {
      errors.push(`${triple}: ${e.message}`)
    }
  }
  throw new Error(
    `Failed to load @emerald/contracts-napi for ${platform}-${arch}. ` +
      `Tried: ${triples.join(', ')}. ` +
      `Build with \`npm run build -w @emerald/contracts-napi\` (or \`napi build --platform --release\` inside the crate). ` +
      `Errors:\n${errors.join('\n')}`,
  )
}

module.exports = loadBinding()
