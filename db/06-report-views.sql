-- Reporting layer in its own schema, rpt. Safe to re-run:
--   sqlcmd -S . -E -b -d LedgerDashboard -i 06-report-views.sql
--
-- Two kinds of views:
--   * Model tables for Power BI (reports/LedgerDashboard.pbip): one row per
--     application with every attribute a report slices by, plus events,
--     gap tags and recruiters. Measures live in the Power BI model.
--   * Ready-made summaries for plain SQL / the Control Panel assistant.
--
-- No personal data beyond what the dashboard already shows about the
-- employer: contact emails and recruiter names/LinkedIn URLs stay out.
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
IF SCHEMA_ID(N'rpt') IS NULL EXEC (N'CREATE SCHEMA rpt AUTHORIZATION dbo');
GO

-- ---------------------------------------------------------------- model --

-- One row per application. "Sent" = has an applied event; dates come from
-- the first event of each kind; weeks start on Monday whatever DATEFIRST is.
CREATE OR ALTER VIEW rpt.ApplicationFacts AS
WITH Ev AS (
    SELECT e.ApplicationId,
           MIN(CASE WHEN e.StageKey = N'applied' THEN e.EventDate END) AS SentDate,
           MIN(CASE WHEN e.StageKey = N'rejected' THEN e.EventDate END) AS RejectedDate,
           MIN(CASE WHEN e.StageKey IN (N'recruiter_screen', N'technical_interview', N'final_round', N'offer', N'contract_signed')
                    THEN e.EventDate END) AS FirstResponseDate,
           SUM(CASE WHEN e.StageKey = N'follow_up' THEN 1 ELSE 0 END) AS FollowupCount
    FROM dbo.PipelineEvents e
    GROUP BY e.ApplicationId
)
SELECT c.ApplicationId,
       c.Folder,
       c.Company,
       c.Role,
       COALESCE(LOWER(NULLIF(a.Source, N'')), N'unknown') AS Source,
       COALESCE(NULLIF(a.PosterType, N''), N'unknown') AS PosterType,
       COALESCE(NULLIF(a.AppliedVia, N''), N'unknown') AS AppliedVia,
       COALESCE(NULLIF(a.Variant, N''), N'unknown') AS Variant,
       a.MatchScore,
       CASE WHEN a.MatchScore IS NULL THEN N'unscored'
            WHEN a.MatchScore < 50 THEN N'< 50'
            WHEN a.MatchScore < 60 THEN N'50-59'
            WHEN a.MatchScore < 70 THEN N'60-69'
            ELSE N'70+' END AS ScoreBucket,
       CASE WHEN a.MatchScore IS NULL THEN 0
            WHEN a.MatchScore < 50 THEN 1
            WHEN a.MatchScore < 60 THEN 2
            WHEN a.MatchScore < 70 THEN 3
            ELSE 4 END AS ScoreBucketOrder,
       c.CurrentStage,
       CASE WHEN c.CurrentStage = N'draft' THEN N'Draft'
            WHEN c.CurrentStage = N'applied' THEN N'Awaiting reply'
            WHEN c.CurrentStage IN (N'recruiter_screen', N'technical_interview', N'final_round') THEN N'Interviewing'
            WHEN c.CurrentStage IN (N'offer', N'contract_signed') THEN N'Offer'
            WHEN c.CurrentStage = N'rejected' THEN N'Rejected'
            WHEN c.CurrentStage = N'no_response' THEN N'No response'
            ELSE c.CurrentStage END AS Outcome,
       CAST(CASE WHEN ev.SentDate IS NOT NULL OR c.CurrentStage <> N'draft' THEN 1 ELSE 0 END AS bit) AS IsSent,
       CAST(CASE WHEN c.CurrentStage = N'rejected' THEN 1 ELSE 0 END AS bit) AS IsRejected,
       CAST(CASE WHEN ev.FirstResponseDate IS NOT NULL THEN 1 ELSE 0 END AS bit) AS GotInterview,
       a.AppliedDate AS CreatedDate,
       ev.SentDate,
       DATEADD(day, -((DATEPART(weekday, ev.SentDate) + @@DATEFIRST - 2) % 7), ev.SentDate) AS SentWeek,
       ev.RejectedDate,
       DATEDIFF(day, ev.SentDate, ev.RejectedDate) AS DaysToReject,
       ISNULL(ev.FollowupCount, 0) AS FollowupCount,
       CAST(CASE WHEN ev.FollowupCount > 0 THEN 1 ELSE 0 END AS bit) AS HasFollowup,
       c.HasContactEmail,
       COALESCE(NULLIF(a.ContactSource, N''), N'none') AS ContactSource,
       CAST(CASE WHEN f.Folder IS NOT NULL THEN 1 ELSE 0 END AS bit) AS NeedsFollowup,
       f.DaysSinceAction
