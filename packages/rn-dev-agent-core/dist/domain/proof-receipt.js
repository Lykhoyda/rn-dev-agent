import { z } from 'zod';
const gitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const kebabIdSchema = z.string().regex(/^[a-z0-9-]+$/);
const stableReasonCodeSchema = z.string().regex(/^[A-Z0-9_]+$/);
export const proofClassSchema = z.enum(['feature', 'tooling', 'regression']);
export const proofStageSchema = z.enum([
    'idle',
    'rehearsing',
    'rehearsed',
    'armed',
    'recording',
    'validating',
    'mechanically_accepted',
    'accepted',
    'rejected',
]);
export const storyboardStepSchema = z
    .object({
    id: kebabIdSchema,
    criterion: z.string().min(1),
    expectedTool: z.string().min(1),
    assertionTool: z.string().min(1),
    expectedArgsSha256: sha256Schema,
    assertionArgsSha256: sha256Schema,
    verifyTestID: z.string().min(1),
    screenshotPath: z.string().min(1),
    assertionWaitMs: z.number().int().min(0).max(10_000),
    expectedDwellMs: z.number().int().nonnegative(),
    maximumDwellMs: z.number().int().positive(),
})
    .strict();
export const storyboardSchema = z
    .object({
    schemaVersion: z.literal(1),
    id: z.string().min(1),
    proofClass: proofClassSchema,
    actionId: z.string().min(1),
    sourceTreeSha: gitShaSchema,
    allowedTools: z.array(z.string().min(1)).min(1),
    steps: z.array(storyboardStepSchema).min(3),
})
    .strict();
export const proofEventSchema = z
    .object({
    tool: z.string(),
    ok: z.boolean(),
    ts: z.number().int(),
    durationMs: z.number().nonnegative(),
    argsHash: z.string().optional(),
})
    .strict();
export const proofIssueSchema = z
    .object({
    repository: z.string().min(1),
    number: z.number().int().positive(),
})
    .strict();
export const proofPullRequestSchema = z
    .object({
    number: z.number().int().positive(),
    headSha: gitShaSchema,
})
    .strict();
export const acceptanceMappingSchema = z
    .object({
    criterion: z.string().min(1),
    storyboardStepIds: z.array(kebabIdSchema).min(1),
})
    .strict();
export const proofGitSchema = z
    .object({
    sourceTreeSha: gitShaSchema,
    proofHeadSha: gitShaSchema,
    dirty: z.boolean(),
})
    .strict();
export const proofDeviceSchema = z
    .object({
    id: z.string().min(1),
    platform: z.enum(['ios', 'android']),
    model: z.string().min(1),
    osVersion: z.string().min(1),
})
    .strict();
export const proofRuntimeSchema = z
    .object({
    bundleId: z.string().min(1),
    metroPort: z.number().int().positive().max(65_535),
    metroReady: z.boolean(),
    pluginVersion: z.string().min(1),
})
    .strict();
export const proofFixtureSchema = z
    .object({
    name: z.string().min(1),
    version: z.string().min(1),
})
    .strict();
export const proofActionSchema = z
    .object({
    id: z.string().min(1),
    version: z.string().min(1),
    sha256: sha256Schema,
})
    .strict();
export const proofStoryboardIdentitySchema = z
    .object({
    id: z.string().min(1),
    sha256: sha256Schema,
})
    .strict();
export const proofRehearsalSchema = z
    .object({
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    durationMs: z.number().nonnegative(),
    clean: z.boolean(),
})
    .strict();
export const proofVideoSchema = z
    .object({
    path: z.string().min(1),
    sha256: sha256Schema,
    durationMs: z.number().nonnegative(),
    sizeBytes: z.number().int().positive(),
    codec: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
})
    .strict();
export const proofScreenshotSchema = z
    .object({
    stepId: kebabIdSchema,
    path: z.string().min(1),
    timestampMs: z.number().nonnegative(),
    sha256: sha256Schema,
})
    .strict();
