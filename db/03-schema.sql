-- LedgerDashboard schema. Idempotent: creates whatever is missing. It has no
-- USE statement, so it runs against whichever database it is pointed at:
--   sqlcmd -S . -E -b -d LedgerDashboard -i 03-schema.sql
--
-- Text columns are NOT NULL DEFAULT N'' (the API has always used "" for an
-- empty field, as the CSV did); only real dates and the score are nullable.

-- sqlcmd runs with QUOTED_IDENTIFIER OFF by default; the filtered unique
-- index on Recruiters needs these ON.
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO

-- Pipeline stages, terminal states and actions (was pipeline_stages.yml).
IF OBJECT_ID(N'dbo.Stages', N'U') IS NULL
CREATE TABLE dbo.Stages (
    StageKey   NVARCHAR(40)  NOT NULL CONSTRAINT PK_Stages PRIMARY KEY,
    Kind       NVARCHAR(10)  NOT NULL CONSTRAINT CK_Stages_Kind CHECK (Kind IN (N'stage', N'terminal', N'action')),
    SortOrder  INT           NOT NULL,
    Label      NVARCHAR(100) NOT NULL,
    LabelFa    NVARCHAR(200) NOT NULL CONSTRAINT DF_Stages_LabelFa DEFAULT (N''),
    Icon       NVARCHAR(16)  NOT NULL CONSTRAINT DF_Stages_Icon DEFAULT (N''),
    IsWaiting  BIT           NOT NULL CONSTRAINT DF_Stages_IsWaiting DEFAULT (0)
);
GO

-- One row per application (was ledger.csv).
IF OBJECT_ID(N'dbo.Applications', N'U') IS NULL
CREATE TABLE dbo.Applications (
    Id            INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Applications PRIMARY KEY,
    -- The folder under JobSearch/engine/applications, and the id in the API.
    -- Same rule the server enforces: letters, digits, dot, underscore, dash.
    -- (The dash goes first inside [...]: at the end T-SQL reads it as a range.)
    Folder        NVARCHAR(150) NOT NULL CONSTRAINT UQ_Applications_Folder UNIQUE
                  CONSTRAINT CK_Applications_Folder CHECK (
                      Folder <> N'' AND Folder NOT LIKE N'%..%'
                      AND Folder COLLATE Latin1_General_BIN NOT LIKE N'%[^-A-Za-z0-9._]%'),
    AppliedDate   DATE           NOT NULL,
    Company       NVARCHAR(200)  NOT NULL,
    Role          NVARCHAR(300)  NOT NULL,
    Branch        NVARCHAR(100)  NOT NULL CONSTRAINT DF_Applications_Branch DEFAULT (N''),
    Source        NVARCHAR(50)   NOT NULL CONSTRAINT DF_Applications_Source DEFAULT (N''),
    SourceDetail  NVARCHAR(500)  NOT NULL CONSTRAINT DF_Applications_SourceDetail DEFAULT (N''),
    PosterType    NVARCHAR(50)   NOT NULL CONSTRAINT DF_Applications_PosterType DEFAULT (N''),
    PosterName    NVARCHAR(200)  NOT NULL CONSTRAINT DF_Applications_PosterName DEFAULT (N''),
    EndClient     NVARCHAR(200)  NOT NULL CONSTRAINT DF_Applications_EndClient DEFAULT (N''),
    AppliedVia    NVARCHAR(100)  NOT NULL CONSTRAINT DF_Applications_AppliedVia DEFAULT (N''),
    PostingUrl    NVARCHAR(1000) NOT NULL CONSTRAINT DF_Applications_PostingUrl DEFAULT (N''),
    DatePosted    DATE           NULL,
    DateSeen      DATE           NULL,
    Location      NVARCHAR(200)  NOT NULL CONSTRAINT DF_Applications_Location DEFAULT (N''),
    MatchScore    TINYINT        NULL CONSTRAINT CK_Applications_MatchScore CHECK (MatchScore BETWEEN 0 AND 100),
    Variant       NVARCHAR(40)   NOT NULL CONSTRAINT DF_Applications_Variant DEFAULT (N''),
    Status        NVARCHAR(40)   NOT NULL CONSTRAINT DF_Applications_Status DEFAULT (N'draft'),
    -- Free text in the UI (not always a date), so kept as text.
    LastContact   NVARCHAR(200)  NOT NULL CONSTRAINT DF_Applications_LastContact DEFAULT (N''),
    NextAction    NVARCHAR(1000) NOT NULL CONSTRAINT DF_Applications_NextAction DEFAULT (N''),
    Outcome       NVARCHAR(200)  NOT NULL CONSTRAINT DF_Applications_Outcome DEFAULT (N''),
    Notes         NVARCHAR(MAX)  NOT NULL CONSTRAINT DF_Applications_Notes DEFAULT (N''),
    CreatedAt     DATETIME2(0)   NOT NULL CONSTRAINT DF_Applications_CreatedAt DEFAULT (SYSUTCDATETIME())
);
GO

