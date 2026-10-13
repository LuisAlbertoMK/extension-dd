// Unit tests for lib/urls.js — run with: npm test
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseUrls, isPreviewUrl } = require('../lib/urls.js');

describe('parseUrls', () => {
  it('parses one URL per line and trims whitespace', () => {
    assert.deepEqual(
      parseUrls('https://a.example/x\n  https://b.example/y  \n'),
      ['https://a.example/x', 'https://b.example/y']
    );
  });

  it('adds https:// when the scheme is missing', () => {
    assert.deepEqual(parseUrls('example.com/page'), ['https://example.com/page']);
  });

  it('rejects explicit non-http(s) schemes instead of mangling them', () => {
    assert.deepEqual(parseUrls('ftp://example.com/x'), []);
    assert.deepEqual(parseUrls('javascript:alert(1)'), []);
    assert.deepEqual(parseUrls('data:text/plain,hi'), []);
  });

  it('ignores blank lines and malformed URLs', () => {
    assert.deepEqual(parseUrls('\n   \nhttps://ok.example/\nhttp:// bad url'), ['https://ok.example/']);
  });

  it('dedupes after normalization', () => {
    assert.deepEqual(
      parseUrls('https://dup.example/p\nhttps://dup.example/p\nhttps://dup.example/other'),
      ['https://dup.example/p', 'https://dup.example/other']
    );
  });
});

describe('isPreviewUrl', () => {
  it('flags preview/author/stage/localhost hosts', () => {
    assert.equal(isPreviewUrl('https://preview.example.com/x'), true);
    assert.equal(isPreviewUrl('https://author-publish.example.com/x'), true);
    assert.equal(isPreviewUrl('https://stage.example.com/'), true);
    assert.equal(isPreviewUrl('http://localhost:4502/content/x'), true);
  });

  it('passes production hosts', () => {
    assert.equal(isPreviewUrl('https://www.example.com/model/xyz'), false);
    assert.equal(isPreviewUrl('https://wwwac.shop.brandx.ford.com/model'), false);
  });

  it('returns false for garbage input', () => {
    assert.equal(isPreviewUrl('not a url'), false);
  });
});
