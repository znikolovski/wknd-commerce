const ENVIRONMENTS = Object.freeze(['stage', 'production']);

function authoringEnvironment(namespace = process.env.__OW_NAMESPACE) {
  if (!namespace) return 'stage'; // Existing local Stage fixtures; deployed Runtime supplies namespace.
  return {
    '28538-wkndcommerce-stage': 'stage',
    '28538-wkndcommerce': 'production',
  }[namespace] || null;
}

module.exports = { ENVIRONMENTS, authoringEnvironment };