FROM dbo.vApplicationCurrentStage c
JOIN dbo.Applications a ON a.Id = c.ApplicationId
LEFT JOIN Ev ev ON ev.ApplicationId = c.ApplicationId
LEFT JOIN dbo.vFollowupsDue f ON f.Folder = c.Folder;
GO

CREATE OR ALTER VIEW rpt.PipelineEvents AS
SELECT e.Id AS EventId, e.ApplicationId, e.StageKey, s.Label AS StageLabel, s.Kind AS StageKind,
       e.EventDate,
       DATEADD(day, -((DATEPART(weekday, e.EventDate) + @@DATEFIRST - 2) % 7), e.EventDate) AS EventWeek,
       e.Note
FROM dbo.PipelineEvents e
JOIN dbo.Stages s ON s.StageKey = e.StageKey;
GO

CREATE OR ALTER VIEW rpt.GapTags AS
SELECT t.ApplicationId, t.Slug, t.Position
FROM dbo.ApplicationGapTags t;
GO

-- Outreach funnel without people's names or profile URLs.
CREATE OR ALTER VIEW rpt.Recruiters AS
SELECT r.Id AS RecruiterId, r.Company, r.Title, r.Source, r.DateAdded,
       r.ConnectSentOn, r.ConnectAcceptedOn, r.FollowupSentOn, r.RepliedOn,
       CASE WHEN r.RepliedOn IS NOT NULL THEN N'Replied'
            WHEN r.FollowupSentOn IS NOT NULL THEN N'Follow-up sent'
            WHEN r.ConnectAcceptedOn IS NOT NULL THEN N'Connected'
            WHEN r.ConnectSentOn IS NOT NULL THEN N'Request sent'
            ELSE N'Added' END AS Stage
FROM dbo.Recruiters r;
GO

-- ------------------------------------------------------------ summaries --

-- Does the match score predict the outcome?
CREATE OR ALTER VIEW rpt.ScoreBucketOutcome AS
SELECT ScoreBucket, ScoreBucketOrder,
       COUNT(*) AS Sent,
       SUM(CASE WHEN IsRejected = 1 THEN 1 ELSE 0 END) AS Rejected,
       SUM(CASE WHEN GotInterview = 1 THEN 1 ELSE 0 END) AS Interviews,
       CAST(100.0 * SUM(CASE WHEN IsRejected = 1 THEN 1 ELSE 0 END) / COUNT(*) AS decimal(5, 1)) AS RejectedPct
FROM rpt.ApplicationFacts
WHERE IsSent = 1
GROUP BY ScoreBucket, ScoreBucketOrder;
GO

-- How long rejections take (most arrive within two weeks).
CREATE OR ALTER VIEW rpt.TimeToRejection AS
SELECT Company, Role, SentDate, RejectedDate, DaysToReject, MatchScore
FROM rpt.ApplicationFacts
WHERE DaysToReject IS NOT NULL;
GO

-- Outcome by any channel attribute, one row per (dimension, value).
CREATE OR ALTER VIEW rpt.OutcomeByChannel AS
SELECT d.Dimension, d.Value,
       COUNT(*) AS Sent,
       SUM(CASE WHEN f.IsRejected = 1 THEN 1 ELSE 0 END) AS Rejected,
       SUM(CASE WHEN f.GotInterview = 1 THEN 1 ELSE 0 END) AS Interviews,
       CAST(AVG(CAST(f.MatchScore AS decimal(5, 1))) AS decimal(5, 1)) AS AvgMatchScore
