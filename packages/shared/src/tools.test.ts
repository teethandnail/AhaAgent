import { describe, expect, it } from 'vitest';
import type { DeleteFileInput, DeleteFileOutput, ToolName, WriteFileInput } from './tools.js';

describe('tools contracts', () => {
  it('exposes delete_file input/output contracts', () => {
    const input: DeleteFileInput = { path: 'src/app.ts' };
    const output: DeleteFileOutput = { path: 'src/app.ts' };

    expect(input.path).toBe('src/app.ts');
    expect(output.path).toBe('src/app.ts');
  });

  it('keeps write_file expectedVersion optional for creation flows', () => {
    const createInput: WriteFileInput = {
      path: 'src/new-file.ts',
      content: 'export {};\n',
    };

    expect(createInput.expectedVersion).toBeUndefined();
  });

  it('includes delete_file in the ToolName union contract', () => {
    const toolName: ToolName = 'delete_file';
    expect(toolName).toBe('delete_file');
  });
});
