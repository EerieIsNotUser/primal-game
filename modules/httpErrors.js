// Express 4 does not catch a rejected async handler (it becomes an unhandled
// rejection). asyncRoute forwards it to next(err); httpErrorHandler is the
// last middleware and answers with a short JSON body: no stack, no HTML.

const asyncRoute = (fn) => (req, res, next) => {
  Promise.resolve().then(() => fn(req, res, next)).catch(next);
};

function httpErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  const status = err.status ?? err.statusCode;
  if (status >= 400 && status < 500) {
    const msg = err.type === 'entity.too.large' ? 'Payload too large'
      : err.type === 'entity.parse.failed' ? 'Body is not valid JSON'
      : 'Bad request';
    return res.status(status).json({ error: msg });
  }
  console.error('[http] Unhandled route error:', err);
  res.status(500).json({ error: 'Internal error' });
}

module.exports = { asyncRoute, httpErrorHandler };
