import esbuildPluginTsc from 'esbuild-plugin-tsc';

export default () => ({
  bundle: true,
  minify: true,
  sourcemap: false,
  exclude: ['@aws-sdk/*'],
  external: ['@aws-sdk/*'],
  conditions: ['module-sync'],
  plugins: [
    esbuildPluginTsc(),
  ],
});
