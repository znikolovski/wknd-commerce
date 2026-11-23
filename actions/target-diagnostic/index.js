/**
 * target-diagnostic — environment-bound, allowlisted Target AAM diagnostic and ID-linkage consent endpoint.
 * Raw web action, `final` inputs; disabled unless every server gate is approved (see
 * lib/target-diagnostic-action.js and docs/TARGET-AAM-DIAGNOSTIC.md). No financial use.
 */
const logging = require('@adobe/aio-lib-core-logging');
const { getStore } = require('../../lib/store');
const { createTargetDiagnosticHandler } = require('../../lib/target-diagnostic-action');

async function main(params) {
  const logger = logging('target-diagnostic', { level: params.LOG_LEVEL || 'info' });
  return createTargetDiagnosticHandler({ getStore, logger })(params);
}

exports.main = main;
