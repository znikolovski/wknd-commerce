/* global WKND_STAGE_PLANNER_RELEASE */
const { CONFIG_KEYS } = require('./target-diagnostic-action');

const STAGE_NAMESPACE = '28538-wkndcommerce-stage';
const PRODUCTION_NAMESPACE = '28538-wkndcommerce';
const RELEASE_KEYS = Object.freeze(CONFIG_KEYS.filter((key) => key.startsWith('TARGET_')));

/**
 * The approved Stage ZIP may prepend this lexical constant. It is never supplied by a request,
 * Runtime input or environment label. Ordinary source builds have no release opt-in.
 */
function stagePlannerParams(params, namespace, release = (
  typeof WKND_STAGE_PLANNER_RELEASE === 'undefined' ? null : WKND_STAGE_PLANNER_RELEASE
)) {
  if (release?.enabled !== true) return params;
  const config = release.parameters || {};
  const stage = namespace === STAGE_NAMESPACE && config.TARGET_DIAG_ENVIRONMENT === 'stage'
    && config.TARGET_DIAG_STAGE_NAMESPACE === STAGE_NAMESPACE;
  const production = productionDemoEnabled(namespace, release);
  if (!stage && !production) return params;
  return {
    ...params,
    ...Object.fromEntries(RELEASE_KEYS.filter((key) => config[key] !== undefined).map((key) => [key, config[key]])),
    ...(stage ? { STAGE_AAM_GENERAL_OFFERS_ENABLED: 'true' } : {}),
  };
}

function stageFactsEnabled(namespace, release = (
  typeof WKND_STAGE_PLANNER_RELEASE === 'undefined' ? null : WKND_STAGE_PLANNER_RELEASE
)) {
  return release?.enabled === true && release.factsOnly === true
    && ((namespace === STAGE_NAMESPACE && release.parameters?.TARGET_DIAG_ENVIRONMENT === 'stage'
      && release.parameters?.TARGET_DIAG_STAGE_NAMESPACE === STAGE_NAMESPACE)
      || productionDemoEnabled(namespace, release));
}

function stageWindowEnabled(namespace, release = (
  typeof WKND_STAGE_PLANNER_RELEASE === 'undefined' ? null : WKND_STAGE_PLANNER_RELEASE
)) {
  return namespace === STAGE_NAMESPACE && stageFactsEnabled(namespace, release) && release.cartWindow === true;
}

function productionDemoEnabled(namespace, release = (
  typeof WKND_STAGE_PLANNER_RELEASE === 'undefined' ? null : WKND_STAGE_PLANNER_RELEASE
)) {
  return namespace === PRODUCTION_NAMESPACE && release?.enabled === true && release.productionDemo === true
    && release.parameters?.TARGET_DIAG_ENVIRONMENT === 'production'
    && release.parameters?.TARGET_DIAG_PRODUCTION_NAMESPACE === PRODUCTION_NAMESPACE
    && release.parameters?.TARGET_DIAG_TARGET_CONFIG_APPROVED === 'true';
}

function stageWorkerParams(params, namespace, release = (
  typeof WKND_STAGE_PLANNER_RELEASE === 'undefined' ? null : WKND_STAGE_PLANNER_RELEASE
)) {
  const config = stagePlannerParams(params, namespace, release);
  if (!stageWindowEnabled(namespace, release)) return config;
  return { ...config, AUTH0_ISSUER: release.parameters.AUTH0_ISSUER, AUTH0_AUDIENCE: release.parameters.AUTH0_AUDIENCE };
}

module.exports = {
  STAGE_NAMESPACE, PRODUCTION_NAMESPACE, RELEASE_KEYS, stagePlannerParams, stageFactsEnabled,
  stageWindowEnabled, stageWorkerParams, productionDemoEnabled,
};
