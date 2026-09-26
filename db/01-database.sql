-- Creates the LedgerDashboard database. Safe to re-run.
--   sqlcmd -S . -E -b -i 01-database.sql
IF DB_ID(N'LedgerDashboard') IS NULL CREATE DATABASE LedgerDashboard;
GO
