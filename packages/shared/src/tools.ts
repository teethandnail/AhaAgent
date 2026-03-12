export interface ToolCall<TInput> {
  toolName: string;
  input: TInput;
}

export interface ToolResult<TOutput> {
  ok: boolean;
  output?: TOutput;
  errorCode?: string;
  errorMessage?: string;
}

export type Sensitivity = 'public' | 'restricted' | 'secret';

export interface ReadFileInput {
  path: string;
}
export interface ReadFileOutput {
  path: string;
  content: string;
  version: string;
  sensitivity: Sensitivity;
}

export interface ListDirInput {
  path: string;
  depth?: number;
}
export interface ListDirOutput {
  entries: { name: string; path: string; type: 'file' | 'dir' }[];
}

export interface GrepInput {
  pattern: string;
  path: string;
  glob?: string;
}
export interface GrepOutput {
  matches: { file: string; line: number; text: string }[];
}

export interface DiffEditInput {
  path: string;
  expectedVersion: string;
  hunks: { oldText: string; newText: string }[];
}
export interface DiffEditOutput {
  path: string;
  version: string;
  appliedHunks: number;
}

export interface WriteFileInput {
  path: string;
  expectedVersion?: string;
  content: string;
}
export interface WriteFileOutput {
  path: string;
  version: string;
}

export interface DeleteFileInput {
  path: string;
}
export interface DeleteFileOutput {
  path: string;
}

export interface RunCommandInput {
  command: string;
  args: string[];
  cwd?: string;
  timeoutSec?: number;
}
export interface RunCommandOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BrowserSearchInput {
  query: string;
  engine?: 'duckduckgo' | 'google' | 'bing' | 'searxng';
  maxResults?: number;
}
export interface BrowserSearchOutput {
  results: Array<{ id: string; title: string; url: string; snippet: string }>;
}

export interface FetchUrlInput {
  url: string;
  timeoutSec?: number;
  maxBytes?: number;
}
export interface FetchUrlOutput {
  finalUrl: string;
  status: number;
  title: string;
  text: string;
}

export interface ExtractMainContentInput {
  html: string;
}
export interface ExtractMainContentOutput {
  title: string;
  markdown: string;
}

export type ToolName =
  | 'read_file'
  | 'list_dir'
  | 'grep'
  | 'web_search'
  | 'fetch_url'
  | 'browser_open'
  | 'extract_main_content'
  | 'diff_edit'
  | 'write_file'
  | 'delete_file'
  | 'run_command';
