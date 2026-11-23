const { z } = require('zod');
const S = require('./promotion-schema');
const { createDefinition } = require('./promotion-tool-schema');
const audiences = require('./promotion-authoring-audiences');
const { validateDraftDefinition, draftTools } = require('./promotion-drafts');
const { ENVIRONMENTS, authoringEnvironment } = require('./promotion-authoring-environment');

const SCHEMA = 'wknd.promotion-authoring/fixture-v1';
const previewSchema = z.strictObject({
  environment: z.enum(ENVIRONMENTS),
  audienceKey: z.enum([...new Set(audiences.map((a) => a.key))]),
  promotion: z.strictObject({ ...createDefinition, enabled: z.literal(false).optional() }),
});

function authoringCatalogue(environment = 'stage') {
  return {
    schema: environment === 'stage' ? SCHEMA : 'wknd.promotion-authoring/v1',
    mode: environment === 'stage' ? 'fixture' : 'authoring', environment,
    audiences: audiences.filter((a) => a.env === environment).map((a) => ({ ...a })),
    financialAuthorization: false,
    activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
    availability: { status: 'unavailable', reason: 'FINANCIAL_AUTHORITY_NOT_PRESENT' },
  };
}

function previewAudienceDraft(args, environment = 'stage') {
  const catalogue = authoringCatalogue(environment);
  const base = {
    schema: catalogue.schema, mode: catalogue.mode, environment, persisted: false, financialAuthorization: false,
    activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
    availability: catalogue.availability,
  };
  const invalid = (fields) => ({
    ...base, ok: false,
    error: { code: 'INVALID_DRAFT', message: 'Fixture draft arguments are invalid.', fields: fields.slice(0, S.LIMITS.fieldErrors) },
  });
  const argumentError = S.checkArgumentSize(args);
  if (argumentError) return invalid([{ path: '/', code: argumentError, message: S.ERRORS[argumentError][0] }]);
  const parsed = previewSchema.safeParse(args);
  if (!parsed.success) {
    return invalid(parsed.error.issues.map((issue) => ({
      path: `/${issue.path.join('/')}`, code: issue.code, message: issue.message,
    })));
  }
  if (parsed.data.environment !== environment) {
    return invalid([{ path: '/environment', code: 'ENVIRONMENT_MISMATCH', message: 'Use the server authoring environment.' }]);
  }
  const validated = validateDraftDefinition({
    ...parsed.data.promotion,
    audienceRestriction: { environment, key: parsed.data.audienceKey, version: 1 },
  });
  if (!validated.ok) return invalid(validated.error.fields);
  const audience = catalogue.audiences.find((a) => a.key === parsed.data.audienceKey);
  if (!audience) return invalid([{ path: '/audienceKey', code: 'AUDIENCE_UNAVAILABLE', message: 'Canonical reference is unavailable in this environment.' }]);
  return {
    ...base, ok: true, environment,
    fixturePreview: { audience: { ...audience }, promotion: { ...validated.promotion, audienceRestriction: null } },
  };
}

function authoringTools() {
  return [
    ...draftTools(),
    {
      name: 'list_promotion_authoring_audiences',
      description: 'Server-environment authoring catalogue: canonical Stage/Production AAM Interest/Planner references, NOT membership evidence or financial eligibility.',
      schema: z.strictObject({}), readOnly: true,
      run: (_store, _args, context = {}) => authoringCatalogue(context.authoringEnvironment),
    },
    {
      name: 'preview_audience_promotion_draft',
      description: 'Validate a disabled draft in the server Stage/Production environment. Financial availability remains unavailable. Does not persist, activate, check membership, or authorize a benefit; live v1 remains audienceRestriction:null.',
      schema: previewSchema, readOnly: true, serviceValidated: true,
      argumentError: () => {
        const { schema, mode, environment, activation, availability } = authoringCatalogue(authoringEnvironment());
        return {
          schema, mode, environment, activation, availability, ok: false, persisted: false, financialAuthorization: false,
          error: { code: 'INVALID_DRAFT', message: 'Disabled draft exceeds argument bounds.' },
        };
      },
      run(_store, args, context) {
        const result = previewAudienceDraft(args, context.authoringEnvironment);
        if (!result.ok) context.logger.error('mcp.authoring.rejected', { code: result.error.code, correlationId: context.correlationId });
        return result;
      },
    },
  ];
}

module.exports = { SCHEMA, previewSchema, authoringCatalogue, previewAudienceDraft, authoringTools };
