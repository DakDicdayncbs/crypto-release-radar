import assert from 'node:assert/strict';

// Independent reader for test expectations. Accept quoted and unquoted fields;
// never split a physical line, since a quoted field can contain CR/LF.
export function readCsv(input) {
  const rows = [];
  let row = [], field = '', state = 'start';
  const finishField = () => { row.push(field); field = ''; state = 'start'; };
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (state === 'quoted') {
      if (char !== '"') field += char;
      else if (input[i + 1] === '"') { field += '"'; i++; }
      else state = 'closed';
    } else if (char === ',' || char === '\r') {
      finishField();
      if (char === '\r') {
        assert.equal(input[++i], '\n', 'Record terminator must be CRLF');
        rows.push(row); row = [];
      }
    } else if (char === '"') {
      assert.equal(state, 'start', 'Quote only at field start');
      state = 'quoted';
    } else {
      assert.notEqual(state, 'closed', 'Trailing characters after closing quote');
      assert.notEqual(char, '\n', 'Bare LF outside quoted field');
      field += char; state = 'unquoted';
    }
  }
  assert.notEqual(state, 'quoted', 'Unclosed quoted field');
  assert.equal(state, 'start', 'Missing final CRLF');
  assert.equal(row.length, 0, 'Unterminated record');
  assert.equal(field, '');
  assert.ok(rows.length > 0, 'Header required');
  for (const record of rows) assert.equal(record.length, rows[0].length, 'Equal row widths');
  return rows;
}

export function csvObjects(input) {
  const [header, ...rows] = readCsv(input);
  return rows.map(row => Object.fromEntries(header.map((key, index) => [key, row[index]])));
}
