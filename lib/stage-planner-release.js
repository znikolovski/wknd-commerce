/* global WKND_STAGE_PLANNER_RELEASE */
const { CONFIG_KEYS } = require('./target-diagnostic-action');

const STAGE_NAMESPACE = '28538-wkndcommerce-stage';
const RELEASE_KEYS = Object.freeze(CONFIG_KEYS.filter((key) => key.startsWith('TARGET_')));

/**
 * The approved Stage ZIP may prepend this lexical constant. It is never supplied by a request,
 * Runtime input or environment label. Ordinary source builds have no release opt-in.
 */
function stagePlannerParams(params, namespace, release = (
  typeof WKND_STAGE_PLANNER_RELEASE === 'undefined' ? null : WKND_STAGE_PLANNER_RELEASE
)) {
  if (namespace !== STAGE_NAMESPACE || release?.enabled !== true) return params;
  const config = release.parameters || {};
  if (config.TARGET_DIAG_ENVIRONMENT !== 'stage'
    || config.TARGET_DIAG_STAGE_NAMESPACE !== STAGE_NAMESPACE) return params;
  return {
    ...params,
    ...Object.fromEntries(RELEASE_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]])),
    STAGE_AAM_GENERAL_OFFERS_ENABLED: 'true',
  };
}

module.exports = { STAGE_NAMESPACE, RELEASE_KEYS, stagePlannerParams };
