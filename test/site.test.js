// Pure discovery helpers: sitemap parsing and template marker classification.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseSitemapLocs, isSitemapIndex, classifyTemplate } = require('../lib/site.js');
const { normalizeQueueUrl, hostOf } = require('../lib/urls.js');

describe('parseSitemapLocs', () => {
  it('reads every <loc> and decodes &amp;', () => {
    const xml = '<urlset><url><loc>https://a.example/x</loc></url>' +
      '<url><loc>https://a.example/y?a=1&amp;b=2</loc></url></urlset>';
    assert.deepEqual(parseSitemapLocs(xml), ['https://a.example/x', 'https://a.example/y?a=1&b=2']);
  });

  it('returns an empty list for a non-sitemap body', () => {
    assert.deepEqual(parseSitemapLocs('<html>Access Denied</html>'), []);
    assert.deepEqual(parseSitemapLocs(''), []);
    assert.deepEqual(parseSitemapLocs(null), []);
  });
});

describe('isSitemapIndex', () => {
  it('distinguishes an index from a urlset', () => {
    assert.equal(isSitemapIndex('<sitemapindex><sitemap><loc>https://a/x.xml</loc></sitemap></sitemapindex>'), true);
    assert.equal(isSitemapIndex('<urlset><url><loc>https://a/x</loc></url></urlset>'), false);
  });
});

describe('classifyTemplate', () => {
  it('promotes a page with the metrics loader to new', () => {
    const result = classifyTemplate(['https://www.ford.mx/acservices/metrics.ford.es_mx.js'], 0);
    assert.equal(result.template, 'new');
    assert.deepEqual(result.metrics_files, ['/acservices/metrics.ford.es_mx.js']);
    assert.equal(result.metrics_locale, 'es_mx');
  });

  it('detects the Lincoln loader with a hyphenated locale', () => {
    const result = classifyTemplate(['https://www.lincoln.mx/acservices/metrics.lincoln.es-mx.js?v=2'], 0);
    assert.equal(result.template, 'new');
    assert.equal(result.metrics_locale, 'es-mx');
  });

  it('never mistakes the Adobe beacon for the template marker', () => {
    const result = classifyTemplate([
      'https://smetrics.ford.com/b/ss/fordmxprod/1/JS-2.0/s123456.js'
    ], 0);
    assert.equal(result.template, 'old');
    assert.deepEqual(result.metrics_files, []);
  });

  it('does not promote on FMC.context alone but reports it', () => {
    const result = classifyTemplate([], 4);
    assert.equal(result.template, 'old');
    assert.equal(result.has_fmc_context, true);
  });

  it('dedupes repeated loaders and keeps the first locale', () => {
    const result = classifyTemplate([
      'https://www.ford.mx/acservices/metrics.ford.es_mx.js',
      'https://www.ford.mx/acservices/metrics.ford.es_mx.js?v=3'
    ], 0);
    assert.equal(result.metrics_files.length, 1);
    assert.equal(result.metrics_locale, 'es_mx');
  });
});

describe('normalizeQueueUrl', () => {
  it('drops the fragment, the trailing slash and the default port', () => {
    assert.equal(normalizeQueueUrl('https://WWW.Ford.mx/autos/#top'), 'https://www.ford.mx/autos');
    assert.equal(normalizeQueueUrl('https://www.ford.mx/'), 'https://www.ford.mx/');
  });

  it('keeps the query because some pages differ only by query', () => {
    assert.equal(
      normalizeQueueUrl('https://www.ford.mx/versiones-precios/?trim=lariat'),
      'https://www.ford.mx/versiones-precios?trim=lariat'
    );
  });

  it('rejects assets, non-http schemes and garbage', () => {
    assert.equal(normalizeQueueUrl('https://www.ford.mx/manual.pdf'), null);
    assert.equal(normalizeQueueUrl('https://www.ford.mx/foto.JPG'), null);
    assert.equal(normalizeQueueUrl('mailto:someone@example.com'), null);
    assert.equal(normalizeQueueUrl('not a url'), null);
    assert.equal(normalizeQueueUrl(''), null);
  });

  it('resolves relative links against a base', () => {
    assert.equal(
      normalizeQueueUrl('/autos/mustang', 'https://www.ford.mx/blog/'),
      'https://www.ford.mx/autos/mustang'
    );
  });
});

describe('hostOf', () => {
  it('returns the lowercase host and an empty string for garbage', () => {
    assert.equal(hostOf('https://WWW.Ford.MX/autos'), 'www.ford.mx');
    assert.equal(hostOf('nope'), '');
  });
});
