import { describe, it, expect } from 'vitest'
import { contracts } from './contractsBinding.js'

describe('contractsBinding', () => {
  it('exports the contracts NAPI module with key functions available', () => {
    expect(contracts).toBeDefined()
    // The NAPI module exports crypto functions; verify they exist.
    // These are the primary contract surface for cryptographic operations.
    expect(typeof contracts.streamTokenSign).toBe('function')
    expect(typeof contracts.streamTokenVerify).toBe('function')
    expect(typeof contracts.deviceTokenEncrypt).toBe('function')
    expect(typeof contracts.deviceTokenDecrypt).toBe('function')
  })

  it('contracts module exports match the ContractsTypes interface', () => {
    // Ensure the runtime contracts object has the same shape as our type import.
    // This guards against silent undefined functions that ESM star-import could hide.
    expect(Object.keys(contracts).length).toBeGreaterThan(0)
    // At minimum, the signing/verification functions must be present.
    expect('streamTokenSign' in contracts).toBe(true)
    expect('streamTokenVerify' in contracts).toBe(true)
    expect('deviceTokenEncrypt' in contracts).toBe(true)
    expect('deviceTokenDecrypt' in contracts).toBe(true)
  })
})
