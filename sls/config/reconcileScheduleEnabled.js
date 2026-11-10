module.exports = {
  enabled: (process.env.ASAAS_BASE_URL ?? '').trim() === 'https://api.asaas.com',
};
