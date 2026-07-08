// GH#264: newline-delimited JSON-RPC framing (what StdioServerTransport
// speaks). Callers must decode chunks to strings BEFORE push() — splitting
// Buffers byte-wise could cut a multi-byte UTF-8 codepoint in half.
export class LineSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    return parts.filter((line) => line.length > 0);
  }

  flush(): string | null {
    const tail = this.buf;
    this.buf = '';
    return tail.length > 0 ? tail : null;
  }
}
