const origins = (process.env.CORS_ALLOWED_ORIGINS ?? '')
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

module.exports = origins.length === 0
  ? true
  : {
      allowedOrigins: origins,
      allowedHeaders: ['Content-Type', 'Authorization'],
      allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    };
