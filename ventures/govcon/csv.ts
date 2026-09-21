/**
 * Streaming RFC 4180 CSV parser.
 *
 * Written by hand rather than pulled in as a dependency because the SAM.gov
 * extract is a multi-hundred-megabyte file whose Description column contains
 * embedded commas, doubled quotes and raw newlines. A line-splitting parser
 * corrupts those rows silently, which is the worst failure mode here: it would
 * publish a mangled solicitation rather than fail. This consumes arbitrary
 * chunks and emits complete rows, so memory stays flat regardless of file size.
 *
 * Deliberately lenient in one place: a stray quote inside an unquoted field is
 * treated as content instead of an error, because the real feed contains them
 * and aborting the whole ingest over one malformed cell is worse than keeping it.
 */

export type RowHandler = (row: string[]) => void;

export class CsvStreamParser {
  private field = '';
  private row: string[] = [];
  private inQuoted = false;
  private afterQuote = false;
  private dirty = false; // any content seen for the current record

  constructor(private readonly onRow: RowHandler) {}

  write(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];

      if (this.inQuoted && !this.afterQuote) {
        // Inside quotes everything is literal until the closing quote.
        if (c === '"') this.afterQuote = true;
        else this.field += c;
        continue;
      }

      if (this.afterQuote) {
        if (c === '"') {
          this.field += '"'; // "" is an escaped quote
          this.afterQuote = false;
          continue;
        }
        // The quote really did close the field.
        this.inQuoted = false;
        this.afterQuote = false;
        // fall through and handle c as an ordinary delimiter
      }

      if (c === '"' && this.field === '') {
        this.inQuoted = true;
        this.dirty = true;
      } else if (c === ',') {
        this.endField();
      } else if (c === '\n') {
        this.endField();
        this.endRow();
      } else if (c === '\r') {
        // part of CRLF; the \n does the work
      } else {
        this.field += c;
        this.dirty = true;
      }
    }
  }

  /** Flush a trailing record that ended without a newline. */
  end(): void {
    if (this.inQuoted || this.afterQuote || this.dirty || this.row.length > 0) {
      this.endField();
      this.endRow();
    }
  }

  private endField(): void {
    this.row.push(this.field);
    this.field = '';
    this.inQuoted = false;
    this.afterQuote = false;
    this.dirty = true;
  }

  private endRow(): void {
    // Skip blank lines rather than emitting a phantom one-empty-field record.
    if (this.row.length === 1 && this.row[0] === '') {
      this.row = [];
      this.dirty = false;
      return;
    }
    this.onRow(this.row);
    this.row = [];
    this.dirty = false;
  }
}

/** Convenience wrapper for whole strings (tests, small files). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const p = new CsvStreamParser((r) => rows.push(r));
  p.write(text);
  p.end();
  return rows;
}
