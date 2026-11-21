/**
 * Unit tests for pure TypeScript modules (no react-native import), e.g. `npx jest --ci src/igPost`.
 * jest is not a dependency: `npx jest` fetches it. TypeScript is stripped with the Babel packages Expo already installs
 * (hoisted in node_modules), without a babel.config.js, so Metro's own Babel setup is untouched.
 */
module.exports = {
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'babel-jest',
      {
        babelrc: false,
        configFile: false,
        presets: [require.resolve('@babel/preset-typescript')],
        plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
      },
    ],
  },
};