FROM rpt.ApplicationFacts f
CROSS APPLY (VALUES (N'Source', f.Source), (N'PosterType', f.PosterType),
                    (N'AppliedVia', f.AppliedVia), (N'Variant', f.Variant)) d (Dimension, Value)
WHERE f.IsSent = 1
GROUP BY d.Dimension, d.Value;
GO

-- Activity per week (Monday start): sent, rejections, follow-ups, new drafts.
CREATE OR ALTER VIEW rpt.WeeklyActivity AS
SELECT EventWeek AS WeekStart,
       SUM(CASE WHEN StageKey = N'applied' THEN 1 ELSE 0 END) AS Sent,
       SUM(CASE WHEN StageKey = N'rejected' THEN 1 ELSE 0 END) AS Rejections,
       SUM(CASE WHEN StageKey = N'follow_up' THEN 1 ELSE 0 END) AS Followups,
       SUM(CASE WHEN StageKey = N'draft' THEN 1 ELSE 0 END) AS DraftsCreated
FROM rpt.PipelineEvents
GROUP BY EventWeek;
GO

-- Did a follow-up change anything? (Needs more data to mean much.)
CREATE OR ALTER VIEW rpt.FollowupEffect AS
SELECT CASE WHEN HasFollowup = 1 THEN N'Followed up' ELSE N'No follow-up' END AS FollowedUp,
       COUNT(*) AS Sent,
       SUM(CASE WHEN GotInterview = 1 THEN 1 ELSE 0 END) AS Interviews,
       SUM(CASE WHEN IsRejected = 1 THEN 1 ELSE 0 END) AS Rejected,
       SUM(CASE WHEN Outcome = N'Awaiting reply' THEN 1 ELSE 0 END) AS StillWaiting
FROM rpt.ApplicationFacts
WHERE IsSent = 1
GROUP BY CASE WHEN HasFollowup = 1 THEN N'Followed up' ELSE N'No follow-up' END;
GO

-- Gap tags per week the posting was saved: which gaps are new, which faded.
CREATE OR ALTER VIEW rpt.GapTagTrend AS
SELECT DATEADD(day, -((DATEPART(weekday, f.CreatedDate) + @@DATEFIRST - 2) % 7), f.CreatedDate) AS WeekStart,
       t.Slug,
       COUNT(*) AS Postings
FROM rpt.GapTags t
JOIN rpt.ApplicationFacts f ON f.ApplicationId = t.ApplicationId
GROUP BY DATEADD(day, -((DATEPART(weekday, f.CreatedDate) + @@DATEFIRST - 2) % 7), f.CreatedDate), t.Slug;
GO

-- What's missing from the records, so the reports above can be trusted.
CREATE OR ALTER VIEW rpt.DataQuality AS
SELECT COUNT(*) AS Applications,
       SUM(CASE WHEN HasContactEmail = 0 AND IsSent = 1 THEN 1 ELSE 0 END) AS SentWithoutContact,
       SUM(CASE WHEN PosterType = N'unknown' THEN 1 ELSE 0 END) AS MissingPosterType,
       SUM(CASE WHEN AppliedVia = N'unknown' THEN 1 ELSE 0 END) AS MissingAppliedVia,
       SUM(CASE WHEN MatchScore IS NULL THEN 1 ELSE 0 END) AS Unscored,
       SUM(CASE WHEN IsSent = 1 AND SentDate IS NULL THEN 1 ELSE 0 END) AS SentWithoutAppliedEvent
FROM rpt.ApplicationFacts;
GO

-- The read-only reporting login (05-reader-login.sql) gets the whole schema.
IF USER_ID(N'ledger_reader') IS NOT NULL GRANT SELECT ON SCHEMA::rpt TO ledger_reader;
GO
