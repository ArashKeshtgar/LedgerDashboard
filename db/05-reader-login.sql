-- Read-only login for systems that report on the ledger (Control Panel's
-- ledgerdash-adapter). It can SELECT the reporting views in 04-views.sql
-- and nothing else: no table access, no writes. Safe to re-run (it also
-- resets the password). The password is never stored in this file:
--   sqlcmd -S . -E -b -i 05-reader-login.sql -v READER_PASSWORD="..."
USE master;
GO
IF SUSER_ID(N'ledger_reader') IS NULL
    CREATE LOGIN ledger_reader WITH PASSWORD = N'$(READER_PASSWORD)', CHECK_POLICY = ON;
ELSE
    ALTER LOGIN ledger_reader WITH PASSWORD = N'$(READER_PASSWORD)';
GO

USE LedgerDashboard;
GO
IF USER_ID(N'ledger_reader') IS NULL CREATE USER ledger_reader FOR LOGIN ledger_reader;
-- The views are owned by dbo like the tables they read, so ownership
-- chaining lets them work without granting anything on the tables.
GRANT SELECT ON dbo.vApplicationCurrentStage TO ledger_reader;
GRANT SELECT ON dbo.vFollowupsDue TO ledger_reader;
GRANT SELECT ON dbo.vFunnelBySource TO ledger_reader;
GRANT SELECT ON dbo.vGapTagStats TO ledger_reader;
GO