-- Gap tags per application, in display order (was the comma-joined gap_tags
-- column). The CHECK only admits short kebab-case slugs, so a free-text
-- sentence can never be stored as a "tag" again, which is the bug that once
-- shredded 11 ledger rows into comma fragments. The slug dictionary itself
-- stays in JobSearch/engine/gap_tags.yml (hand-curated, part of the fact
-- bank workflow), so there is deliberately no foreign key to it.
IF OBJECT_ID(N'dbo.ApplicationGapTags', N'U') IS NULL
CREATE TABLE dbo.ApplicationGapTags (
    ApplicationId INT          NOT NULL CONSTRAINT FK_ApplicationGapTags_Applications
                  REFERENCES dbo.Applications (Id) ON DELETE CASCADE,
    Slug          NVARCHAR(60) NOT NULL CONSTRAINT CK_ApplicationGapTags_Slug CHECK (
                      Slug <> N'' AND Slug COLLATE Latin1_General_BIN NOT LIKE N'%[^-a-z0-9]%'
                      AND Slug NOT LIKE N'-%' AND Slug NOT LIKE N'%-'),
    Position      TINYINT      NOT NULL,
    CONSTRAINT PK_ApplicationGapTags PRIMARY KEY (ApplicationId, Slug),
    CONSTRAINT UQ_ApplicationGapTags_Position UNIQUE (ApplicationId, Position)
);
GO

-- Append-only stage events (was pipeline.csv). The latest stage-changing
-- event is the current stage; insertion order (Id) decides, exactly like
-- "last line wins" in the CSV. Events are deleted with their application.
IF OBJECT_ID(N'dbo.PipelineEvents', N'U') IS NULL
CREATE TABLE dbo.PipelineEvents (
    Id            BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_PipelineEvents PRIMARY KEY,
    ApplicationId INT            NOT NULL CONSTRAINT FK_PipelineEvents_Applications
                  REFERENCES dbo.Applications (Id) ON DELETE CASCADE,
    StageKey      NVARCHAR(40)   NOT NULL CONSTRAINT FK_PipelineEvents_Stages REFERENCES dbo.Stages (StageKey),
    EventDate     DATE           NOT NULL,
    -- Set when a time was recorded ("2026-09-25T14:30"), e.g. a booked interview.
    EventTime     TIME(0)        NULL,
    Note          NVARCHAR(1000) NOT NULL CONSTRAINT DF_PipelineEvents_Note DEFAULT (N''),
    CreatedAt     DATETIME2(0)   NOT NULL CONSTRAINT DF_PipelineEvents_CreatedAt DEFAULT (SYSUTCDATETIME())
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PipelineEvents_ApplicationId')
    CREATE INDEX IX_PipelineEvents_ApplicationId ON dbo.PipelineEvents (ApplicationId, Id);
GO

-- LinkedIn outreach list (was target_list.csv).
IF OBJECT_ID(N'dbo.Recruiters', N'U') IS NULL
CREATE TABLE dbo.Recruiters (
    Id                INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Recruiters PRIMARY KEY,
    Name              NVARCHAR(200)  NOT NULL,
    Title             NVARCHAR(200)  NOT NULL CONSTRAINT DF_Recruiters_Title DEFAULT (N''),
    Company           NVARCHAR(200)  NOT NULL CONSTRAINT DF_Recruiters_Company DEFAULT (N''),
    LinkedInUrl       NVARCHAR(400)  NOT NULL CONSTRAINT DF_Recruiters_LinkedInUrl DEFAULT (N''),
    Source            NVARCHAR(50)   NOT NULL CONSTRAINT DF_Recruiters_Source DEFAULT (N''),
    DateAdded         DATE           NULL,
    ConnectNote       NVARCHAR(1000) NOT NULL CONSTRAINT DF_Recruiters_ConnectNote DEFAULT (N''),
    ConnectSentOn     DATE           NULL,
    ConnectAcceptedOn DATE           NULL,
    FollowupNote      NVARCHAR(1000) NOT NULL CONSTRAINT DF_Recruiters_FollowupNote DEFAULT (N''),
    FollowupSentOn    DATE           NULL,
    RepliedOn         DATE           NULL,
    Notes             NVARCHAR(1000) NOT NULL CONSTRAINT DF_Recruiters_Notes DEFAULT (N'')
);
GO
-- One row per LinkedIn profile; rows without a URL are not constrained.
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'UX_Recruiters_LinkedInUrl')
    CREATE UNIQUE INDEX UX_Recruiters_LinkedInUrl ON dbo.Recruiters (LinkedInUrl) WHERE LinkedInUrl <> N'';
GO