export const proofAssertionSchema = z
    .object({
    stepId: kebabIdSchema,
    tool: z.string().min(1),
    ok: z.boolean(),
    resultHash: sha256Schema,
})
    .strict();
export const acceptedProofAssertionSchema = proofAssertionSchema
    .extend({ ok: z.literal(true) })
    .strict();
export const proofEventTraceSchema = z
    .object({
    allowedTools: z.array(z.string().min(1)).min(1),
    observed: z.array(proofEventSchema),
})
    .strict();
export const proofFrameMatchSchema = z
    .object({
    stepId: kebabIdSchema,
    screenshotSha256: sha256Schema,
    videoTimestampMs: z.number().nonnegative(),
    score: z.number().min(0).max(1),
})
    .strict();
export const proofContactSheetSchema = z
    .object({
    path: z.string().min(1),
    sha256: sha256Schema,
})
    .strict();
export const proofErrorBaselineSchema = z
    .object({
    beforeSha256: sha256Schema,
    afterSha256: sha256Schema,
    beforeCount: z.number().int().nonnegative(),
    afterCount: z.number().int().nonnegative(),
    clean: z.boolean(),
})
    .strict();
export const evidenceReviewSchema = z
    .object({
    provider: z.string().min(1),
    writerProvider: z.string().min(1),
    independent: z.literal(true),
    exactFeature: z.literal(true),
    irrelevantScreens: z.literal(false),
    debuggingFriction: z.literal(false),
    personalData: z.literal(false),
    evidenceSha256: sha256Schema,
    resultHash: sha256Schema,
})
    .strict();
const sharedReceiptShape = {
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    issue: proofIssueSchema,
    pullRequest: proofPullRequestSchema,
    proofClass: proofClassSchema,
    acceptanceMappings: z.array(acceptanceMappingSchema).min(1),
    git: proofGitSchema,
    device: proofDeviceSchema,
    runtime: proofRuntimeSchema,
    fixture: proofFixtureSchema,
    action: proofActionSchema,
    storyboard: proofStoryboardIdentitySchema,
};
const acceptedEvidenceShape = {
    ...sharedReceiptShape,
    rehearsal: proofRehearsalSchema.extend({ clean: z.literal(true) }).strict(),
    video: proofVideoSchema,
    screenshots: z.array(proofScreenshotSchema).min(3),
    assertions: z.array(acceptedProofAssertionSchema).min(3),
    eventTrace: proofEventTraceSchema,
    frameMatches: z.array(proofFrameMatchSchema).min(3),
    contactSheet: proofContactSheetSchema,
    errorBaseline: proofErrorBaselineSchema.extend({ clean: z.literal(true) }).strict(),
    invalidationReasons: z.array(stableReasonCodeSchema).length(0),
};
export const mechanicallyAcceptedProofReceiptSchema = z
    .object({
    ...acceptedEvidenceShape,
    verdict: z.literal('mechanically_accepted'),
})
    .strict();
export const rejectedProofReceiptSchema = z
    .object({
    ...sharedReceiptShape,
    rehearsal: proofRehearsalSchema,
    video: proofVideoSchema.nullable(),
    screenshots: z.array(proofScreenshotSchema),
    assertions: z.array(proofAssertionSchema),
    eventTrace: proofEventTraceSchema,
    frameMatches: z.array(proofFrameMatchSchema),
    contactSheet: proofContactSheetSchema.nullable(),
    errorBaseline: proofErrorBaselineSchema,
    invalidationReasons: z.array(stableReasonCodeSchema).min(1),
    verdict: z.literal('rejected'),
})
    .strict();
export const mechanicalProofReceiptSchema = z.discriminatedUnion('verdict', [
    mechanicallyAcceptedProofReceiptSchema,
    rejectedProofReceiptSchema,
]);
export const finalProofReceiptSchema = z
    .object({
    ...acceptedEvidenceShape,
    evidenceReview: evidenceReviewSchema,
    verdict: z.literal('accepted'),
})
    .strict();
