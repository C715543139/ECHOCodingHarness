import { describe, expect, it } from 'vitest';

import { formatLabeled, formatRuleTitle } from '../../../src/cli/render-layout.js';
import { stripAnsi, visibleWidth, wrapToWidth } from '../../../src/cli/render-width.js';

describe('visible width and wrapping', () => {
  it('counts CJK characters as double width and ignores ANSI', () => {
    expect(visibleWidth('ABC')).toBe(3);
    expect(visibleWidth('检查')).toBe(4);
    expect(visibleWidth('\u001B[36mECHO\u001B[0m')).toBe(4);
    expect(stripAnsi('\u001B[31mFAIL\u001B[0m')).toBe('FAIL');
  });

  it('wraps CJK by display width and ASCII on spaces', () => {
    expect(wrapToWidth('检查当前测试失败并修复问题', 8)).toEqual([
      '检查当前',
      '测试失败',
      '并修复问',
      '题',
    ]);
    expect(wrapToWidth('one two three four', 10)).toEqual(['one two', 'three four']);
  });

  it('keeps hanging body alignment for long ASCII commands', () => {
    const lines = formatLabeled(
      'COMMAND',
      'Get-ChildItem -Force | Select-Object Name, Length, LastWriteTime',
      { color: false, unicode: false, columns: 48 },
    );
    expect(lines[0]?.startsWith('COMMAND    | ')).toBe(true);
    expect(lines[1]?.startsWith('           | ')).toBe(true);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(48);
    }
  });

  it('stacks when the terminal cannot fit the label column and a readable body', () => {
    const lines = formatLabeled('TOOL', 'run_command', {
      color: false,
      unicode: false,
      columns: 28,
    });
    expect(lines[0]).toBe('TOOL');
    expect(lines[1]).toBe('    run_command');
  });

  it('builds Unicode and ASCII step titles without relying on color', () => {
    expect(formatRuleTitle('Step 6', { color: false, unicode: true, columns: 40 })).toContain(
      '── Step 6 ',
    );
    expect(formatRuleTitle('Step 6', { color: false, unicode: false, columns: 40 })).toContain(
      '-- Step 6 ',
    );
    expect(
      formatRuleTitle('Step 6', { color: true, unicode: false, columns: 40 }, 'blueBold').includes(
        '\u001B[',
      ),
    ).toBe(true);
  });
});
