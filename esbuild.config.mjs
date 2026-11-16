import esbuildPluginTsc from 'esbuild-plugin-tsc';

export default () => ({
  bundle: true,
  minify: true,
  keepNames: true,
  sourcemap: 'linked',
  sourcesContent: false,
  exclude: ['@aws-sdk/*'],
  external: ['@aws-sdk/*'],
  conditions: ['module-sync'],
  plugins: [
    esbuildPluginTsc(),
  ],
});
