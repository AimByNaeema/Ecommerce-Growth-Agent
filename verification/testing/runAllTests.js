'use strict';

// Runs this project's whole test suite, in one fixed order, stopping at the first
// failing file - exactly the semantics package.json's "test" script had when it was a
// literal chain of 140 `node ... && node ...` commands.
//
// WHY THIS FILE EXISTS: that chain reached 8159 characters, and npm runs a script
// through cmd.exe on Windows, whose command line is capped at 8191. Adding one more
// test file pushed it over and cmd refused the whole command with "The command line is
// too long." - which looks exactly like a clean run (no failures printed) while in
// fact NOTHING executed. Keeping the list here instead removes that cliff permanently
// and makes a silent non-run impossible.
//
// The order below is the chain's original order, preserved verbatim - it is not
// alphabetical and not directory-scanned, so a file must be added here deliberately,
// the same way it previously had to be added to the chain. TEST_FILES is exported so
// a test can assert every *.test.js on disk is actually registered.

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TEST_FILES = [
  'configValidator.test.js',
  'businessConfigSample.test.js',
  'agentContract.test.js',
  'contextBoundaries.test.js',
  'stateModel.test.js',
  'memoryRules.test.js',
  'researchRecordModel.test.js',
  'productModel.test.js',
  'productResearchArchitecture.test.js',
  'opportunityAnalysisModel.test.js',
  'marketConnectedOpportunityModel.test.js',
  'productOpportunityAnalysisWorkflow.test.js',
  'marketResearchModel.test.js',
  'customerSegmentResearchModel.test.js',
  'competitorResearchModel.test.js',
  'seoResearchModel.test.js',
  'keywordResearchWorkflow.test.js',
  'listingOptimizationModel.test.js',
  'marketingAnalysisModel.test.js',
  'contentMarketingWorkflow.test.js',
  'growthOpportunityModel.test.js',
  'toolRegistry.test.js',
  'toolSelectionRules.test.js',
  'approvalArchitecture.test.js',
  'approvalRequestModel.test.js',
  'approvalWorkflow.test.js',
  'approvalStore.test.js',
  'auditTrail.test.js',
  'analyticsModel.test.js',
  'analyticsInsightWorkflow.test.js',
  'claudeClient.test.js',
  'geminiClient.test.js',
  'aiProviderSelector.test.js',
  'shopifyClient.test.js',
  'platformAdapterContract.test.js',
  'adapterRegistry.test.js',
  // What this project genuinely supports per platform, and proof that Amazon and eBay are
  // refused at every layer rather than at one of them.
  'platformSupportBoundary.test.js',
  // The observation layer (monitoring/): snapshot model, store, change detection and the
  // capture pass. Placed here because it resolves adapters through the registry above it.
  'monitoringSnapshots.test.js',
  // The scheduling layer (scheduler/): job model, store and the pass that turns a due job
  // into a controlled execution request evaluated by the existing autonomy policy.
  'scheduler.test.js',
  // The reliability layer (reliability/): the circuit breaker and first-class verification,
  // including the idempotency guard that stops a consequential action being applied twice.
  'reliabilityControls.test.js',
  // The controlled autonomous cycle (autonomy/): the loop that wires scheduler, monitor,
  // policy, breaker, execution, verification and audit together without adding a second
  // orchestrator or a second policy.
  'autonomousCycle.test.js',
  // The consequential path end to end: a scheduled action reaching a durable approval, a
  // real Ed25519 decision, and the approved-correction dispatch that executes it once.
  'approvedCorrectionFlow.test.js',
  // The connected loop: owner schedules, change-driven follow-ups through the Chief, the
  // owner's decision on a durable autonomous approval, verification, memory, and the
  // one-cycle trigger - plus their HTTP surface.
  'scheduleManagement.test.js',
  'autonomousLoop.test.js',
  'autonomyApprovalResolution.test.js',
  'autonomyEndpoints.test.js',
  // The whole chain through the real orchestration path - real config, policy, adapter
  // registry, Chief plan step, compliance, approval and stores; only external boundaries stubbed.
  'autonomyEndToEndMatrix.test.js',
  // Multi-platform at the architecture level: no platform literal in core autonomy, observation
  // declared at the registration point, real per-platform truth, and a synthetic platform
  // onboarded through registration points alone.
  'platformGenerality.test.js',
  'autonomySecurityAdversarial.test.js',
  'autonomyLearningLoop.test.js',
  'autonomyCompletion.test.js',
  'orderModel.test.js',
  'networkRetry.test.js',
  'secretExposureAudit.test.js',
  'businessConfigurationRetrieval.test.js',
  'specialistRegistry.test.js',
  'toolPermissions.test.js',
  'specialistCapabilityModel.test.js',
  'specialistCapabilityRegistry.test.js',
  'tokenControls.test.js',
  'toolResultCache.test.js',
  'executionBounds.test.js',
  'usageLimits.test.js',
  'usageTracker.test.js',
  // The controlled autonomy policy (agent/core/autonomyPolicy.js) and the cross-run
  // budget read it depends on (agent/core/dailyUsageAccounting.js). Placed here because
  // it composes the budget modules directly above it.
  'autonomyPolicy.test.js',
  'aiReasoningCompletion.test.js',
  'aiReasoningProviderSelection.test.js',
  'executionState.test.js',
  'crossAgentContext.test.js',
  'orchestratorExecutionContract.test.js',
  'runHistoryStore.test.js',
  'memoryRecordModel.test.js',
  'memoryStore.test.js',
  'memoryContextRetrieval.test.js',
  'chiefToApprovalIntegration.test.js',
  'businessRegistry.test.js',
  'businessIsolation.test.js',
  'contentBriefEngine.test.js',
  'seoContentGenerationTool.test.js',
  'questionEvidenceModel.test.js',
  'questionDiscoveryEngine.test.js',
  'marketQuestionDiscoveryTool.test.js',
  'informationGapModel.test.js',
  'informationGapEngine.test.js',
  'informationGapAnalysis.test.js',
  'growthWorkflowOrchestrator.test.js',
  'optimizationCycleOrchestrator.test.js',
  'researchAgentResultModel.test.js',
  'researchAgent.test.js',
  'marketResearchTool.test.js',
  'researchAnalysisTool.test.js',
  'competitorResearchTool.test.js',
  'customerResearchTool.test.js',
  'globalMarketComparisonModel.test.js',
  'globalEcommerceMarketResearchWorkflow.test.js',
  'globalMarketOpportunityTool.test.js',
  'competitorIntelligenceModel.test.js',
  'competitorIntelligenceAgent.test.js',
  'productAgentResultModel.test.js',
  'productAgent.test.js',
  'marketProductOpportunityTool.test.js',
  'productDataRetrievalTool.test.js',
  'collectionDataRetrievalTool.test.js',
  'productOpportunityScoreModel.test.js',
  'productOpportunityScoringEngine.test.js',
  'productRecommendationModel.test.js',
  'productRecommendationEngine.test.js',
  'productResearchCapability.test.js',
  'onPageOptimizationModel.test.js',
  'seoAgentResultModel.test.js',
  'seoAgent.test.js',
  'keywordResearchTool.test.js',
  'seoAnalysisTool.test.js',
  'seoQualityCheckModel.test.js',
  'seoQualityChecker.test.js',
  // The wiring that makes seoQualityChecker.js reachable through Chief dispatch (the
  // checker's own dimension logic stays covered by the file above).
  'seoQualityCheckCapability.test.js',
  'listingContentModel.test.js',
  'marketplaceListingFormatModel.test.js',
  'listingAgentResultModel.test.js',
  'listingAgent.test.js',
  'listingContentTool.test.js',
  'listingQualityCheckModel.test.js',
  'listingQualityChecker.test.js',
  // The wiring that makes listingQualityChecker.js reachable through Chief dispatch
  // (the checker's own dimension logic stays covered by the file above).
  'listingQualityCheckCapability.test.js',
  'marketingAgentResultModel.test.js',
  'campaignPlanModel.test.js',
  'marketingAgent.test.js',
  'marketingAnalysisTool.test.js',
  'offerRecommendationModel.test.js',
  'offerRecommendationEngine.test.js',
  // The wiring that makes offerRecommendationEngine.js reachable through Chief routing
  // (the engine's own logic stays covered by the file above).
  'offerRecommendationCapability.test.js',
  'socialContentModel.test.js',
  'adCampaignModel.test.js',
  'socialAdvertisingAgentResultModel.test.js',
  'socialAdvertisingAgent.test.js',
  'socialContentTool.test.js',
  'paidAdvertisingTool.test.js',
  'socialMediaStrategyModel.test.js',
  'socialMediaStrategyTool.test.js',
  'platformContentModel.test.js',
  'platformContentTool.test.js',
  'contentCalendarModel.test.js',
  'contentCalendarTool.test.js',
  'contentCadencePolicy.test.js',
  'advertisingStrategyModel.test.js',
  'advertisingStrategyTool.test.js',
  'advertisingPerformanceModel.test.js',
  'advertisingPerformanceCalculator.test.js',
  'advertisingPerformanceTool.test.js',
  'analyticsAgentResultModel.test.js',
  'analyticsAgent.test.js',
  'analyticsTool.test.js',
  'analyticsMetricsCalculator.test.js',
  'analyticsDataTool.test.js',
  'insightModel.test.js',
  'insightEngine.test.js',
  'growthOpportunityEngineModel.test.js',
  'growthOpportunityEngine.test.js',
  'conversionOptimizationCheckModel.test.js',
  'conversionOptimizationChecker.test.js',
  'conversionOptimizationCapability.test.js',
  'salesGrowthPlanModel.test.js',
  'salesGrowthPlanner.test.js',
  'salesGrowthPlanIntegration.test.js',
  'experimentModel.test.js',
  'experimentEngine.test.js',
  'experimentLessonModel.test.js',
  'experimentLearningStore.test.js',
  'serverAccessControl.test.js',
  'askOrchestrationRouting.test.js',
  'server.test.js',
  'orchestratorEndpoints.test.js',
  'workflowOrchestratorEndpoints.test.js',
  // The dashboard Overview control-center's two new read-only endpoints
  // (GET /overview, GET /store/metrics) - see server.js's own header comments on
  // both routes.
  'dashboardOverviewEndpoint.test.js',
  // What survives a server restart for those same two surfaces (and what deliberately
  // does not) - see agent/core/runHistoryStore.js and server.js's saveWorkflowRunRecord.
  'workflowRunHistoryPersistence.test.js',
  'serverResearchParams.test.js',
  'resultSummary.test.js',
  'webCompetitorResearchTool.test.js',
  'compliancePolicy.test.js',
  'complianceModel.test.js',
  'complianceEngine.test.js',
  'complianceCheckTool.test.js',
  'complianceApprovalGate.test.js',
  'publishAuthorization.test.js',
  'etsyPublishing.test.js',
  'shopifyBlogPublishing.test.js',
  'shopifyClientWriteMutations.test.js',
  'shopifyVendorCorrection.test.js',
  'shopifyInventoryCorrection.test.js',
  'shopifyCollectionMembership.test.js',
  // The read-only Etsy phase. Every one of these mocks global.fetch - none reaches Etsy.
  'etsyOAuth.test.js',
  'etsyReadClient.test.js',
  'etsyChannelIsolation.test.js',
  'etsyPolicyRules.test.js',
  'etsyIpRiskDetector.test.js',
  'etsyComplianceInput.test.js',
  'etsyShopDataTool.test.js',
  'etsyListingDataTool.test.js',
  'etsySecretRedaction.test.js',
  'etsyReadOnlyEnforcement.test.js',
  'etsyDashboardIntegration.test.js',
  'customerMarketOpportunity.test.js',
  'commandCenterSession.test.js',
  'catalogueExpansionRouting.test.js',
  'marketOpportunityDashboard.test.js',
  'opportunityPreparationWorkflow.test.js',
  'geminiWebGrounding.test.js',
  'tavilySearchProvider.test.js',
  'workflowDocumentation.test.js',
  // Production-readiness accuracy: every claim the registries make - about files, about
  // executability, about platforms, about configuration - checked against reality.
  'registryAccuracy.test.js',
  'mutationIntentRouting.test.js',
  'readOnlyRoutingCoverage.test.js',
  'approvalPersistenceIntegration.test.js',
  'complianceInputIntegration.test.js',
  'approvalIdUniqueness.test.js',
];

function runAll() {
  for (const file of TEST_FILES) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    if (result.error) {
      console.error(`Could not start ${file}: ${result.error.message}`);
      return 1;
    }
    // Stop at the first failure, exactly like the && chain did - a later file's
    // output must never scroll a real failure out of view.
    if (result.status !== 0) {
      console.error(`
FAILED: ${file} (exit code ${result.status})`);
      return result.status;
    }
  }
  console.log(`
All ${TEST_FILES.length} test files passed.`);
  return 0;
}

module.exports = { TEST_FILES, runAll };

if (require.main === module) {
  process.exitCode = runAll();
}
