import { describe, expect, it } from 'vitest';
import {
  convertEngineOutput,
  engineTablesToMarkdown,
  markdownToSafeHtml,
} from '../src/lib/ai-markdown';

/*
 * Phase 4b adversarial units (D10/F3): OCR output is untrusted. Every
 * dangerous glyph sequence must come out of the export pipeline ONLY as
 * escaped text — never executable markup, never a javascript: link.
 */

describe('engineTablesToMarkdown', () => {
  it('converts engine HTML tables to pipe rows (SPIKE Q5 shape)', () => {
    const raw = [
      '# BÁO CÁO',
      '<table border="1"><tr><td>Mã hàng</td><td>Thành tiền (VND)</td></tr>',
      '<tr><td>BT-031</td><td>12.450.000</td></tr></table>',
    ].join('\n');
    const md = engineTablesToMarkdown(raw);
    expect(md).toContain('# BÁO CÁO');
    expect(md).toContain('| Mã hàng | Thành tiền (VND) |');
    expect(md).toContain('| BT-031 | 12.450.000 |');
    expect(md).not.toContain('<table');
  });

  it('escapes dangerous glyphs inside table cells', () => {
    const raw = '<table><tr><td>&lt;script&gt;alert(1)&lt;/script&gt;</td><td>x</td></tr></table>';
    const md = engineTablesToMarkdown(raw);
    expect(md).toContain('| <script>alert(1)</script> | x |'); // plain TEXT in markdown
    const html = markdownToSafeHtml(md);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('a literal | inside a cell stays ONE cell through the round trip (review P2-4)', () => {
    const raw = '<table><tr><td>a|b</td><td>c</td></tr></table>';
    const md = engineTablesToMarkdown(raw);
    expect(md).toContain('| a\\|b | c |'); // escaped in the markdown form
    const html = markdownToSafeHtml(md);
    expect(html).toContain('<td>a|b</td>'); // unescaped back into one cell
    expect((html.match(/<td>/g) ?? []).length).toBe(2); // not split into 3 columns
  });
});

describe('markdownToSafeHtml (D10)', () => {
  it('<script> glyph text stays escaped — never executable', () => {
    const html = markdownToSafeHtml('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('<img onerror> glyph text stays escaped', () => {
    const html = markdownToSafeHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('javascript: links degrade to plain text; http links survive whitelisted', () => {
    const bad = markdownToSafeHtml('[x](javascript:alert(1))');
    expect(bad).not.toContain('<a ');
    expect(bad).toContain('javascript:alert(1)');

    const good = markdownToSafeHtml('[site](https://example.com)');
    expect(good).toContain('<a href="https://example.com"');
    const data = markdownToSafeHtml('[d](data:text/html,evil)');
    expect(data).not.toContain('<a href="data:');
  });

  it('event-handler text cannot become an attribute (escape-first guarantee)', () => {
    const html = markdownToSafeHtml('**onerror=**"alert(1)"');
    // as part of a REAL tag — never; as inert text — fine
    expect(html).not.toMatch(/<(script|iframe|img)/i);
    expect(html).toContain('&quot;alert(1)&quot;');
  });

  it('headings/bold/lists/code map into the whitelist', () => {
    const html = markdownToSafeHtml('# Tiêu đề\n\n**đậm** *nghiêng* `code`\n\n- một\n1. hai');
    expect(html).toContain('<h1>Tiêu đề</h1>');
    expect(html).toContain('<strong>đậm</strong>');
    expect(html).toContain('<em>nghiêng</em>');
    expect(html).toContain('<code>code</code>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>một</li>');
    expect(html).toContain('<ol>');
    expect(html).toContain('<li>hai</li>');
    expect(html).not.toMatch(/<(?!\/?(h[1-4]|p|ul|ol|li|table|tbody|tr|td|th|code|strong|em|a|br)\b)[a-z]/);
  });
});

describe('convertEngineOutput (full pipeline)', () => {
  const RAW = [
    '<table><tr><td>Mã</td><td>Tiền</td></tr><tr><td>BT-1</td><td>1.000</td></tr></table>',
    'Ghi chú: total &lt; 100 — ok',
  ].join('\n');

  it('produces all three shapes; text stays raw, markdown normalized, html safe', () => {
    const out = convertEngineOutput(RAW);
    expect(out.text).toBe(RAW);
    expect(out.markdown).toContain('| Mã | Tiền |');
    expect(out.markdown).toContain('| BT-1 | 1.000 |');
    expect(out.html).toContain('<!doctype html');
    expect(out.html).toContain('<td>Mã</td>');
    expect(out.html).not.toMatch(/<script/i);
  });

  it('adversarial raw engine output survives the pipeline escaped', () => {
    const evil = [
      '<table><tr><td><script>alert(1)</script></td><td><img src=x onerror=alert(2)></td></tr></table>',
      '[click](javascript:alert(3))',
      '<iframe src=//evil></iframe>',
    ].join('\n');
    const out = convertEngineOutput(evil);
    // The .md export is PLAIN TEXT — literal tag glyph text is normal file
    // content. The executable surface is the .html export + preview: there,
    // everything dangerous must exist ONLY escaped.
    // no executable tag may exist; escaped entity text (which contains
    // things like " onerror=" as INERT characters) is fine and expected
    expect(out.html).not.toMatch(/<(script|iframe|img)/i);
    expect(out.html).not.toMatch(/href="javascript:/i);
    expect(out.html).toContain('&lt;script&gt;alert(1)');
    expect(out.html).toContain('&lt;iframe');
    expect(out.html).toContain('alert(3)');
    // markdown keeps the glyph text (and the javascript: link degrades there)
    expect(out.markdown).toContain('alert(1)');
    expect(out.markdown).toContain('[click](javascript:alert(3))');
  });
});
