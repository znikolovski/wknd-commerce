const { z } = require('zod');
const S = require('./promotion-schema');
const { createDefinition } = require('./promotion-tool-schema');
const audiences = require('../data/promotion-authoring-audiences.json');
const { validateDraftDefinition, draftTools } = require('./promotion-drafts');

const SCHEMA = 'wknd.promotion-authoring/fixture-v1';
const previewSchema = z.strictObject({
  environment: z.literal('stage'),
  audienceKey: z.enum(audiences.map((a) => a.key)),
  promotion: z.strictObject({ ...createDefinition, enabled: z.literal(false).optional() }),
});

function authoringCatalogue() {
  return {
    schema: SCHEMA, mode: 'fixture', environment: 'stage',
    audiences: audiences.map((a) => ({ ...a })),
    financialAuthorization: false,
    activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
  };
}

function previewAudienceDraft(args) {
  const base = {
    schema: SCHEMA, mode: 'fixture', persisted: false, financialAuthorization: false,
    activation: { blocked: true, reason: 'PROVIDER_NOT_VERIFIED' },
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
  const validated = validateDraftDefinition({
    ...parsed.data.promotion,
    audienceRestriction: { environment: 'stage', key: parsed.data.audienceKey, version: 1 },
  });
  if (!validated.ok) return invalid(validated.error.fields);
  const audience = audiences.find((a) => a.key === parsed.data.audienceKey);
  return {
    ...base, ok: true, environment: 'stage',
    fixturePreview: { audience: { ...audience }, promotion: { ...validated.promotion, audienceRestriction: null } },
  };
}

function authoringTools() {
  return [
    ...draftTools(),
    {
      name: 'list_promotion_authoring_audiences',
      description: 'Fixture-only Stage authoring catalogue: canonical AAM Interest/Planner metadata, NOT membership evidence or financial eligibility.',
      schema: z.strictObject({}), readOnly: true,
      run: () => authoringCatalogue(),
    },
    {
      name: 'preview_audience_promotion_draft',
      description: 'Validate a disabled Stage fixture draft. Does not persist, activate, check membership, or authorize a benefit. Live v1 remains audienceRestriction:null; never submit this fixture as a live restriction.',
      schema: previewSchema, readOnly: true, serviceValidated: true,
      argumentError: () => ({
        schema: SCHEMA, mode: 'fixture', ok: false, persisted: false, financialAuthorization: false,
        error: { code: 'INVALID_DRAFT', message: 'Fixture draft exceeds argument bounds.' },
      }),
      run(_store, args, context) {
        const result = previewAudienceDraft(args);
        if (!result.ok) context.logger.error('mcp.authoring.rejected', { code: result.error.code, correlationId: context.correlationId });
        return result;
      },
    },
  ];
}

module.exports = { SCHEMA, previewSchema, authoringCatalogue, previewAudienceDraft, authoringTools };
