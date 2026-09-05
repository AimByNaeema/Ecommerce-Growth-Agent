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
  'auditTrail.test.js',
  'analyticsModel.test.js',
  'analyticsInsightWorkflow.test.js',
  'claudeClient.test.js',
  'geminiClient.test.js',
  'aiProviderSelector.test.js',
  'shopifyClient.test.js',
  'platformAdapterContract.test.js',
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
  'onPageOptimizationModel.test.js',
  'seoAgentResultModel.test.js',
  'seoAgent.test.js',
  'keywordResearchTool.test.js',
  'seoAnalysisTool.test.js',
  'seoQualityCheckModel.test.js',
  'seoQualityChecker.test.js',
  'listingContentModel.test.js',
  'marketplaceListingFormatModel.test.js',
  'listingAgentResultModel.test.js',
  'listingAgent.test.js',
  'listingContentTool.test.js',
  'listingQualityCheckModel.test.js',
  'listingQualityChecker.test.js',
  'marketingAgentResultModel.test.js',
  'campaignPlanModel.test.js',
  'marketingAgent.test.js',
  'marketingAnalysisTool.test.js',
  'offerRecommendationModel.test.js',
  'offerRecommendationEngine.test.js',
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
  'salesGrowthPlanModel.test.js',
  'salesGrowthPlanner.test.js',
  'experimentModel.test.js',
  'experimentEngine.test.js',
  'experimentLessonModel.test.js',
  'experimentLearningStore.test.js',
  'serverAccessControl.test.js',
  'askOrchestrationRouting.test.js',
  'server.test.js',
  'orchestratorEndpoints.test.js',
  'workflowOrchestratorEndpoints.test.js',
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
