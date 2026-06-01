import { describe, it, expect } from 'vitest'
import { parseJsonObject, asString, asNumber } from './parseJson.js'

describe('parseJsonObject', () => {
  it('returns the object for a valid JSON object string', () => {
    expect(parseJsonObject('{"id":42,"title":"Foo"}')).toEqual({ id: 42, title: 'Foo' })
  })

  it('returns null for empty string', () => {
    expect(parseJsonObject('')).toBeNull()
  })

  it('returns null for whitespace-only string', () => {
    expect(parseJsonObject('   \n\t  ')).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseJsonObject('{not json')).toBeNull()
  })

  it('returns null for the literal null', () => {
    expect(parseJsonObject('null')).toBeNull()
  })

  it('returns null for a JSON array', () => {
    expect(parseJsonObject('[1,2,3]')).toBeNull()
  })

  it('returns null for a bare number', () => {
    expect(parseJsonObject('42')).toBeNull()
  })

  it('returns null for a bare string', () => {
    expect(parseJsonObject('"hi"')).toBeNull()
  })

  it('returns null for a bare boolean', () => {
    expect(parseJsonObject('true')).toBeNull()
  })

  it('round-trips nested structure intact', () => {
    const raw = '{"a":1,"list":[1,2,{"deep":true}],"nested":{"x":"y"}}'
    expect(parseJsonObject(raw)).toEqual({
      a: 1,
      list: [1, 2, { deep: true }],
      nested: { x: 'y' },
    })
  })
})

describe('asString', () => {
  it('returns the string when the key holds a string', () => {
    expect(asString({ title: 'Foo' }, 'title')).toBe('Foo')
  })

  it('returns undefined for a number value', () => {
    expect(asString({ title: 5 }, 'title')).toBeUndefined()
  })

  it('returns undefined for a missing key', () => {
    expect(asString({}, 'title')).toBeUndefined()
  })

  it('returns undefined for a null value', () => {
    expect(asString({ title: null }, 'title')).toBeUndefined()
  })

  it('returns undefined for an array value', () => {
    expect(asString({ title: ['a'] }, 'title')).toBeUndefined()
  })
})

describe('asNumber', () => {
  it('returns the number for a finite number', () => {
    expect(asNumber({ id: 42 }, 'id')).toBe(42)
  })

  it('returns undefined for NaN', () => {
    expect(asNumber({ id: NaN }, 'id')).toBeUndefined()
  })

  it('returns undefined for Infinity', () => {
    expect(asNumber({ id: Infinity }, 'id')).toBeUndefined()
  })

  it('returns undefined for a string-number', () => {
    expect(asNumber({ id: '5' }, 'id')).toBeUndefined()
  })

  it('returns undefined for a missing key', () => {
    expect(asNumber({}, 'id')).toBeUndefined()
  })
})
