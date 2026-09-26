-- Dedicated SQL-auth login the dashboard server connects as. Safe to re-run
-- (it also resets the password). The password is never stored in this file:
--   sqlcmd -S . -E -b -i 02-service-login.sql -v DB_PASSWORD="..."
--
-- Least privilege: read/write data only. No db_owner, no DDL; schema
-- changes go through these scripts, run by an administrator.
USE master;
GO
IF SUSER_ID(N'ledger_svc') IS NULL
    CREATE LOGIN ledger_svc WITH PASSWORD = N'$(DB_PASSWORD)', CHECK_POLICY = ON;
ELSE
    ALTER LOGIN ledger_svc WITH PASSWORD = N'$(DB_PASSWORD)';
GO

USE LedgerDashboard;
GO
IF USER_ID(N'ledger_svc') IS NULL CREATE USER ledger_svc FOR LOGIN ledger_svc;
ALTER ROLE db_datareader ADD MEMBER ledger_svc;
ALTER ROLE db_datawriter ADD MEMBER ledger_svc;
GO
