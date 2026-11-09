'use strict';

// Reads every row of a query in pages, so a result is never silently cut short by the API's row cap
// (PostgREST returns at most its "max rows" setting per request, 1000 by default, and does not say it stopped).
//
//   const { rows, error, truncated } = await readPaged(() =>
//     supabase.from('t').select('a, b').gte('day', x).order('day').order('id'));   // the order must be unique (add a key column)
//
// - makeQuery builds a fresh query each time (a builder cannot be reused after it has run).
// - Pages advance by the number of rows actually returned, and only an EMPTY page ends the read, so it works whatever the
//   server's cap is (even one below pageSize).
// - maxRows is a safety stop: when it is hit the rows read so far come back with truncated: true, so the caller can refuse
//   to use a partial answer instead of showing it as complete.
async function readPaged(makeQuery, { pageSize = 1000, maxRows = 200000 } = {}) {
  const rows = [];
  let from = 0;
  for (;;) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) return { rows, error, truncated: false };
    if (!data || data.length === 0) return { rows, error: null, truncated: false };
    rows.push(...data);
    from += data.length;
    if (rows.length >= maxRows) return { rows, error: null, truncated: true };
  }
}

module.exports = { readPaged };
