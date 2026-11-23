module.exports = {
  devtool: 'inline-source-map',
  module: {
    rules: [
      {
        // Preserve dynamic array iteration instead of tree-shaking JSON named exports.
        test: /promotion-authoring-audiences\.json$/,
        type: 'asset/source'
      },
      {
        // includes, excludes are in tsconfig.json
        test: /\.ts?$/,
        exclude: /node_modules/,
        use: 'ts-loader'
      }
    ]
  },
  output: {
    filename: 'bundle.js'
  }
}