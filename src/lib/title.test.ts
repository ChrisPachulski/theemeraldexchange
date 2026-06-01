import { describe, expect, it } from 'vitest'
import { stripArticle } from './title'

describe('stripArticle', () => {
  it('strips a leading "the "', () => {
    expect(stripArticle('The Matrix')).toBe('Matrix')
  })

  it('strips a leading "a "', () => {
    expect(stripArticle('A Beautiful Mind')).toBe('Beautiful Mind')
  })

  it('strips a leading "an "', () => {
    expect(stripArticle('An American Tail')).toBe('American Tail')
  })

  it('is case-insensitive on the article', () => {
    expect(stripArticle('the matrix')).toBe('matrix')
    expect(stripArticle('THE MATRIX')).toBe('MATRIX')
    expect(stripArticle('tHe Matrix')).toBe('Matrix')
  })

  it('only strips the first article, leaving later words intact', () => {
    expect(stripArticle('The A Team')).toBe('A Team')
    expect(stripArticle('A The Thing')).toBe('The Thing')
  })

  it('preserves casing of the remaining title', () => {
    expect(stripArticle('The LEGO Movie')).toBe('LEGO Movie')
  })

  it('does not strip article-prefixed words without trailing whitespace', () => {
    expect(stripArticle('Theory of Everything')).toBe('Theory of Everything')
    expect(stripArticle('Anvil')).toBe('Anvil')
    expect(stripArticle('Aardvark')).toBe('Aardvark')
    expect(stripArticle('Thessaloniki')).toBe('Thessaloniki')
  })

  it('requires whitespace immediately after the article (no punctuation match)', () => {
    expect(stripArticle('The-Thing')).toBe('The-Thing')
    expect(stripArticle('A.I.')).toBe('A.I.')
  })

  it('treats a tab as whitespace after the article', () => {
    expect(stripArticle('The\tMatrix')).toBe('Matrix')
  })

  it('leaves titles with no leading article unchanged', () => {
    expect(stripArticle('Blade Runner')).toBe('Blade Runner')
    expect(stripArticle('Inception')).toBe('Inception')
  })

  it('does not strip a non-leading article', () => {
    expect(stripArticle('Once Upon the Time')).toBe('Once Upon the Time')
  })

  it('handles an empty string', () => {
    expect(stripArticle('')).toBe('')
  })

  it('handles an article that is the entire string with no following word', () => {
    expect(stripArticle('The')).toBe('The')
    expect(stripArticle('A')).toBe('A')
  })

  it('produces the expected alphabetical sort ordering', () => {
    const titles = ['The Zebra', 'Apple', 'An Owl', 'A Banana', 'Cat']
    const sorted = [...titles].sort((a, b) =>
      stripArticle(a).localeCompare(stripArticle(b)),
    )
    // Apple, A Banana, Cat, An Owl, The Zebra
    expect(sorted).toEqual(['Apple', 'A Banana', 'Cat', 'An Owl', 'The Zebra'])
  })
})
