-- Reporting views over the LedgerDashboard tables. Safe to re-run (CREATE OR
-- ALTER). No USE statement, like 03-schema.sql:
--   sqlcmd -S . -E -b -d LedgerDashboard -i 04-views.sql
--
-- These are the read side for other systems (Control Panel's
-- ledgerdash-adapter, reports) - they compute in SQL what the dashboard
-- computes in JavaScript (server/src/pipeline.js), so the numbers match.
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- One row per application with its CURRENT stage: the latest stage-changing
-- event (actions such as follow_up don't change the stage), falling back to
-- the ledger status when there are no events - same rule as attachPipeline().
CREATE OR ALTER VIEW dbo.vApplicationCurrentStage AS
WITH LastStage AS (
    SELECT e.ApplicationId, e.StageKey, e.EventDate,
           ROW_NUMBER() OVER (PARTITION BY e.ApplicationId ORDER BY e.Id DESC) AS rn
    FROM dbo.PipelineEvents e
    JOIN dbo.Stages s ON s.StageKey = e.StageKey
    WHERE s.Kind <> N'action'
)
SELECT a.Id AS ApplicationId,
       a.Folder, a.Company, a.Role, a.Source, a.MatchScore, a.AppliedDate,
       COALESCE(ls.StageKey, a.Status) AS CurrentStage,
       st.Kind AS StageKind,
       CAST(ISNULL(st.IsWaiting, 0) AS bit) AS IsWaiting,
       ls.EventDate AS StageSince,
       -- Latest follow-up logged since entering the current stage.
       (SELECT MAX(f.EventDate)
        FROM dbo.PipelineEvents f
        JOIN dbo.Stages fs ON fs.StageKey = f.StageKey
        WHERE f.ApplicationId = a.Id AND fs.Kind = N'action'
          AND (ls.EventDate IS NULL OR f.EventDate >= ls.EventDate)) AS LastFollowupDate
FROM dbo.Applications a
LEFT JOIN LastStage ls ON ls.ApplicationId = a.Id AND ls.rn = 1
LEFT JOIN dbo.Stages st ON st.StageKey = COALESCE(ls.StageKey, a.Status);
GO

-- Applications sitting in a "waiting on the employer" stage for more than
-- 7 days since the last action (entering the stage or the last follow-up),
-- the same threshold as FOLLOWUP_THRESHOLD_DAYS in the dashboard.
CREATE OR ALTER VIEW dbo.vFollowupsDue AS
SELECT c.Folder, c.Company, c.Role, c.CurrentStage,
       COALESCE(c.LastFollowupDate, c.StageSince) AS LastActionDate,
       DATEDIFF(day, COALESCE(c.LastFollowupDate, c.StageSince), CAST(SYSDATETIME() AS date)) AS DaysSinceAction
FROM dbo.vApplicationCurrentStage c
WHERE c.IsWaiting = 1
  AND c.StageSince IS NOT NULL
  AND DATEDIFF(day, COALESCE(c.LastFollowupDate, c.StageSince), CAST(SYSDATETIME() AS date)) > 7;
GO

-- Outcome by source, sent applications only (drafts are not applications
-- yet). Source is grouped case-insensitively ("LinkedIn" = "linkedin").
CREATE OR ALTER VIEW dbo.vFunnelBySource AS
SELECT LOWER(NULLIF(c.Source, N'')) AS Source,
       COUNT(*) AS Sent,
       SUM(CASE WHEN c.CurrentStage = N'applied' THEN 1 ELSE 0 END) AS AwaitingReply,
       SUM(CASE WHEN c.CurrentStage IN (N'recruiter_screen', N'technical_interview', N'final_round') THEN 1 ELSE 0 END) AS Interviewing,
       SUM(CASE WHEN c.CurrentStage IN (N'offer', N'contract_signed') THEN 1 ELSE 0 END) AS Offers,
       SUM(CASE WHEN c.CurrentStage = N'rejected' THEN 1 ELSE 0 END) AS Rejected,
       SUM(CASE WHEN c.CurrentStage = N'no_response' THEN 1 ELSE 0 END) AS NoResponse,
       CAST(AVG(CAST(c.MatchScore AS decimal(5, 1))) AS decimal(5, 1)) AS AvgMatchScore
FROM dbo.vApplicationCurrentStage c
WHERE c.CurrentStage <> N'draft'
GROUP BY LOWER(NULLIF(c.Source, N''));
GO

-- Gap tags across every scored posting (drafts included, as on the Stats
-- page): how often each gap appears, how often in a rejected application,
-- and the average match score of the postings that listed it.
CREATE OR ALTER VIEW dbo.vGapTagStats AS
SELECT t.Slug,
       COUNT(*) AS Postings,
       SUM(CASE WHEN c.CurrentStage = N'rejected' THEN 1 ELSE 0 END) AS RejectedPostings,
       CAST(AVG(CAST(c.MatchScore AS decimal(5, 1))) AS decimal(5, 1)) AS AvgMatchScore
FROM dbo.ApplicationGapTags t
JOIN dbo.vApplicationCurrentStage c ON c.ApplicationId = t.ApplicationId
GROUP BY t.Slug;
GO
